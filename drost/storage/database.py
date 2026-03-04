from __future__ import annotations

import logging
import sqlite3
import struct
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from drost.storage.keys import parse_session_key, session_key_for_telegram_chat

logger = logging.getLogger(__name__)


class SQLiteStore:
    """SQLite persistence for sessions + memory (with sqlite-vec acceleration)."""

    def __init__(
        self,
        *,
        db_path: Path,
        vector_extension_path: str = "",
        vector_dimensions: int = 384,
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
            self._init_vector_support()

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

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

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
              USING fts5(content, chunk_id UNINDEXED);
            """
        )
        self._conn.commit()

    def _init_vector_support(self) -> None:
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
        finally:
            try:
                self._conn.enable_load_extension(False)
            except Exception:
                pass

    def memory_status(self) -> dict[str, Any]:
        return {
            "vector_enabled": bool(self._vector_enabled),
            "vector_error": self._vector_error,
            "vector_dimensions": self._vector_dimensions,
            "vector_extension_path": self._vector_extension_path,
            "db_path": str(self.db_path),
        }

    @staticmethod
    def _normalize_fts_query(query: str) -> str:
        # Simple FTS5-safe tokenization.
        tokens: list[str] = []
        current: list[str] = []
        for ch in (query or ""):
            if ch.isalnum() or ch in {"_", "-"}:
                current.append(ch)
                continue
            if current:
                tokens.append("".join(current))
                current = []
        if current:
            tokens.append("".join(current))
        return " ".join(tokens[:12])

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
        for x, y in zip(a, b):
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
            base = datetime.now(timezone.utc).strftime("s_%Y-%m-%d_%H-%M-%S")
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
                "UPDATE sessions SET updated_at = ? WHERE session_key = ?",
                (self._utc_now(), session_key),
            )
            self._conn.commit()
            return int(cursor.rowcount)

    # --- Memory helpers --------------------------------------------------

    def add_memory(self, *, session_key: str, role: str, content: str, embedding: list[float]) -> int:
        with self._lock:
            blob = self._serialize_embedding(embedding) if embedding else None
            cursor = self._conn.execute(
                """
                INSERT INTO memory_chunks(session_key, role, content, embedding, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_key, role, content, blob, self._utc_now()),
            )
            chunk_id = int(cursor.lastrowid)
            self._conn.execute(
                "INSERT INTO memory_fts(rowid, content, chunk_id) VALUES (?, ?, ?)",
                (chunk_id, content, chunk_id),
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

            self._conn.commit()
            return chunk_id

    def get_memory_chunk(self, chunk_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, session_key, role, content, created_at
                  FROM memory_chunks
                 WHERE id = ?
                 LIMIT 1
                """,
                (int(chunk_id),),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": int(row["id"]),
            "session_key": str(row["session_key"]),
            "role": str(row["role"]),
            "content": str(row["content"]),
            "created_at": str(row["created_at"]),
        }

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
            out.append(
                {
                    "id": int(row["id"]),
                    "session_key": str(row["session_key"]),
                    "role": str(row["role"]),
                    "content": str(row["content"]),
                    "created_at": str(row["created_at"]),
                    "score": max(0.0, 1.0 - dist),
                }
            )
        return out

    def _search_vector_fallback(self, query_embedding: list[float], limit: int) -> list[dict[str, Any]]:
        if not query_embedding or self._is_zero_vector(query_embedding):
            return []

        rows = self._conn.execute(
            """
            SELECT id, session_key, role, content, created_at, embedding
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
                        "id": int(row["id"]),
                        "session_key": str(row["session_key"]),
                        "role": str(row["role"]),
                        "content": str(row["content"]),
                        "created_at": str(row["created_at"]),
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
            out.append(
                {
                    "id": int(row["id"]),
                    "session_key": str(row["session_key"]),
                    "role": str(row["role"]),
                    "content": str(row["content"]),
                    "created_at": str(row["created_at"]),
                    "score": score,
                }
            )
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
