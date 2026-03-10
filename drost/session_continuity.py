from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.loop_events import LoopEventBus
from drost.providers import BaseProvider, Message, MessageRole
from drost.storage import SQLiteStore, session_key_to_filename

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM_PROMPT = """You are generating a continuity handoff between two Drost chat sessions.

Write a factual, bounded carryover summary for the new session.

Requirements:
1. Preserve concrete facts, decisions, constraints, and preferences.
2. Capture completed work and concrete artifacts when present.
3. Capture unresolved work and the most important next actions.
4. Do not invent facts not present in the source material.
5. Use this exact Markdown structure:

## Session Continuity
### Core Objective
...
### Decisions And Constraints
...
### Work Completed
...
### Open Threads
...
### Suggested Next Actions
...
"""


@dataclass(slots=True)
class ContinuityJobRequest:
    chat_id: int
    from_session_id: str
    from_session_key: str
    to_session_id: str
    to_session_key: str


class SessionContinuityManager:
    def __init__(
        self,
        *,
        store: SQLiteStore,
        sessions_dir: Path,
        provider_getter: Callable[[], BaseProvider],
        embed_document: Callable[..., Awaitable[list[float]]] | None = None,
        event_bus: LoopEventBus | None = None,
        enabled: bool,
        auto_on_new: bool = True,
        source_max_messages: int = 120,
        source_max_chars: int = 40_000,
        summary_max_tokens: int = 1_500,
        summary_max_chars: int = 12_000,
        max_parallel_jobs: int = 2,
    ) -> None:
        self._store = store
        self._sessions_dir = Path(sessions_dir).expanduser()
        self._provider_getter = provider_getter
        self._embed_document = embed_document
        self._event_bus = event_bus
        self._enabled = bool(enabled)
        self._auto_on_new = bool(auto_on_new)
        self._source_max_messages = max(10, int(source_max_messages))
        self._source_max_chars = max(4_000, int(source_max_chars))
        self._summary_max_tokens = max(256, int(summary_max_tokens))
        self._summary_max_chars = max(1_000, int(summary_max_chars))
        self._semaphore = asyncio.Semaphore(max(1, int(max_parallel_jobs)))
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._tasks_lock = asyncio.Lock()
        self._completed_jobs = 0
        self._failed_jobs = 0
        self._last_error = ""
        self._last_completed_at = ""

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "auto_on_new": self._auto_on_new,
            "active_jobs": len(self._tasks),
            "completed_jobs": int(self._completed_jobs),
            "failed_jobs": int(self._failed_jobs),
            "last_error": self._last_error,
            "last_completed_at": self._last_completed_at,
        }

    async def schedule(self, req: ContinuityJobRequest) -> dict[str, Any]:
        if not self._enabled or not self._auto_on_new:
            return {"queued": False, "message": "Continuity skipped (disabled)."}
        if req.from_session_key == req.to_session_key:
            return {"queued": False, "message": "Continuity skipped (same session)."}

        source_messages = self._store.read_history(req.from_session_key, limit=self._source_max_messages)
        if not self._filter_source_messages(source_messages):
            return {"queued": False, "message": "Continuity skipped (no prior messages)."}

        job_id = f"cont-{uuid.uuid4().hex[:10]}"
        task = asyncio.create_task(self._run_job(job_id=job_id, req=req))
        async with self._tasks_lock:
            self._tasks[job_id] = task
        return {
            "queued": True,
            "job_id": job_id,
            "message": f"Continuity queued from {req.from_session_id} to {req.to_session_id}.",
        }

    async def shutdown(self) -> None:
        async with self._tasks_lock:
            tasks = list(self._tasks.values())
            self._tasks.clear()
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def wait_for_idle(self, *, timeout_seconds: float = 5.0) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.1, float(timeout_seconds))
        while True:
            async with self._tasks_lock:
                tasks = list(self._tasks.values())
            if not tasks:
                return
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            done, pending = await asyncio.wait(tasks, timeout=remaining)
            if pending:
                return
            _ = done

    async def _run_job(self, *, job_id: str, req: ContinuityJobRequest) -> None:
        try:
            async with self._semaphore:
                summary = await self._generate_summary(req)
                if not summary:
                    raise RuntimeError("empty summary returned")
                self._store.set_session_continuity(
                    to_session_key=req.to_session_key,
                    from_session_key=req.from_session_key,
                    from_session_id=req.from_session_id,
                    summary=summary[: self._summary_max_chars],
                )
                embedding: list[float] = []
                if self._embed_document is not None:
                    try:
                        embedding = await self._embed_document(
                            summary,
                            title=f"continuity/{req.from_session_id}",
                        )
                    except Exception:
                        logger.warning("Continuity embedding failed; storing keyword-only continuity row", exc_info=True)
                self._store.replace_session_continuity_memory(
                    to_session_key=req.to_session_key,
                    from_session_key=req.from_session_key,
                    from_session_id=req.from_session_id,
                    summary=summary[: self._summary_max_chars],
                    embedding=embedding,
                )
                if self._event_bus is not None:
                    self._event_bus.emit(
                        "continuity_written",
                        scope={
                            "chat_id": int(req.chat_id),
                            "session_key": req.to_session_key,
                        },
                        payload={
                            "from_session_key": req.from_session_key,
                            "to_session_key": req.to_session_key,
                            "from_session_id": req.from_session_id,
                            "to_session_id": req.to_session_id,
                            "summary_chars": len(summary[: self._summary_max_chars]),
                        },
                    )
                self._completed_jobs += 1
                self._last_completed_at = datetime.now(UTC).isoformat()
                logger.info(
                    "Continuity summary completed job=%s from=%s to=%s",
                    job_id,
                    req.from_session_id,
                    req.to_session_id,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._failed_jobs += 1
            self._last_error = str(exc)
            logger.warning(
                "Continuity summary failed job=%s from=%s to=%s: %s",
                job_id,
                req.from_session_id,
                req.to_session_id,
                exc,
            )
        finally:
            async with self._tasks_lock:
                self._tasks.pop(job_id, None)

    async def _generate_summary(self, req: ContinuityJobRequest) -> str:
        history = self._filter_source_messages(
            self._store.read_history(req.from_session_key, limit=self._source_max_messages)
        )
        if not history:
            return ""

        transcript = self._format_messages(history)
        tool_artifacts = self._load_tool_artifacts(req.from_session_key)
        graph_context = self._load_graph_context(transcript=transcript, tool_artifacts=tool_artifacts)

        sections = [
            f"Source session: {req.from_session_id}",
            "[Narrative Transcript]",
            transcript,
        ]
        if tool_artifacts:
            sections.extend(["[Tool Artifacts]", tool_artifacts])
        if graph_context:
            sections.extend(["[Graph Context]", graph_context])
        prompt = "\n\n".join(section for section in sections if section).strip()
        if len(prompt) > self._source_max_chars:
            prompt = prompt[-self._source_max_chars :]

        provider = self._provider_getter()
        response = await provider.chat(
            messages=[Message(role=MessageRole.USER, content=prompt)],
            system=SUMMARY_SYSTEM_PROMPT,
            max_tokens=self._summary_max_tokens,
        )
        return str(response.message.content or "").strip()[: self._summary_max_chars]

    def _load_graph_context(self, *, transcript: str, tool_artifacts: str) -> str:
        source_text = "\n".join(part for part in [transcript, tool_artifacts] if part).strip()
        if not source_text:
            return ""

        matched_entities = self._store.find_entities_in_text_by_alias(source_text, limit=2)
        if not matched_entities:
            return ""

        lines: list[str] = []
        relation_budget = 4
        for entity in matched_entities:
            entity_type = str(entity.get("entity_type") or "").strip()
            entity_id = str(entity.get("entity_id") or "").strip()
            title = str(entity.get("title") or f"{entity_type}/{entity_id}").strip()
            summary_row = self._store.get_entity_summary_memory(entity_type, entity_id)
            if summary_row is not None:
                summary_text = str(summary_row.get("content") or summary_row.get("snippet") or "").strip()
                if summary_text:
                    lines.append(f"### {title}")
                    lines.append(summary_text)

            if relation_budget <= 0:
                continue
            neighbors = self._store.list_entity_neighbors(entity_type, entity_id, limit=relation_budget)
            for neighbor in neighbors:
                relation = neighbor.get("relation")
                if not isinstance(relation, dict):
                    continue
                relation_text = str(relation.get("relation_text") or "").strip()
                if not relation_text:
                    continue
                relation_type = str(relation.get("relation_type") or "").strip()
                to_ref = (
                    f"{relation.get('to_entity_type')}/{relation.get('to_entity_id')}"
                )
                lines.append(f"- {title} {relation_type} {to_ref}: {relation_text}")
                relation_budget -= 1
                if relation_budget <= 0:
                    break

        return "\n".join(line for line in lines if line).strip()

    def _load_tool_artifacts(self, session_key: str) -> str:
        path = self._sessions_dir / f"{session_key_to_filename(session_key)}.full.jsonl"
        if not path.exists() or not path.is_file():
            return ""

        rows = self._read_jsonl_tail(path, max_lines=max(20, self._source_max_messages * 3))
        lines: list[str] = []
        for entry in rows:
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "").strip().lower()
            if role == "assistant":
                content = self._flatten_content(message.get("content"))
                if content:
                    lines.append(f"[assistant] {content}")
                for tool_call in message.get("tool_calls") or []:
                    if not isinstance(tool_call, dict):
                        continue
                    name = str(tool_call.get("name") or "").strip()
                    arguments = tool_call.get("arguments")
                    arg_text = ""
                    if isinstance(arguments, dict) and arguments:
                        arg_text = json.dumps(arguments, ensure_ascii=False, sort_keys=True)
                    if name:
                        suffix = f" args={arg_text}" if arg_text else ""
                        lines.append(f"[tool_call] {name}{suffix}")
            elif role == "tool":
                for tool_result in message.get("tool_results") or []:
                    if not isinstance(tool_result, dict):
                        continue
                    content = str(tool_result.get("content") or "").strip()
                    if not content:
                        continue
                    call_id = str(tool_result.get("tool_call_id") or "").strip()
                    prefix = f"[tool_result call_id={call_id}]" if call_id else "[tool_result]"
                    lines.append(f"{prefix} {content}")
        if not lines:
            return ""
        joined = "\n".join(lines)
        if len(joined) > self._source_max_chars // 2:
            joined = joined[-(self._source_max_chars // 2) :]
        return joined

    @staticmethod
    def _read_jsonl_tail(path: Path, *, max_lines: int) -> list[dict[str, Any]]:
        tail: deque[str] = deque(maxlen=max(1, int(max_lines)))
        try:
            with path.open(encoding="utf-8") as f:
                for line in f:
                    raw = line.strip()
                    if raw:
                        tail.append(raw)
        except OSError:
            return []

        out: list[dict[str, Any]] = []
        for raw in tail:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
        return out

    @staticmethod
    def _filter_source_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for msg in messages:
            role = str(msg.get("role") or "").strip().lower()
            if role not in {"user", "assistant"}:
                continue
            content = SessionContinuityManager._flatten_content(msg.get("content"))
            if not content:
                continue
            out.append({"role": role, "content": content})
        return out

    @staticmethod
    def _flatten_content(content: Any) -> str:
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    value = item.strip()
                    if value:
                        parts.append(value)
                    continue
                if not isinstance(item, dict):
                    value = str(item).strip()
                    if value:
                        parts.append(value)
                    continue
                if item.get("type") == "text":
                    value = str(item.get("text") or "").strip()
                    if value:
                        parts.append(value)
                    continue
                if "text" in item:
                    value = str(item.get("text") or "").strip()
                    if value:
                        parts.append(value)
                    continue
                path = str(item.get("path") or "").strip()
                if item.get("type") == "image" and path:
                    parts.append(f"[image: {path}]")
            return "\n".join(parts).strip()
        return str(content).strip()

    @staticmethod
    def _format_messages(messages: list[dict[str, Any]]) -> str:
        rows: list[str] = []
        for msg in messages:
            role = str(msg.get("role") or "unknown").lower()
            content = str(msg.get("content") or "").strip()
            if not content:
                continue
            rows.append(f"[{role}] {content}")
        return "\n\n".join(rows)
