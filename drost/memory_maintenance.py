from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import defaultdict
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.entity_resolution import EntityResolver
from drost.followups import FollowUpStore
from drost.memory_files import MemoryFiles
from drost.providers import BaseProvider, ChatResponse, Message, MessageRole

logger = logging.getLogger(__name__)

DEFAULT_INITIAL_TAIL_LINES = 200
DEFAULT_TOOL_RESULT_CHAR_LIMIT = 4_000
DEFAULT_ENTITY_TYPES = (
    "people",
    "projects",
    "repos",
    "providers",
    "models",
    "tools",
    "workflows",
    "preferences",
    "constraints",
    "channels",
)

_JSON_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\n?|\n?```$", re.MULTILINE)


@dataclass(slots=True)
class PendingEvent:
    file_name: str
    line: int
    session_key: str
    chat_id: int
    payload: dict[str, Any]


@dataclass(slots=True)
class PendingBatch:
    events: list[PendingEvent]
    scan_end: dict[str, int]
    total_entries: dict[str, int]


@dataclass(slots=True, frozen=True)
class EntityRef:
    entity_type: str
    entity_id: str


class MemoryMaintenanceRunner:
    def __init__(
        self,
        *,
        workspace_dir: str | Path,
        sessions_dir: str | Path,
        provider_getter: Callable[[], BaseProvider],
        sync_memory_index: Callable[[], Awaitable[dict[str, int]]],
        enabled: bool,
        interval_seconds: int = 1800,
        max_events_per_run: int = 200,
        entity_synthesis_enabled: bool = True,
        followups: FollowUpStore | None = None,
        followups_enabled: bool = True,
        followup_confidence_threshold: float = 0.80,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._sessions_dir = Path(sessions_dir).expanduser()
        self._provider_getter = provider_getter
        self._sync_memory_index = sync_memory_index
        self._enabled = bool(enabled)
        self._interval_seconds = max(1, int(interval_seconds))
        self._max_events_per_run = max(1, int(max_events_per_run))
        self._entity_synthesis_enabled = bool(entity_synthesis_enabled)
        self._memory_files = MemoryFiles(self._workspace_dir)
        self._followups = followups or (FollowUpStore(self._workspace_dir) if followups_enabled else None)
        self._followups_enabled = bool(followups_enabled)
        self._followup_confidence_threshold = max(0.0, min(1.0, float(followup_confidence_threshold)))

        self._task: asyncio.Task[None] | None = None
        self._run_lock = asyncio.Lock()
        self._running = False
        self._last_status: dict[str, Any] = {
            "enabled": self._enabled,
            "running": False,
            "interval_seconds": self._interval_seconds,
            "max_events_per_run": self._max_events_per_run,
            "entity_synthesis_enabled": self._entity_synthesis_enabled,
            "followups_enabled": self._followups_enabled,
            "followup_confidence_threshold": self._followup_confidence_threshold,
            "last_run_at": "",
            "last_success_at": "",
            "last_error": "",
            "last_result": {},
        }

    async def start(self) -> None:
        if not self._enabled or self._running:
            return
        self._running = True
        self._last_status["running"] = True
        self._task = asyncio.create_task(self._loop())
        asyncio.create_task(self.run_once(reason="startup"))
        logger.info(
            "Memory maintenance runner started (interval=%ss max_events=%s)",
            self._interval_seconds,
            self._max_events_per_run,
        )

    async def stop(self) -> None:
        self._running = False
        self._last_status["running"] = False
        if self._task is None:
            return
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        self._task = None
        logger.info("Memory maintenance runner stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._interval_seconds)
                await self.run_once(reason="scheduled")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Memory maintenance loop error")

    def status(self) -> dict[str, Any]:
        return dict(self._last_status)

    async def run_once(self, *, reason: str = "manual") -> dict[str, Any]:
        async with self._run_lock:
            started_at = self._utc_now()
            self._last_status["last_run_at"] = started_at

            state = self._load_state()
            batch = self._collect_pending_batch(state)
            if not batch.events:
                advanced = self._advance_state(state, batch=batch, processed=batch.events)
                if advanced:
                    self._save_state(state)
                result = {
                    "reason": reason,
                    "new_events": 0,
                    "daily_notes_written": 0,
                    "aliases_written": 0,
                    "facts_written": 0,
                    "relations_written": 0,
                    "followups_written": 0,
                    "summaries_written": 0,
                    "sync_result": {"indexed": 0, "skipped": 0, "removed": 0},
                }
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                self._last_status["last_success_at"] = started_at
                return result

            provider = self._provider_getter()
            response = await self._extract(provider=provider, events=[event.payload for event in batch.events])
            payload = self._parse_payload(response)
            if payload is None:
                error = "memory extraction JSON parse failed"
                logger.warning("%s", error)
                self._last_status["last_error"] = error
                self._last_status["last_result"] = {"reason": reason, "new_events": len(batch.events), "error": error}
                state["last_error"] = error
                state["last_run_at"] = started_at
                self._save_state(state)
                return dict(self._last_status["last_result"])

            resolver = EntityResolver(self._workspace_dir)
            self._register_entities(payload.get("entities"), resolver=resolver)
            daily_written, touched_daily = self._write_daily_notes(payload.get("daily_notes"))
            aliases_written, touched_aliases = self._write_aliases(payload.get("aliases"), resolver=resolver)
            facts_written, touched_facts, touched_entities = self._write_facts(
                payload.get("facts"),
                resolver=resolver,
            )
            relations_written, touched_relations, relation_entities = self._write_relations(
                payload.get("relations"),
                resolver=resolver,
            )
            followups_written, touched_followups = self._write_followups(
                payload.get("follow_ups"),
                resolver=resolver,
                events=batch.events,
            )
            touched_entities.update(relation_entities)
            summaries_written, touched_summaries = await self._synthesize_entities(
                provider=provider,
                entities=touched_entities,
                state=state,
            )
            touched_paths = {
                str(path)
                for path in [
                    *touched_daily,
                    *touched_aliases,
                    *touched_facts,
                    *touched_relations,
                    *touched_followups,
                    *touched_summaries,
                ]
            }

            self._advance_state(state, batch=batch, processed=batch.events)
            state["last_run_at"] = started_at
            state["last_success_at"] = started_at
            state["last_error"] = ""
            self._save_state(state)

            sync_result = await self._sync_memory_index()
            result = {
                "reason": reason,
                "provider": provider.name,
                "new_events": len(batch.events),
                "daily_notes_written": daily_written,
                "aliases_written": aliases_written,
                "facts_written": facts_written,
                "relations_written": relations_written,
                "followups_written": followups_written,
                "summaries_written": summaries_written,
                "touched_paths": sorted(touched_paths),
                "sync_result": sync_result,
            }
            self._last_status["last_result"] = result
            self._last_status["last_error"] = ""
            self._last_status["last_success_at"] = started_at
            return result

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()

    def _state_path(self) -> Path:
        return self._workspace_dir / "state" / "memory-maintenance.json"

    def _load_state(self) -> dict[str, Any]:
        path = self._state_path()
        if not path.exists():
            return {"version": 1, "files": {}, "last_run_at": "", "last_success_at": "", "last_error": ""}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"version": 1, "files": {}, "last_run_at": "", "last_success_at": "", "last_error": ""}

    def _save_state(self, state: dict[str, Any]) -> None:
        path = self._state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _collect_pending_batch(self, state: dict[str, Any]) -> PendingBatch:
        files_state: dict[str, Any] = state.setdefault("files", {})
        events: list[PendingEvent] = []
        scan_end: dict[str, int] = {}
        total_entries: dict[str, int] = {}

        session_files = sorted(self._sessions_dir.glob("*.jsonl"))
        for path in session_files:
            file_name = path.name
            session_key = self._session_key_from_file_name(file_name)
            chat_id = self._chat_id_from_session_key(session_key)
            try:
                raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:
                continue

            last_line = int((files_state.get(file_name) or {}).get("last_line", 0))
            if last_line > len(raw_lines):
                last_line = max(0, len(raw_lines) - DEFAULT_INITIAL_TAIL_LINES)
            elif last_line == 0 and len(raw_lines) > DEFAULT_INITIAL_TAIL_LINES:
                last_line = len(raw_lines) - DEFAULT_INITIAL_TAIL_LINES

            scan_end[file_name] = len(raw_lines)
            total_entries[file_name] = 0
            if file_name.endswith(".full.jsonl"):
                parsed = self._parse_full_lines(
                    file_name=file_name,
                    raw_lines=raw_lines,
                    start_line=last_line + 1,
                    session_key=session_key,
                    chat_id=chat_id,
                )
            else:
                parsed = self._parse_main_lines(
                    file_name=file_name,
                    raw_lines=raw_lines,
                    start_line=last_line + 1,
                    session_key=session_key,
                    chat_id=chat_id,
                )

            for event in parsed:
                total_entries[file_name] += 1
                events.append(event)

        if len(events) > self._max_events_per_run:
            events = events[: self._max_events_per_run]
        return PendingBatch(events=events, scan_end=scan_end, total_entries=total_entries)

    def _parse_main_lines(
        self,
        *,
        file_name: str,
        raw_lines: list[str],
        start_line: int,
        session_key: str,
        chat_id: int,
    ) -> list[PendingEvent]:
        out: list[PendingEvent] = []
        for idx in range(max(1, int(start_line)), len(raw_lines) + 1):
            raw = raw_lines[idx - 1].strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            message = parsed.get("message")
            if not isinstance(message, dict):
                continue
            content = self._flatten_content(message.get("content"))
            if not content:
                continue
            payload = {
                "source_file": file_name,
                "line": idx,
                "source_session_key": session_key,
                "chat_id": chat_id,
                "timestamp": str(parsed.get("timestamp") or ""),
                "event_type": "chat_message",
                "role": str(message.get("role") or ""),
                "content": content,
            }
            out.append(
                PendingEvent(
                    file_name=file_name,
                    line=idx,
                    session_key=session_key,
                    chat_id=chat_id,
                    payload=payload,
                )
            )
        return out

    def _parse_full_lines(
        self,
        *,
        file_name: str,
        raw_lines: list[str],
        start_line: int,
        session_key: str,
        chat_id: int,
    ) -> list[PendingEvent]:
        out: list[PendingEvent] = []
        for idx in range(max(1, int(start_line)), len(raw_lines) + 1):
            raw = raw_lines[idx - 1].strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            message = parsed.get("message")
            if not isinstance(message, dict):
                continue

            tool_calls = message.get("tool_calls")
            tool_results = message.get("tool_results")
            if not tool_calls and not tool_results:
                continue

            payload: dict[str, Any] = {
                "source_file": file_name,
                "line": idx,
                "source_session_key": session_key,
                "chat_id": chat_id,
                "timestamp": str(parsed.get("timestamp") or ""),
                "event_type": "tool_trace",
                "role": str(message.get("role") or ""),
            }
            content = self._flatten_content(message.get("content"))
            if content:
                payload["content"] = content
            if isinstance(tool_calls, list):
                payload["tool_calls"] = [
                    {
                        "id": str(item.get("id") or ""),
                        "name": str(item.get("name") or ""),
                        "arguments": dict(item.get("arguments") or {}),
                    }
                    for item in tool_calls
                    if isinstance(item, dict)
                ]
            if isinstance(tool_results, list):
                payload["tool_results"] = [
                    {
                        "tool_call_id": str(item.get("tool_call_id") or ""),
                        "is_error": bool(item.get("is_error")),
                        "content": self._trim_tool_result(str(item.get("content") or "")),
                    }
                    for item in tool_results
                    if isinstance(item, dict)
                ]
            out.append(
                PendingEvent(
                    file_name=file_name,
                    line=idx,
                    session_key=session_key,
                    chat_id=chat_id,
                    payload=payload,
                )
            )
        return out

    @staticmethod
    def _flatten_content(content: Any) -> str:
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    text = item.strip()
                    if text:
                        parts.append(text)
                    continue
                if not isinstance(item, dict):
                    text = str(item).strip()
                    if text:
                        parts.append(text)
                    continue
                item_type = str(item.get("type") or "").strip().lower()
                if item_type == "text":
                    text = str(item.get("text") or "").strip()
                    if text:
                        parts.append(text)
                    continue
                if item_type == "image":
                    path = str(item.get("path") or "").strip()
                    mime = str(item.get("mime_type") or "image/jpeg").strip()
                    label = f"[image mime={mime}"
                    if path:
                        label += f" path={path}"
                    label += "]"
                    parts.append(label)
                    continue
                text = str(item.get("text") or "").strip()
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        return str(content or "").strip()

    @staticmethod
    def _trim_tool_result(content: str) -> str:
        cleaned = str(content or "").strip()
        if len(cleaned) <= DEFAULT_TOOL_RESULT_CHAR_LIMIT:
            return cleaned
        return cleaned[:DEFAULT_TOOL_RESULT_CHAR_LIMIT].rstrip() + "\n[TRUNCATED]"

    @staticmethod
    def _session_key_from_file_name(file_name: str) -> str:
        if file_name.endswith(".full.jsonl"):
            stem = file_name[: -len(".full.jsonl")]
        elif file_name.endswith(".jsonl"):
            stem = file_name[: -len(".jsonl")]
        else:
            stem = file_name
        parts = stem.split("_", 2)
        if len(parts) == 3:
            return f"{parts[0]}:{parts[1]}:{parts[2]}"
        return stem

    @staticmethod
    def _chat_id_from_session_key(session_key: str) -> int:
        raw = str(session_key or "")
        if ":" in raw:
            raw = raw.split(":", 2)[-1]
        base, _, _ = raw.partition("__")
        try:
            return int(base)
        except Exception:
            return 0

    async def _extract(self, *, provider: BaseProvider, events: list[dict[str, Any]]) -> ChatResponse:
        system = (
            "You are Drost memory extraction. Output ONLY valid JSON. No markdown.\n\n"
            "Goal: convert fresh transcript events into durable memory.\n"
            "Return an object with exactly six keys:\n"
            '  \"daily_notes\": list of {\"date\": \"YYYY-MM-DD\", \"bullets\": [\"...\"]}\n'
            '  \"entities\": list of {\"entity_type\": \"...\", \"entity_name\": \"...\", \"summary_hint\": \"optional\"}\n'
            '  \"aliases\": list of {\"entity_type\": \"...\", \"entity_name\": \"...\", \"alias\": \"...\"}\n'
            '  \"facts\": list of {\"entity_type\": \"...\", \"entity_name\": \"...\", \"kind\": \"...\", '
            '"fact\": \"...\", \"date\": \"YYYY-MM-DD\", \"confidence\": 0.0, \"source\": \"file:line\", '
            '"supersedes\": \"optional\"}\n'
            '  \"relations\": list of {\"from_entity_type\": \"...\", \"from_entity_name\": \"...\", '
            '"relation_type\": \"...\", \"to_entity_type\": \"...\", \"to_entity_name\": \"...\", '
            '"statement\": \"...\", \"date\": \"YYYY-MM-DD\", \"confidence\": 0.0, \"source\": \"file:line\", '
            '"supersedes\": \"optional\"}\n'
            '  \"follow_ups\": list of {\"kind\": \"...\", \"subject\": \"...\", '
            '"entity_refs\": [\"entity_type/entity_name\"], \"source\": \"file:line\", \"source_session_key\": \"optional\", '
            '"source_excerpt\": \"...\", \"follow_up_prompt\": \"...\", \"due_at\": \"ISO-8601 UTC\", '
            '"not_before\": \"optional ISO-8601 UTC\", \"priority\": \"high|medium|low\", \"confidence\": 0.0, '
            '"notes\": \"optional\"}\n\n'
            "Rules:\n"
            "- Extract only useful durable information.\n"
            "- Daily notes should capture meaningful recent context, decisions, and work.\n"
            "- Facts should be atomic and plain-language.\n"
            "- Entity names should be human-readable, not slugified ids.\n"
            "- Aliases should only be written when they add useful alternate surfaces.\n"
            "- Relations should be typed and concrete.\n"
            "- Follow-ups should only be included when there is a concrete future check-in or obligation.\n"
            "- Follow-up prompts should be natural, concise, and specific.\n"
            "- Do not create vague social check-ins with no concrete reason.\n"
            "- Do not include secrets, tokens, passwords, or API keys.\n"
            "- Prefer these entity types when possible: "
            + ", ".join(DEFAULT_ENTITY_TYPES)
            + ".\n"
            "- If nothing worth storing exists, return empty lists.\n"
        )
        user = json.dumps(
            {
                "workspace": str(self._workspace_dir),
                "events": events,
            },
            ensure_ascii=False,
        )
        return await provider.chat(
            messages=[Message(role=MessageRole.USER, content=user)],
            system=system,
            max_tokens=2500,
            temperature=0,
        )

    @staticmethod
    def _parse_payload(response: ChatResponse) -> dict[str, Any] | None:
        raw = str(response.message.content or "").strip()
        if not raw:
            return None
        raw = _JSON_FENCE_RE.sub("", raw).strip()
        try:
            payload = json.loads(raw)
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        payload.setdefault("daily_notes", [])
        payload.setdefault("entities", [])
        payload.setdefault("aliases", [])
        payload.setdefault("facts", [])
        payload.setdefault("relations", [])
        payload.setdefault("follow_ups", [])
        return payload

    def _write_daily_notes(self, daily_notes: Any) -> tuple[int, set[Path]]:
        if not isinstance(daily_notes, list):
            return 0, set()
        count = 0
        touched: set[Path] = set()
        for item in daily_notes:
            if not isinstance(item, dict):
                continue
            bullets = item.get("bullets")
            if not isinstance(bullets, list):
                continue
            path = self._memory_files.append_daily_bullets(
                [str(b).strip() for b in bullets if str(b).strip()],
                day=str(item.get("date") or "").strip() or None,
            )
            cleaned = [str(b).strip() for b in bullets if str(b).strip()]
            if cleaned:
                count += len(cleaned)
                touched.add(path)
        return count, touched

    @staticmethod
    def _resolve_item_name(item: dict[str, Any], *keys: str) -> str:
        for key in keys:
            value = str(item.get(key) or "").strip()
            if value:
                return value
        return ""

    def _register_entities(self, entities: Any, *, resolver: EntityResolver) -> None:
        if not isinstance(entities, list):
            return
        for item in entities:
            if not isinstance(item, dict):
                continue
            entity_type = str(item.get("entity_type") or "").strip()
            entity_name = self._resolve_item_name(item, "entity_name", "entity_id")
            resolved = resolver.resolve(entity_type=entity_type, entity_name=entity_name)
            if resolved is not None:
                resolver.register_alias(resolved, entity_name)

    def _write_aliases(self, aliases: Any, *, resolver: EntityResolver) -> tuple[int, set[Path]]:
        if not isinstance(aliases, list):
            return 0, set()
        count = 0
        touched: set[Path] = set()
        for item in aliases:
            if not isinstance(item, dict):
                continue
            entity_type = str(item.get("entity_type") or "").strip()
            entity_name = self._resolve_item_name(item, "entity_name", "entity_id")
            alias = str(item.get("alias") or "").strip()
            resolved = resolver.resolve(entity_type=entity_type, entity_name=entity_name)
            if resolved is None or not alias:
                continue
            result = self._memory_files.append_entity_alias(
                entity_type=resolved.entity_type,
                entity_id=resolved.entity_id,
                alias=alias,
            )
            resolver.register_alias(
                EntityRef(entity_type=resolved.entity_type, entity_id=resolved.entity_id),
                alias,
            )
            if result.created:
                count += 1
                touched.add(result.path)
        return count, touched

    def _write_facts(self, facts: Any, *, resolver: EntityResolver) -> tuple[int, set[Path], set[EntityRef]]:
        if not isinstance(facts, list):
            return 0, set(), set()
        count = 0
        touched: set[Path] = set()
        entities: set[EntityRef] = set()
        for item in facts:
            if not isinstance(item, dict):
                continue
            entity_type = str(item.get("entity_type") or "").strip()
            entity_name = self._resolve_item_name(item, "entity_name", "entity_id")
            fact_text = str(item.get("fact") or "").strip()
            resolved = resolver.resolve(entity_type=entity_type, entity_name=entity_name)
            if resolved is None or not fact_text:
                continue
            try:
                confidence = float(item["confidence"]) if item.get("confidence") is not None else None
            except Exception:
                confidence = None
            result = self._memory_files.append_entity_fact(
                entity_type=resolved.entity_type,
                entity_id=resolved.entity_id,
                fact=fact_text,
                kind=str(item.get("kind") or "fact").strip() or "fact",
                fact_date=str(item.get("date") or "").strip() or None,
                confidence=confidence,
                source=str(item.get("source") or "").strip() or None,
                supersedes=str(item.get("supersedes") or "").strip() or None,
            )
            if result.created:
                count += 1
                touched.add(result.path)
                entities.add(EntityRef(entity_type=result.entity_type, entity_id=result.entity_id))
        return count, touched, entities

    def _write_relations(
        self,
        relations: Any,
        *,
        resolver: EntityResolver,
    ) -> tuple[int, set[Path], set[EntityRef]]:
        if not isinstance(relations, list):
            return 0, set(), set()
        count = 0
        touched: set[Path] = set()
        entities: set[EntityRef] = set()
        for item in relations:
            if not isinstance(item, dict):
                continue
            from_entity_type = str(item.get("from_entity_type") or "").strip()
            from_entity_name = self._resolve_item_name(item, "from_entity_name", "from_entity_id")
            to_entity_type = str(item.get("to_entity_type") or "").strip()
            to_entity_name = self._resolve_item_name(item, "to_entity_name", "to_entity_id")
            relation_type = str(item.get("relation_type") or "").strip()
            statement = str(item.get("statement") or item.get("fact") or "").strip()
            if not from_entity_type or not to_entity_type or not relation_type or not statement:
                continue

            from_resolved = resolver.resolve(entity_type=from_entity_type, entity_name=from_entity_name)
            to_resolved = resolver.resolve(entity_type=to_entity_type, entity_name=to_entity_name)
            if from_resolved is None or to_resolved is None:
                continue

            try:
                confidence = float(item["confidence"]) if item.get("confidence") is not None else None
            except Exception:
                confidence = None

            result = self._memory_files.append_entity_relation(
                from_entity_type=from_resolved.entity_type,
                from_entity_id=from_resolved.entity_id,
                relation_type=relation_type,
                to_entity_type=to_resolved.entity_type,
                to_entity_id=to_resolved.entity_id,
                statement=statement,
                relation_date=str(item.get("date") or "").strip() or None,
                confidence=confidence,
                source=str(item.get("source") or "").strip() or None,
                supersedes=str(item.get("supersedes") or "").strip() or None,
            )
            if result.created:
                count += 1
                touched.add(result.path)
                entities.add(EntityRef(entity_type=result.from_entity_type, entity_id=result.from_entity_id))
        return count, touched, entities

    @staticmethod
    def _resolve_entity_ref_value(value: Any, *, resolver: EntityResolver) -> str | None:
        cleaned = str(value or "").strip()
        if not cleaned or "/" not in cleaned:
            return None
        entity_type, entity_name = cleaned.split("/", 1)
        resolved = resolver.resolve(entity_type=entity_type, entity_name=entity_name)
        if resolved is None:
            return None
        return f"{resolved.entity_type}/{resolved.entity_id}"

    def _write_followups(
        self,
        follow_ups: Any,
        *,
        resolver: EntityResolver,
        events: list[PendingEvent],
    ) -> tuple[int, set[Path]]:
        if not self._followups_enabled or self._followups is None or not isinstance(follow_ups, list):
            return 0, set()

        source_lookup = {
            f"{event.file_name}:{event.line}": {
                "session_key": event.session_key,
                "chat_id": event.chat_id,
            }
            for event in events
        }
        count = 0
        touched: set[Path] = set()
        for item in follow_ups:
            if not isinstance(item, dict):
                continue
            subject = str(item.get("subject") or "").strip()
            prompt = str(item.get("follow_up_prompt") or "").strip()
            due_at = str(item.get("due_at") or "").strip()
            source = str(item.get("source") or "").strip()
            source_meta = source_lookup.get(source, {})
            source_session_key = str(item.get("source_session_key") or source_meta.get("session_key") or "").strip()
            chat_id = int(item.get("chat_id") or source_meta.get("chat_id") or 0)
            if not source_session_key:
                continue
            if chat_id <= 0:
                chat_id = self._chat_id_from_session_key(source_session_key)
            if chat_id <= 0 or not subject or not prompt or not due_at:
                continue
            try:
                confidence = float(item["confidence"]) if item.get("confidence") is not None else None
            except Exception:
                confidence = None
            if confidence is not None and confidence < self._followup_confidence_threshold:
                continue

            entity_refs: list[str] = []
            for raw_ref in item.get("entity_refs") or []:
                resolved_ref = self._resolve_entity_ref_value(raw_ref, resolver=resolver)
                if resolved_ref and resolved_ref not in entity_refs:
                    entity_refs.append(resolved_ref)

            try:
                _, created = self._followups.upsert_extracted_followup(
                    chat_id=chat_id,
                    source_session_key=source_session_key,
                    kind=str(item.get("kind") or "check_in").strip() or "check_in",
                    subject=subject,
                    entity_refs=entity_refs,
                    source_excerpt=str(item.get("source_excerpt") or "").strip(),
                    follow_up_prompt=prompt,
                    due_at=due_at,
                    not_before=str(item.get("not_before") or "").strip() or None,
                    priority=str(item.get("priority") or "medium").strip() or "medium",
                    confidence=confidence,
                    notes=str(item.get("notes") or "").strip() or None,
                    source=source or None,
                )
            except Exception:
                logger.debug("Skipping invalid follow-up payload", exc_info=True)
                continue

            touched.add(self._followups.followups_path)
            if created:
                count += 1
        return count, touched

    async def _synthesize_entities(
        self,
        *,
        provider: BaseProvider,
        entities: set[EntityRef],
        state: dict[str, Any],
    ) -> tuple[int, set[Path]]:
        if not self._entity_synthesis_enabled or not entities:
            return 0, set()

        synthesis_state = state.setdefault("synthesis", {})
        entity_state = synthesis_state.setdefault("entities", {})
        written = 0
        touched: set[Path] = set()

        for entity in sorted(entities, key=lambda item: (item.entity_type, item.entity_id)):
            items_path = self._memory_files.entity_items_path(entity.entity_type, entity.entity_id)
            if not items_path.exists():
                continue
            try:
                items_text = items_path.read_text(encoding="utf-8")
            except Exception:
                continue
            if not items_text.strip():
                continue

            summary_path = self._memory_files.entity_summary_path(entity.entity_type, entity.entity_id)
            aliases_path = self._memory_files.entity_aliases_path(entity.entity_type, entity.entity_id)
            relations_path = self._memory_files.entity_relations_path(entity.entity_type, entity.entity_id)
            prior_summary = ""
            if summary_path.exists():
                prior_summary = summary_path.read_text(encoding="utf-8", errors="replace")
            aliases_text = ""
            if aliases_path.exists():
                aliases_text = aliases_path.read_text(encoding="utf-8", errors="replace")
            relations_text = ""
            if relations_path.exists():
                relations_text = relations_path.read_text(encoding="utf-8", errors="replace")

            content = await self._generate_entity_summary(
                provider=provider,
                entity_type=entity.entity_type,
                entity_id=entity.entity_id,
                items_text=items_text,
                aliases_text=aliases_text,
                relations_text=relations_text,
                prior_summary=prior_summary,
            )
            if not content:
                continue

            path = self._memory_files.write_entity_summary(
                entity_type=entity.entity_type,
                entity_id=entity.entity_id,
                summary=content,
            )
            touched.add(path)
            written += 1
            entity_state[f"{entity.entity_type}/{entity.entity_id}"] = {
                "last_summary_at": self._utc_now(),
                "items_mtime": datetime.fromtimestamp(items_path.stat().st_mtime, tz=UTC).isoformat(),
            }
        return written, touched

    async def _generate_entity_summary(
        self,
        *,
        provider: BaseProvider,
        entity_type: str,
        entity_id: str,
        items_text: str,
        aliases_text: str,
        relations_text: str,
        prior_summary: str,
    ) -> str:
        system = (
            "You are Drost entity memory synthesis. Output ONLY markdown for summary.md.\n"
            "Keep it concise, current, and high-signal.\n"
            "Do not use code fences.\n"
            "Do not dump the raw fact list back verbatim.\n"
            "Use relationship context when it materially clarifies what this entity is, how it is used, or who it is connected to.\n"
        )
        user = json.dumps(
            {
                "entity_type": entity_type,
                "entity_id": entity_id,
                "prior_summary": prior_summary,
                "items_md": items_text[-12000:],
                "aliases_md": aliases_text[-4000:],
                "relations_md": relations_text[-8000:],
            },
            ensure_ascii=False,
        )
        try:
            response = await provider.chat(
                messages=[Message(role=MessageRole.USER, content=user)],
                system=system,
                max_tokens=1200,
                temperature=0,
            )
        except Exception:
            logger.warning("Entity summary synthesis failed for %s/%s", entity_type, entity_id, exc_info=True)
            return ""
        content = str(response.message.content or "").strip()
        if not content:
            return ""
        return _JSON_FENCE_RE.sub("", content).strip()

    def _advance_state(self, state: dict[str, Any], *, batch: PendingBatch, processed: list[PendingEvent]) -> bool:
        files_state: dict[str, Any] = state.setdefault("files", {})
        processed_counts: dict[str, int] = defaultdict(int)
        last_processed_line: dict[str, int] = {}
        for event in processed:
            processed_counts[event.file_name] += 1
            last_processed_line[event.file_name] = max(last_processed_line.get(event.file_name, 0), event.line)

        changed = False
        for file_name, scan_end in batch.scan_end.items():
            total_entries = int(batch.total_entries.get(file_name, 0))
            processed_count = int(processed_counts.get(file_name, 0))
            current = int((files_state.get(file_name) or {}).get("last_line", 0))

            if total_entries == 0:
                new_value = scan_end
            elif processed_count == 0:
                continue
            elif processed_count >= total_entries:
                new_value = scan_end
            else:
                new_value = int(last_processed_line.get(file_name, current))

            if new_value > current:
                files_state[file_name] = {"last_line": new_value}
                changed = True
        return changed
