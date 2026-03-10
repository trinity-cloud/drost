from __future__ import annotations

import logging
import re
import sqlite3
import struct
import threading
from contextlib import suppress
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from drost.storage.keys import (
    parse_session_key,
    session_key_for_telegram_chat,
    session_key_to_filename,
)

logger = logging.getLogger(__name__)


def _normalize_alias_key(value: str) -> str:
    lowered = str(value or "").strip().casefold()
    return re.sub(r"\s+", " ", lowered)


class SQLiteStore:
    """SQLite persistence for sessions + memory (with sqlite-vec acceleration)."""

    def __init__(
        self,
        *,
        db_path: Path,
        vector_extension_path: str = "",
        vector_dimensions: int = 3072,
    ) -> None:
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()

        self._vector_dimensions = int(vector_dimensions)
        self._vector_enabled = False
        self._vector_error = ""
        self._vector_extension_path = (vector_extension_path or "").strip()
        self._sqlite_vec = None

        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")
            self._init_schema()
            self._load_vector_extension()
            rebuild_vector_table = self._reconcile_vector_schema()
            self._ensure_vector_table()
            if rebuild_vector_table:
                self._backfill_vector_table_from_chunks()
            self._meta_set_int("memory_vector_dimensions", self._vector_dimensions)
            self._conn.commit()

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              session_key TEXT PRIMARY KEY,
              channel TEXT NOT NULL,
              chat_id INTEGER NOT NULL,
              session_id TEXT,
              title TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_chat_updated
              ON sessions(chat_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS chat_state (
              chat_id INTEGER PRIMARY KEY,
              active_session_id TEXT,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_continuity (
              to_session_key TEXT PRIMARY KEY,
              from_session_key TEXT NOT NULL,
              from_session_id TEXT NOT NULL DEFAULT '',
              summary TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (to_session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_session_continuity_from
              ON session_continuity(from_session_key, updated_at DESC);

            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_key TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_id
              ON messages(session_key, id);

            CREATE TABLE IF NOT EXISTS memory_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_key TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              embedding BLOB,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_id
              ON memory_chunks(session_key, id DESC);

            CREATE TABLE IF NOT EXISTS runtime_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memory_indexed_files (
              path TEXT PRIMARY KEY,
              source_kind TEXT NOT NULL,
              file_hash TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL,
              chunk_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS memory_entities (
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              entity_path TEXT NOT NULL DEFAULT '',
              summary_path TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL,
              PRIMARY KEY(entity_type, entity_id)
            );

            CREATE TABLE IF NOT EXISTS memory_entity_aliases (
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              alias TEXT NOT NULL,
              alias_normalized TEXT NOT NULL,
              path TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL,
              PRIMARY KEY(entity_type, entity_id, alias_normalized)
            );

            CREATE INDEX IF NOT EXISTS idx_memory_entity_aliases_normalized
              ON memory_entity_aliases(alias_normalized);

            CREATE TABLE IF NOT EXISTS memory_relations (
              relation_id TEXT PRIMARY KEY,
              from_entity_type TEXT NOT NULL,
              from_entity_id TEXT NOT NULL,
              relation_type TEXT NOT NULL,
              to_entity_type TEXT NOT NULL,
              to_entity_id TEXT NOT NULL,
              relation_text TEXT NOT NULL,
              confidence REAL,
              path TEXT NOT NULL DEFAULT '',
              line_start INTEGER NOT NULL DEFAULT 1,
              line_end INTEGER NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memory_relations_from
              ON memory_relations(from_entity_type, from_entity_id, relation_type);

            CREATE INDEX IF NOT EXISTS idx_memory_relations_to
              ON memory_relations(to_entity_type, to_entity_id, relation_type);

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
              USING fts5(content, chunk_id UNINDEXED);
            """
        )
        self._ensure_memory_chunk_columns()
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_chunks_source_path ON memory_chunks(source_kind, path)"
        )
        self._conn.commit()

    def _ensure_memory_chunk_columns(self) -> None:
        columns = {
            str(row["name"]): str(row["type"] or "")
            for row in self._conn.execute("PRAGMA table_info(memory_chunks)").fetchall()
        }
        required = {
            "source_kind": "TEXT NOT NULL DEFAULT 'transcript_message'",
            "path": "TEXT NOT NULL DEFAULT ''",
            "line_start": "INTEGER NOT NULL DEFAULT 1",
            "line_end": "INTEGER NOT NULL DEFAULT 1",
            "title": "TEXT NOT NULL DEFAULT ''",
            "updated_at": "TEXT NOT NULL DEFAULT ''",
            "derived_from": "TEXT NOT NULL DEFAULT ''",
            "content_hash": "TEXT NOT NULL DEFAULT ''",
        }
        for name, ddl in required.items():
            if name in columns:
                continue
            self._conn.execute(f"ALTER TABLE memory_chunks ADD COLUMN {name} {ddl}")

    def _table_exists(self, name: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1",
            (str(name),),
        ).fetchone()
        return row is not None

    def _meta_get_int(self, key: str) -> int | None:
        row = self._conn.execute(
            "SELECT value FROM runtime_meta WHERE key = ? LIMIT 1",
            (str(key),),
        ).fetchone()
        if row is None:
            return None
        raw = str(row["value"] or "").strip()
        if not raw:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    def _meta_set_int(self, key: str, value: int) -> None:
        self._conn.execute(
            """
            INSERT INTO runtime_meta(key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (str(key), str(int(value))),
        )

    def _sample_embedding_dimensions(self) -> int | None:
        row = self._conn.execute(
            "SELECT length(embedding) AS n FROM memory_chunks WHERE embedding IS NOT NULL LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        raw = row["n"]
        if raw is None:
            return None
        try:
            byte_count = int(raw)
        except Exception:
            return None
        if byte_count <= 0 or byte_count % 4 != 0:
            return None
        return byte_count // 4

    def _reconcile_vector_schema(self) -> bool:
        if self._vector_error:
            self._meta_set_int("memory_vector_dimensions", self._vector_dimensions)
            self._conn.commit()
            return False

        stored_dims = self._meta_get_int("memory_vector_dimensions")
        sampled_dims = self._sample_embedding_dimensions()
        had_vector_table = self._table_exists("memory_vec")
        rebuild_vector_table = False

        if sampled_dims is not None and sampled_dims != self._vector_dimensions:
            logger.warning(
                "Stored memory embeddings use %s dimensions but runtime expects %s; clearing incompatible vectors",
                sampled_dims,
                self._vector_dimensions,
            )
            self._conn.execute("DROP TABLE IF EXISTS memory_vec")
            self._conn.execute("UPDATE memory_chunks SET embedding = NULL WHERE embedding IS NOT NULL")
            self._meta_set_int("memory_vector_dimensions", self._vector_dimensions)
            self._conn.commit()
            return False

        if stored_dims == self._vector_dimensions:
            if not had_vector_table and sampled_dims == self._vector_dimensions:
                rebuild_vector_table = True
            return rebuild_vector_table

        if stored_dims is None:
            if had_vector_table or sampled_dims is not None:
                logger.warning(
                    "Legacy memory vector state detected; reconciling embeddings from %s to %s dimensions",
                    sampled_dims or "unknown",
                    self._vector_dimensions,
                )
        else:
            logger.warning(
                "Memory vector dimensions changed from %s to %s; rebuilding vector lane",
                stored_dims,
                self._vector_dimensions,
            )

        self._conn.execute("DROP TABLE IF EXISTS memory_vec")
        if sampled_dims is not None and sampled_dims != self._vector_dimensions:
            self._conn.execute("UPDATE memory_chunks SET embedding = NULL WHERE embedding IS NOT NULL")
        else:
            rebuild_vector_table = sampled_dims == self._vector_dimensions and sampled_dims is not None
        self._meta_set_int("memory_vector_dimensions", self._vector_dimensions)
        self._conn.commit()
        return rebuild_vector_table

    def _backfill_vector_table_from_chunks(self) -> None:
        if not self._vector_enabled:
            return
        expected_bytes = self._vector_dimensions * 4
        rows = self._conn.execute(
            """
            SELECT id, embedding
              FROM memory_chunks
             WHERE embedding IS NOT NULL
               AND length(embedding) = ?
          ORDER BY id ASC
            """,
            (expected_bytes,),
        ).fetchall()
        if not rows:
            return
        for row in rows:
            self._conn.execute(
                "INSERT OR REPLACE INTO memory_vec(id, embedding) VALUES (?, ?)",
                (int(row["id"]), row["embedding"]),
            )
        self._conn.commit()

    def _load_vector_extension(self) -> None:
        if self._vector_dimensions < 8:
            self._vector_enabled = False
            self._vector_error = "invalid embedding dimension"
            return

        try:
            self._conn.enable_load_extension(True)
            if self._vector_extension_path:
                self._conn.load_extension(self._vector_extension_path)
            else:
                try:
                    import sqlite_vec  # type: ignore
                except Exception as exc:
                    self._vector_enabled = False
                    self._vector_error = f"sqlite-vec module unavailable: {exc}"
                    return
                sqlite_vec.load(self._conn)
                self._sqlite_vec = sqlite_vec
            self._vector_error = ""
        except Exception as exc:
            self._vector_enabled = False
            self._vector_error = str(exc)
            logger.warning("sqlite-vec unavailable, using fallback vector search: %s", exc)
        finally:
            with suppress(Exception):
                self._conn.enable_load_extension(False)

    def _ensure_vector_table(self) -> None:
        if self._vector_dimensions < 8:
            self._vector_enabled = False
            self._vector_error = "invalid embedding dimension"
            return
        if self._vector_error:
            self._vector_enabled = False
            return
        try:
            self._conn.execute(
                f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
                  id INTEGER PRIMARY KEY,
                  embedding FLOAT[{self._vector_dimensions}]
                )
                """
            )
            self._conn.commit()
            self._vector_enabled = True
            self._vector_error = ""
        except Exception as exc:
            self._vector_enabled = False
            self._vector_error = str(exc)
            logger.warning("sqlite-vec unavailable, using fallback vector search: %s", exc)

    def memory_status(self) -> dict[str, Any]:
        with self._lock:
            counts = {
                str(row["source_kind"] or "unknown"): int(row["n"] or 0)
                for row in self._conn.execute(
                    """
                    SELECT source_kind, COUNT(*) AS n
                      FROM memory_chunks
                  GROUP BY source_kind
                    """
                ).fetchall()
            }
            indexed_files = int(
                (
                    self._conn.execute("SELECT COUNT(*) AS n FROM memory_indexed_files").fetchone() or {"n": 0}
                )["n"]
            )
            entity_count = int(
                (
                    self._conn.execute("SELECT COUNT(*) AS n FROM memory_entities").fetchone() or {"n": 0}
                )["n"]
            )
            alias_count = int(
                (
                    self._conn.execute("SELECT COUNT(*) AS n FROM memory_entity_aliases").fetchone() or {"n": 0}
                )["n"]
            )
            relation_count = int(
                (
                    self._conn.execute("SELECT COUNT(*) AS n FROM memory_relations").fetchone() or {"n": 0}
                )["n"]
            )
        return {
            "vector_enabled": bool(self._vector_enabled),
            "vector_error": self._vector_error,
            "vector_dimensions": self._vector_dimensions,
            "vector_extension_path": self._vector_extension_path,
            "db_path": str(self.db_path),
            "source_counts": counts,
            "indexed_files": indexed_files,
            "graph_entities": entity_count,
            "graph_aliases": alias_count,
            "graph_relations": relation_count,
        }

    @staticmethod
    def _normalize_fts_query(query: str) -> str:
        # Convert arbitrary user text into a literal-safe FTS5 query.
        # Hyphenated terms like "third-party" must be split, otherwise FTS5
        # can interpret them as query syntax and raise errors such as
        # "no such column: party".
        tokens: list[str] = []
        current: list[str] = []
        for ch in (query or ""):
            if ch.isalnum() or ch == "_":
                current.append(ch)
                continue
            if current:
                tokens.append("".join(current))
                current = []
        if current:
            tokens.append("".join(current))
        if not tokens:
            return ""
        return " AND ".join(f'"{token}"' for token in tokens[:12])

    @staticmethod
    def _is_zero_vector(vec: list[float]) -> bool:
        return all(abs(v) < 1e-9 for v in vec)

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = 0.0
        na = 0.0
        nb = 0.0
        for x, y in zip(a, b, strict=False):
            dot += x * y
            na += x * x
            nb += y * y
        if na <= 0.0 or nb <= 0.0:
            return 0.0
        return dot / ((na ** 0.5) * (nb ** 0.5))

    def _serialize_embedding(self, embedding: list[float]) -> bytes:
        if self._sqlite_vec is not None:
            return self._sqlite_vec.serialize_float32(embedding)
        return struct.pack(f"<{len(embedding)}f", *embedding)

    @staticmethod
    def _embedding_from_blob(blob: bytes | memoryview | None) -> list[float]:
        if blob is None:
            return []
        raw = bytes(blob)
        if not raw:
            return []
        if len(raw) % 4 != 0:
            return []
        size = len(raw) // 4
        return list(struct.unpack(f"<{size}f", raw))

    @staticmethod
    def _truncate(text: str, limit: int = 500) -> str:
        cleaned = (text or "").strip()
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[:limit].rstrip() + "..."

    @staticmethod
    def _split_chat_identifier(identifier: str) -> tuple[int, str | None]:
        raw = str(identifier or "")
        base, sep, tail = raw.partition("__")
        chat_id = int(base)
        if not sep:
            return chat_id, None
        session_id = tail.strip()
        return chat_id, session_id or None

    def _ensure_session_row(self, session_key: str, *, title: str = "") -> None:
        parsed = parse_session_key(session_key)
        chat_id = 0
        session_id: str | None = None
        if parsed.channel == "telegram":
            try:
                chat_id, session_id = self._split_chat_identifier(parsed.identifier)
            except Exception:
                chat_id = 0
                session_id = None

        now = self._utc_now()
        self._conn.execute(
            """
            INSERT INTO sessions(session_key, channel, chat_id, session_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
              updated_at=excluded.updated_at,
              title=CASE
                WHEN excluded.title <> '' THEN excluded.title
                ELSE sessions.title
              END
            """,
            (
                session_key,
                parsed.channel,
                chat_id,
                session_id,
                (title or "").strip(),
                now,
                now,
            ),
        )

    # --- Session helpers -------------------------------------------------

    def get_active_session_id(self, chat_id: int) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT active_session_id FROM chat_state WHERE chat_id = ?",
                (int(chat_id),),
            ).fetchone()
            if row is None:
                return None
            value = str(row["active_session_id"] or "").strip()
            return value or None

    def set_active_session_id(self, chat_id: int, session_id: str | None) -> None:
        with self._lock:
            cleaned = (session_id or "").strip() or None
            self._conn.execute(
                """
                INSERT INTO chat_state(chat_id, active_session_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                  active_session_id=excluded.active_session_id,
                  updated_at=excluded.updated_at
                """,
                (int(chat_id), cleaned, self._utc_now()),
            )
            self._conn.commit()

    def current_session_key(self, chat_id: int) -> str:
        session_id = self.get_active_session_id(chat_id)
        if session_id == "legacy-main":
            session_id = None
        return session_key_for_telegram_chat(chat_id, session_id)

    def create_session(self, chat_id: int, title: str = "") -> str:
        with self._lock:
            base = datetime.now(UTC).strftime("s_%Y-%m-%d_%H-%M-%S")
            candidate = base
            suffix = 1
            while True:
                session_key = session_key_for_telegram_chat(chat_id, candidate)
                exists = self._conn.execute(
                    "SELECT 1 FROM sessions WHERE session_key = ? LIMIT 1",
                    (session_key,),
                ).fetchone()
                if exists is None:
                    break
                candidate = f"{base}_{suffix}"
                suffix += 1

            self._ensure_session_row(session_key, title=title)
            self.set_active_session_id(chat_id, candidate)
            self._conn.commit()
            return candidate

    def list_chat_sessions(self, chat_id: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT s.session_key,
                       s.session_id,
                       s.title,
                       s.updated_at,
                       COALESCE(m.msg_count, 0) AS message_count
                  FROM sessions s
             LEFT JOIN (
                       SELECT session_key, COUNT(*) AS msg_count
                         FROM messages
                     GROUP BY session_key
                       ) m ON m.session_key = s.session_key
                 WHERE s.chat_id = ?
              ORDER BY s.updated_at DESC
                """,
                (int(chat_id),),
            ).fetchall()

            out: list[dict[str, Any]] = []
            for row in rows:
                sid = str(row["session_id"] or "").strip() or "legacy-main"
                out.append(
                    {
                        "session_id": sid,
                        "session_key": str(row["session_key"]),
                        "title": str(row["title"] or ""),
                        "updated_at": str(row["updated_at"] or ""),
                        "message_count": int(row["message_count"] or 0),
                    }
                )

            if not any(r["session_id"] == "legacy-main" for r in out):
                legacy_key = session_key_for_telegram_chat(chat_id, None)
                out.append(
                    {
                        "session_id": "legacy-main",
                        "session_key": legacy_key,
                        "title": "Legacy main",
                        "updated_at": "",
                        "message_count": self.message_count(legacy_key),
                    }
                )

            return out

    def message_count(self, session_key: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE session_key = ?",
            (session_key,),
        ).fetchone()
        return int(row["n"] if row else 0)

    def read_history(self, session_key: str, *, limit: int = 64) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT role, content
                  FROM messages
                 WHERE session_key = ?
              ORDER BY id DESC
                 LIMIT ?
                """,
                (session_key, int(limit)),
            ).fetchall()

        out = [{"role": str(r["role"]), "content": str(r["content"])} for r in rows]
        out.reverse()
        return out

    def append_message(self, session_key: str, role: str, content: str) -> int:
        with self._lock:
            self._ensure_session_row(session_key)
            now = self._utc_now()
            cursor = self._conn.execute(
                """
                INSERT INTO messages(session_key, role, content, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (session_key, str(role), str(content), now),
            )
            self._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE session_key = ?",
                (now, session_key),
            )
            self._conn.commit()
            return int(cursor.lastrowid)

    def reset_session(self, session_key: str) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM messages WHERE session_key = ?",
                (session_key,),
            )
            self._conn.execute(
                "DELETE FROM session_continuity WHERE to_session_key = ?",
                (session_key,),
            )
            self._delete_memory_rows_for_session_source(
                session_key=session_key,
                source_kind="session_continuity",
            )
            self._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE session_key = ?",
                (self._utc_now(), session_key),
            )
            self._conn.commit()
            return int(cursor.rowcount)

    def _delete_memory_rows_for_session_source(self, *, session_key: str, source_kind: str) -> None:
        cleaned_session = str(session_key or "").strip()
        cleaned_kind = str(source_kind or "").strip()
        if not cleaned_session or not cleaned_kind:
            return
        ids = [
            int(row["id"])
            for row in self._conn.execute(
                """
                SELECT id
                  FROM memory_chunks
                 WHERE session_key = ?
                   AND source_kind = ?
                """,
                (cleaned_session, cleaned_kind),
            ).fetchall()
        ]
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._conn.execute(f"DELETE FROM memory_fts WHERE rowid IN ({placeholders})", ids)
        if self._vector_enabled:
            self._conn.execute(f"DELETE FROM memory_vec WHERE id IN ({placeholders})", ids)
        self._conn.execute(f"DELETE FROM memory_chunks WHERE id IN ({placeholders})", ids)

    def set_session_continuity(
        self,
        *,
        to_session_key: str,
        from_session_key: str,
        from_session_id: str,
        summary: str,
    ) -> None:
        cleaned_to = str(to_session_key or "").strip()
        cleaned_from = str(from_session_key or "").strip()
        cleaned_summary = str(summary or "").strip()
        if not cleaned_to:
            raise ValueError("to_session_key is required")
        if not cleaned_from:
            raise ValueError("from_session_key is required")
        if not cleaned_summary:
            raise ValueError("summary is required")
        with self._lock:
            self._ensure_session_row(cleaned_to)
            now = self._utc_now()
            self._conn.execute(
                """
                INSERT INTO session_continuity(
                  to_session_key, from_session_key, from_session_id, summary, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(to_session_key) DO UPDATE SET
                  from_session_key=excluded.from_session_key,
                  from_session_id=excluded.from_session_id,
                  summary=excluded.summary,
                  updated_at=excluded.updated_at
                """,
                (
                    cleaned_to,
                    cleaned_from,
                    str(from_session_id or "").strip(),
                    cleaned_summary,
                    now,
                    now,
                ),
            )
            self._conn.commit()

    def get_session_continuity(self, session_key: str) -> dict[str, Any] | None:
        cleaned = str(session_key or "").strip()
        if not cleaned:
            return None
        with self._lock:
            row = self._conn.execute(
                """
                SELECT to_session_key, from_session_key, from_session_id, summary, created_at, updated_at
                  FROM session_continuity
                 WHERE to_session_key = ?
                 LIMIT 1
                """,
                (cleaned,),
            ).fetchone()
        if row is None:
            return None
        return {
            "to_session_key": str(row["to_session_key"] or ""),
            "from_session_key": str(row["from_session_key"] or ""),
            "from_session_id": str(row["from_session_id"] or ""),
            "summary": str(row["summary"] or ""),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def replace_session_continuity_memory(
        self,
        *,
        to_session_key: str,
        from_session_key: str,
        from_session_id: str,
        summary: str,
        embedding: list[float],
    ) -> None:
        cleaned_to = str(to_session_key or "").strip()
        cleaned_from = str(from_session_key or "").strip()
        cleaned_summary = str(summary or "").strip()
        if not cleaned_to or not cleaned_from or not cleaned_summary:
            return

        with self._lock:
            self._ensure_session_row(cleaned_to)
            self._delete_memory_rows_for_session_source(
                session_key=cleaned_to,
                source_kind="session_continuity",
            )
            now = self._utc_now()
            title = f"continuity/{str(from_session_id or '').strip() or 'previous'}"
            path = f"sessions/{session_key_to_filename(cleaned_to)}.continuity.md"
            self._insert_memory_chunk(
                session_key=cleaned_to,
                role="system",
                content=cleaned_summary,
                embedding=embedding,
                source_kind="session_continuity",
                path=path,
                line_start=1,
                line_end=max(1, len(cleaned_summary.splitlines())),
                title=title,
                derived_from=cleaned_from,
                content_hash=sha256(cleaned_summary.encode("utf-8")).hexdigest(),
                created_at=now,
                updated_at=now,
            )
            self._conn.commit()

    # --- Memory helpers --------------------------------------------------

    def _insert_memory_chunk(
        self,
        *,
        session_key: str,
        role: str,
        content: str,
        embedding: list[float],
        source_kind: str,
        path: str = "",
        line_start: int = 1,
        line_end: int | None = None,
        title: str = "",
        derived_from: str = "",
        content_hash: str = "",
        created_at: str | None = None,
        updated_at: str | None = None,
    ) -> int:
        cleaned_session = str(session_key or "").strip()
        if cleaned_session:
            self._ensure_session_row(cleaned_session)
        now = self._utc_now()
        created = str(created_at or now)
        updated = str(updated_at or created)
        blob = self._serialize_embedding(embedding) if embedding else None
        cursor = self._conn.execute(
            """
            INSERT INTO memory_chunks(
              session_key, role, content, embedding, created_at,
              source_kind, path, line_start, line_end, title, updated_at, derived_from, content_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cleaned_session,
                str(role or ""),
                str(content or ""),
                blob,
                created,
                str(source_kind or "transcript_message"),
                str(path or ""),
                max(1, int(line_start)),
                max(1, int(line_end if line_end is not None else line_start)),
                str(title or ""),
                updated,
                str(derived_from or ""),
                str(content_hash or ""),
            ),
        )
        chunk_id = int(cursor.lastrowid)
        self._conn.execute(
            "INSERT INTO memory_fts(rowid, content, chunk_id) VALUES (?, ?, ?)",
            (chunk_id, str(content or ""), chunk_id),
        )

        if self._vector_enabled and embedding:
            try:
                vec_blob = self._serialize_embedding(embedding)
                self._conn.execute(
                    "INSERT OR REPLACE INTO memory_vec(id, embedding) VALUES (?, ?)",
                    (chunk_id, vec_blob),
                )
            except Exception as exc:
                self._vector_enabled = False
                self._vector_error = str(exc)
                logger.warning("Disabling sqlite-vec writes after insert failure: %s", exc)

        return chunk_id

    def add_memory(self, *, session_key: str, role: str, content: str, embedding: list[float]) -> int:
        with self._lock:
            chunk_id = self._insert_memory_chunk(
                session_key=session_key,
                role=role,
                content=content,
                embedding=embedding,
                source_kind="transcript_message",
            )
            self._conn.commit()
            return chunk_id

    @staticmethod
    def _row_to_memory_result(row: sqlite3.Row | dict[str, Any], *, score: float | None = None) -> dict[str, Any]:
        raw = row if isinstance(row, dict) else dict(row)
        out = {
            "id": int(raw.get("id") or 0),
            "session_key": str(raw.get("session_key") or ""),
            "role": str(raw.get("role") or ""),
            "content": str(raw.get("content") or ""),
            "created_at": str(raw.get("created_at") or ""),
            "source_kind": str(raw.get("source_kind") or "transcript_message"),
            "path": str(raw.get("path") or ""),
            "line_start": int(raw.get("line_start") or 1),
            "line_end": int(raw.get("line_end") or raw.get("line_start") or 1),
            "title": str(raw.get("title") or ""),
            "updated_at": str(raw.get("updated_at") or ""),
            "derived_from": str(raw.get("derived_from") or ""),
            "content_hash": str(raw.get("content_hash") or ""),
        }
        if score is not None:
            out["score"] = float(score)
        elif raw.get("score") is not None:
            out["score"] = float(raw.get("score") or 0.0)
        return out

    def get_memory_chunk(self, chunk_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, session_key, role, content, created_at,
                       source_kind, path, line_start, line_end, title, updated_at, derived_from, content_hash
                  FROM memory_chunks
                 WHERE id = ?
                 LIMIT 1
                """,
                (int(chunk_id),),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_memory_result(row)

    def get_indexed_file(self, path: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT path, source_kind, file_hash, title, updated_at, chunk_count
                  FROM memory_indexed_files
                 WHERE path = ?
                 LIMIT 1
                """,
                (str(path or ""),),
            ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_indexed_files(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT path, source_kind, file_hash, title, updated_at, chunk_count
                  FROM memory_indexed_files
              ORDER BY path ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def replace_graph_index(
        self,
        *,
        entities: list[dict[str, Any]],
        aliases: list[dict[str, Any]],
        relations: list[dict[str, Any]],
    ) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM memory_entities")
            self._conn.execute("DELETE FROM memory_entity_aliases")
            self._conn.execute("DELETE FROM memory_relations")

            for entity in entities:
                self._conn.execute(
                    """
                    INSERT INTO memory_entities(
                      entity_type, entity_id, title, entity_path, summary_path, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(entity.get("entity_type") or "").strip(),
                        str(entity.get("entity_id") or "").strip(),
                        str(entity.get("title") or "").strip(),
                        str(entity.get("entity_path") or "").strip(),
                        str(entity.get("summary_path") or "").strip(),
                        str(entity.get("updated_at") or self._utc_now()),
                    ),
                )

            for alias in aliases:
                alias_text = str(alias.get("alias") or "").strip()
                self._conn.execute(
                    """
                    INSERT INTO memory_entity_aliases(
                      entity_type, entity_id, alias, alias_normalized, path, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(alias.get("entity_type") or "").strip(),
                        str(alias.get("entity_id") or "").strip(),
                        alias_text,
                        _normalize_alias_key(alias_text),
                        str(alias.get("path") or "").strip(),
                        str(alias.get("updated_at") or self._utc_now()),
                    ),
                )

            for relation in relations:
                self._conn.execute(
                    """
                    INSERT INTO memory_relations(
                      relation_id, from_entity_type, from_entity_id, relation_type,
                      to_entity_type, to_entity_id, relation_text, confidence,
                      path, line_start, line_end, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(relation.get("relation_id") or "").strip(),
                        str(relation.get("from_entity_type") or "").strip(),
                        str(relation.get("from_entity_id") or "").strip(),
                        str(relation.get("relation_type") or "").strip(),
                        str(relation.get("to_entity_type") or "").strip(),
                        str(relation.get("to_entity_id") or "").strip(),
                        str(relation.get("relation_text") or "").strip(),
                        relation.get("confidence"),
                        str(relation.get("path") or "").strip(),
                        max(1, int(relation.get("line_start") or 1)),
                        max(1, int(relation.get("line_end") or relation.get("line_start") or 1)),
                        str(relation.get("updated_at") or self._utc_now()),
                    ),
                )

            self._conn.commit()

    def list_memory_entities(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT entity_type, entity_id, title, entity_path, summary_path, updated_at
                  FROM memory_entities
              ORDER BY entity_type ASC, entity_id ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def find_entity_by_alias(self, alias: str) -> dict[str, Any] | None:
        normalized = _normalize_alias_key(alias)
        if not normalized:
            return None
        with self._lock:
            row = self._conn.execute(
                """
                SELECT e.entity_type,
                       e.entity_id,
                       e.title,
                       e.entity_path,
                       e.summary_path,
                       e.updated_at,
                       a.alias,
                       a.path AS alias_path
                  FROM memory_entity_aliases a
                  JOIN memory_entities e
                    ON e.entity_type = a.entity_type
                   AND e.entity_id = a.entity_id
                 WHERE a.alias_normalized = ?
                 LIMIT 1
                """,
                (normalized,),
            ).fetchone()
        return dict(row) if row is not None else None

    def list_entity_relations(self, entity_type: str, entity_id: str) -> list[dict[str, Any]]:
        cleaned_type = str(entity_type or "").strip()
        cleaned_id = str(entity_id or "").strip()
        if not cleaned_type or not cleaned_id:
            return []
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT relation_id,
                       from_entity_type,
                       from_entity_id,
                       relation_type,
                       to_entity_type,
                       to_entity_id,
                       relation_text,
                       confidence,
                       path,
                       line_start,
                       line_end,
                       updated_at
                  FROM memory_relations
                 WHERE from_entity_type = ?
                   AND from_entity_id = ?
              ORDER BY updated_at DESC, relation_id ASC
                """,
                (cleaned_type, cleaned_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def remove_indexed_file(self, path: str) -> None:
        cleaned_path = str(path or "").strip()
        if not cleaned_path:
            return
        with self._lock:
            ids = [
                int(row["id"])
                for row in self._conn.execute(
                    "SELECT id FROM memory_chunks WHERE path = ?",
                    (cleaned_path,),
                ).fetchall()
            ]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                self._conn.execute(f"DELETE FROM memory_fts WHERE rowid IN ({placeholders})", ids)
                if self._vector_enabled:
                    self._conn.execute(f"DELETE FROM memory_vec WHERE id IN ({placeholders})", ids)
                self._conn.execute(f"DELETE FROM memory_chunks WHERE id IN ({placeholders})", ids)
            self._conn.execute("DELETE FROM memory_indexed_files WHERE path = ?", (cleaned_path,))
            self._conn.commit()

    def replace_indexed_file(
        self,
        *,
        path: str,
        source_kind: str,
        title: str,
        file_hash: str,
        updated_at: str,
        chunks: list[dict[str, Any]],
    ) -> None:
        cleaned_path = str(path or "").strip()
        if not cleaned_path:
            raise ValueError("path is required")
        with self._lock:
            self.remove_indexed_file(cleaned_path)
            for chunk in chunks:
                self._insert_memory_chunk(
                    session_key="",
                    role="memory",
                    content=str(chunk.get("content") or ""),
                    embedding=list(chunk.get("embedding") or []),
                    source_kind=source_kind,
                    path=cleaned_path,
                    line_start=int(chunk.get("line_start") or 1),
                    line_end=int(chunk.get("line_end") or chunk.get("line_start") or 1),
                    title=str(chunk.get("title") or title or ""),
                    derived_from=str(chunk.get("derived_from") or ""),
                    content_hash=file_hash,
                    created_at=str(chunk.get("created_at") or updated_at),
                    updated_at=updated_at,
                )
            self._conn.execute(
                """
                INSERT INTO memory_indexed_files(path, source_kind, file_hash, title, updated_at, chunk_count)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                  source_kind=excluded.source_kind,
                  file_hash=excluded.file_hash,
                  title=excluded.title,
                  updated_at=excluded.updated_at,
                  chunk_count=excluded.chunk_count
                """,
                (cleaned_path, source_kind, file_hash, title, updated_at, len(chunks)),
            )
            self._conn.commit()

    def _search_vector_sqlite_vec(self, query_embedding: list[float], limit: int) -> list[dict[str, Any]]:
        if not self._vector_enabled or not query_embedding or self._is_zero_vector(query_embedding):
            return []

        try:
            query_blob = self._serialize_embedding(query_embedding)
            rows = self._conn.execute(
                """
                SELECT m.id,
                       m.session_key,
                       m.role,
                       m.content,
                       m.created_at,
                       m.source_kind,
                       m.path,
                       m.line_start,
                       m.line_end,
                       m.title,
                       m.updated_at,
                       m.derived_from,
                       m.content_hash,
                       vec_distance_cosine(v.embedding, ?) AS dist
                  FROM memory_vec v
                  JOIN memory_chunks m ON m.id = v.id
              ORDER BY dist ASC
                 LIMIT ?
                """,
                (query_blob, int(limit)),
            ).fetchall()
        except Exception as exc:
            self._vector_enabled = False
            self._vector_error = str(exc)
            logger.warning("Disabling sqlite-vec search after query failure: %s", exc)
            return []

        out: list[dict[str, Any]] = []
        for row in rows:
            dist = float(row["dist"] if row["dist"] is not None else 1.0)
            out.append(self._row_to_memory_result(row, score=max(0.0, 1.0 - dist)))
        return out

    def _search_vector_fallback(self, query_embedding: list[float], limit: int) -> list[dict[str, Any]]:
        if not query_embedding or self._is_zero_vector(query_embedding):
            return []

        rows = self._conn.execute(
            """
            SELECT id, session_key, role, content, created_at,
                   source_kind, path, line_start, line_end, title, updated_at, derived_from, content_hash,
                   embedding
              FROM memory_chunks
             WHERE embedding IS NOT NULL
          ORDER BY id DESC
             LIMIT 3000
            """
        ).fetchall()

        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            embedding = self._embedding_from_blob(row["embedding"])
            score = self._cosine_similarity(query_embedding, embedding)
            if score <= 0.0:
                continue
            scored.append(
                (
                    score,
                    {
                        **self._row_to_memory_result(row),
                        "score": score,
                    },
                )
            )

        scored.sort(key=lambda item: item[0], reverse=True)
        return [item[1] for item in scored[:limit]]

    def _search_keyword(self, query_text: str, limit: int) -> list[dict[str, Any]]:
        fts = self._normalize_fts_query(query_text)
        if not fts:
            return []

        rows = self._conn.execute(
            """
            SELECT m.id,
                   m.session_key,
                   m.role,
                   m.content,
                   m.created_at,
                   m.source_kind,
                   m.path,
                   m.line_start,
                   m.line_end,
                   m.title,
                   m.updated_at,
                   m.derived_from,
                   m.content_hash,
                   bm25(memory_fts) AS rank
              FROM memory_fts
              JOIN memory_chunks m ON m.id = memory_fts.rowid
             WHERE memory_fts MATCH ?
          ORDER BY rank ASC
             LIMIT ?
            """,
            (fts, int(limit)),
        ).fetchall()

        out: list[dict[str, Any]] = []
        for row in rows:
            rank = float(row["rank"] if row["rank"] is not None else 1000.0)
            # Lower rank is better for BM25; map to bounded score.
            score = 1.0 / (1.0 + max(0.0, rank))
            out.append(self._row_to_memory_result(row, score=score))
        return out

    def search_memory(
        self,
        *,
        query_text: str,
        query_embedding: list[float],
        limit: int = 6,
    ) -> list[dict[str, Any]]:
        with self._lock:
            vector_rows = self._search_vector_sqlite_vec(query_embedding, limit * 3)
            if not vector_rows:
                vector_rows = self._search_vector_fallback(query_embedding, limit * 3)
            keyword_rows = self._search_keyword(query_text, limit * 3)

        if not vector_rows and not keyword_rows:
            return []

        fused: dict[int, dict[str, Any]] = {}
        fused_score: dict[int, float] = {}

        def apply_rrf(rows: list[dict[str, Any]], weight: float) -> None:
            for rank, row in enumerate(rows, start=1):
                rid = int(row["id"])
                fused[rid] = row
                fused_score[rid] = fused_score.get(rid, 0.0) + (weight / (60.0 + rank))

        apply_rrf(vector_rows, 0.7)
        apply_rrf(keyword_rows, 0.3)

        ranked_ids = sorted(fused_score.keys(), key=lambda rid: fused_score[rid], reverse=True)

        out: list[dict[str, Any]] = []
        for rid in ranked_ids[:limit]:
            row = dict(fused[rid])
            row["fused_score"] = float(fused_score[rid])
            row["snippet"] = self._truncate(str(row.get("content") or ""), 380)
            out.append(row)
        return out

    def close(self) -> None:
        with self._lock:
            self._conn.close()
