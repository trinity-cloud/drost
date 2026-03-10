from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

from drost.agent_loop import DefaultSingleLoopRunner, internal_loop_tool_names
from drost.config import Settings
from drost.context_budget import (
    should_compact_history,
    trim_history_to_budget,
    truncate_text_to_budget,
)
from drost.embeddings import EmbeddingService
from drost.memory_capsule import MemoryCapsuleBuilder
from drost.prompt_assembly import PromptAssembler
from drost.providers import Message, MessageRole, ProviderRegistry
from drost.storage import (
    SessionJSONLStore,
    SQLiteStore,
    WorkspaceMemoryIndexer,
    session_key_for_telegram_chat,
)
from drost.tools import build_default_registry

logger = logging.getLogger(__name__)

_ENTITY_PATH_RE = re.compile(r"memory/entities/([^/]+)/([^/]+)/")

SYSTEM_PROMPT = (
    "You are a personal AI agent running inside Drost. "
    "Be direct, rigorous, and explicit about uncertainty. "
    "Let the workspace context define your identity and relationship to the user."
)


class AgentRuntime:
    def __init__(
        self,
        *,
        settings: Settings,
        providers: ProviderRegistry,
        store: SQLiteStore,
        embeddings: EmbeddingService,
    ) -> None:
        self._settings = settings
        self._providers = providers
        self._store = store
        self._embeddings = embeddings
        self._session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._prompt_assembler = PromptAssembler(settings)
        self._session_jsonl = SessionJSONLStore(store_path=settings.workspace_dir / "sessions")
        self._workspace_memory_indexer = WorkspaceMemoryIndexer(
            workspace_dir=settings.workspace_dir,
            store=store,
            embeddings=embeddings,
        )
        self._memory_capsule_builder = MemoryCapsuleBuilder(settings)
        self._last_run: dict[str, Any] | None = None

    @property
    def active_provider(self) -> str:
        return self._providers.active_name

    def provider_names(self) -> list[str]:
        return self._providers.names()

    def set_provider(self, name: str) -> None:
        self._providers.set_active(name)

    def last_run_metadata(self) -> dict[str, Any] | None:
        if self._last_run is None:
            return None
        return dict(self._last_run)

    async def sync_memory_index(self) -> dict[str, int]:
        return await self._workspace_memory_indexer.sync()

    @staticmethod
    def _message_role(value: str) -> MessageRole:
        cleaned = (value or "").strip().lower()
        if cleaned == "assistant":
            return MessageRole.ASSISTANT
        if cleaned == "system":
            return MessageRole.SYSTEM
        if cleaned == "tool":
            return MessageRole.TOOL
        return MessageRole.USER

    def _build_memory_block(self, memories: list[dict[str, Any]]) -> str:
        if not memories:
            return ""

        lines = ["Relevant long-term memory excerpts:"]
        for item in memories:
            label = (
                str(item.get("title") or "").strip()
                or str(item.get("path") or "").strip()
                or str(item.get("session_key") or "").strip()
                or str(item.get("role") or "").strip()
            )
            snippet = str(item.get("snippet") or item.get("content") or "").strip()
            if not snippet:
                continue
            lines.append(f"- ({label}) {snippet}")

        if len(lines) == 1:
            return ""
        return truncate_text_to_budget("\n".join(lines), self._settings.context_budget_memory_tokens)

    def _load_continuity_summary(self, session_key: str) -> str:
        if not self._settings.memory_continuity_enabled:
            return ""
        if self._store.message_count(session_key) > self._settings.memory_continuity_inject_until_messages:
            return ""
        continuity = self._store.get_session_continuity(session_key)
        if not continuity:
            return ""
        return str(continuity.get("summary") or "").strip()

    @staticmethod
    def _extract_entity_ref(row: dict[str, Any]) -> tuple[str, str] | None:
        title = str(row.get("title") or "").strip()
        if "/" in title:
            parts = title.split("/", 1)
            entity_type = parts[0].strip()
            entity_id = parts[1].strip()
            if entity_type and entity_id:
                return entity_type, entity_id

        path = str(row.get("path") or "").strip()
        match = _ENTITY_PATH_RE.search(path)
        if match:
            return match.group(1).strip(), match.group(2).strip()
        return None

    def _gather_graph_candidates(
        self,
        *,
        query_text: str,
        memories: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        graph_candidates: list[dict[str, Any]] = []
        seen_paths: set[str] = {
            str(row.get("path") or "").strip()
            for row in memories
            if isinstance(row, dict) and str(row.get("path") or "").strip()
        }

        primary_entities: list[tuple[str, str]] = []
        seen_entities: set[tuple[str, str]] = set()

        for row in self._store.find_entities_in_text_by_alias(query_text, limit=2):
            key = (str(row.get("entity_type") or ""), str(row.get("entity_id") or ""))
            if key[0] and key[1] and key not in seen_entities:
                primary_entities.append(key)
                seen_entities.add(key)

        for row in memories:
            if len(primary_entities) >= 2:
                break
            if not isinstance(row, dict):
                continue
            source_kind = str(row.get("source_kind") or "").strip()
            if source_kind not in {"entity_summary", "entity_item", "entity_relation", "entity_alias"}:
                continue
            key = self._extract_entity_ref(row)
            if key is None or key in seen_entities:
                continue
            primary_entities.append(key)
            seen_entities.add(key)

        neighbors_loaded = 0
        for entity_type, entity_id in primary_entities[:2]:
            summary_row = self._store.get_entity_summary_memory(entity_type, entity_id)
            if summary_row is not None:
                summary_path = str(summary_row.get("path") or "").strip()
                if summary_path and summary_path not in seen_paths:
                    graph_candidates.append(
                        {
                            **summary_row,
                            "fused_score": float(summary_row.get("score") or 0.04),
                            "graph_seed": "entity_summary",
                        }
                    )
                    seen_paths.add(summary_path)

            for neighbor in self._store.list_entity_neighbors(entity_type, entity_id, limit=4):
                if neighbors_loaded >= 4:
                    break
                relation = neighbor.get("relation")
                if not isinstance(relation, dict):
                    continue
                relation_path = str(relation.get("path") or "").strip()
                graph_candidates.append(
                    {
                        "id": 0,
                        "session_key": "",
                        "role": "memory",
                        "content": str(relation.get("relation_text") or "").strip(),
                        "created_at": str(relation.get("updated_at") or ""),
                        "source_kind": "entity_relation",
                        "path": relation_path,
                        "line_start": int(relation.get("line_start") or 1),
                        "line_end": int(relation.get("line_end") or relation.get("line_start") or 1),
                        "title": f"{relation.get('from_entity_type')}/{relation.get('from_entity_id')}",
                        "updated_at": str(relation.get("updated_at") or ""),
                        "derived_from": str(relation.get("relation_id") or ""),
                        "content_hash": "",
                        "snippet": str(relation.get("relation_text") or "").strip(),
                        "fused_score": 0.03 + max(0.0, float(relation.get("confidence") or 0.0)) * 0.01,
                    }
                )
                neighbors_loaded += 1
                related_summary = neighbor.get("related_summary")
                if isinstance(related_summary, dict):
                    related_path = str(related_summary.get("path") or "").strip()
                    if related_path and related_path not in seen_paths:
                        graph_candidates.append(
                            {
                                **related_summary,
                                "fused_score": 0.02,
                                "graph_seed": "neighbor_summary",
                            }
                        )
                        seen_paths.add(related_path)
            if neighbors_loaded >= 4:
                break

        return graph_candidates

    async def _summarize_history(self, provider_name: str, history_rows: list[dict[str, Any]]) -> str:
        if not history_rows:
            return ""

        provider = self._providers.get(provider_name)
        transcript_lines: list[str] = []
        for row in history_rows:
            role = str(row.get("role") or "user")
            content = str(row.get("content") or "").strip()
            if not content:
                continue
            if len(content) > 1500:
                content = content[:1500].rstrip() + "..."
            transcript_lines.append(f"{role}: {content}")
        if not transcript_lines:
            return ""

        prompt = (
            "Summarize the following conversation so an assistant can continue seamlessly. "
            "Keep key decisions, facts, constraints, and open tasks. Avoid fluff.\n\n"
            + "\n".join(transcript_lines)
        )
        try:
            response = await provider.chat(
                messages=[Message(role=MessageRole.USER, content=prompt)],
                system="You create concise factual conversation summaries.",
                max_tokens=self._settings.history_compaction_summary_max_tokens,
            )
            return str(response.message.content or "").strip()
        except Exception:
            logger.warning("History compaction summary failed; falling back to truncation", exc_info=True)
            return ""

    async def _prepare_history(
        self,
        *,
        provider_name: str,
        history_rows: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], str]:
        history_budget = self._settings.context_budget_history_tokens
        trimmed = trim_history_to_budget(history_rows, history_budget)
        if not self._settings.history_compaction_enabled:
            return trimmed, ""

        if not should_compact_history(
            history_rows,
            history_budget_tokens=history_budget,
            trigger_ratio=self._settings.history_compaction_trigger_ratio,
        ):
            return trimmed, ""

        keep_recent = max(1, int(self._settings.history_compaction_keep_recent_messages))
        if len(history_rows) <= keep_recent:
            return trimmed, ""

        older = history_rows[:-keep_recent]
        recent = history_rows[-keep_recent:]
        summary = await self._summarize_history(provider_name, older)
        # If summary fails, we keep deterministic trimming behavior.
        return trim_history_to_budget(recent, history_budget), summary

    async def respond(
        self,
        *,
        chat_id: int,
        text: str,
        session_id: str | None,
        media: list[dict[str, Any]] | None = None,
        status_callback: Callable[[str], Awaitable[None]] | None = None,
        answer_stream_callback: Callable[[str | None], Awaitable[None]] | None = None,
    ) -> str:
        requested_sid = (session_id or "").strip()
        if requested_sid == "legacy-main":
            requested_sid = ""

        normalized_sid = requested_sid
        if not normalized_sid:
            # Auto-bootstrap a timestamped session for chats without an active session.
            bootstrap_key = session_key_for_telegram_chat(chat_id, None)
            bootstrap_lock = self._session_locks[bootstrap_key]
            async with bootstrap_lock:
                active_sid = (self._store.get_active_session_id(chat_id) or "").strip()
                if not active_sid or active_sid == "legacy-main":
                    active_sid = self._store.create_session(chat_id)
                normalized_sid = active_sid

        session_key = session_key_for_telegram_chat(chat_id, normalized_sid or None)

        lock = self._session_locks[session_key]
        async with lock:
            return await self._respond_locked(
                chat_id=chat_id,
                session_key=session_key,
                text=text,
                media=media,
                status_callback=status_callback,
                answer_stream_callback=answer_stream_callback,
            )

    @staticmethod
    def _normalize_media(media: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        if not media:
            return []
        out: list[dict[str, Any]] = []
        for item in media:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "").strip().lower() != "image":
                continue
            data = str(item.get("data") or "").strip()
            if not data:
                continue
            normalized = {
                "type": "image",
                "mime_type": str(item.get("mime_type") or "image/jpeg").strip() or "image/jpeg",
                "data": data,
            }
            path = str(item.get("path") or "").strip()
            if path:
                normalized["path"] = path
            out.append(normalized)
        return out

    @staticmethod
    def _build_user_message_content(query_text: str, media: list[dict[str, Any]]) -> str | list[dict[str, Any]]:
        if not media:
            return query_text
        text = query_text.strip() or "<media:image>\n\nI received an image. What should I do with it?"
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for item in media:
            part = {
                "type": "image",
                "mime_type": str(item.get("mime_type") or "image/jpeg"),
                "data": str(item.get("data") or ""),
            }
            path = str(item.get("path") or "").strip()
            if path:
                part["path"] = path
            parts.append(part)
        return parts

    async def _respond_locked(
        self,
        *,
        chat_id: int,
        session_key: str,
        text: str,
        media: list[dict[str, Any]] | None = None,
        status_callback: Callable[[str], Awaitable[None]] | None = None,
        answer_stream_callback: Callable[[str | None], Awaitable[None]] | None = None,
    ) -> str:
        started = time.monotonic()
        normalized_media = self._normalize_media(media)
        query_text = (text or "").strip()
        if not query_text and normalized_media:
            query_text = "<media:image>\n\nI received an image. What should I do with it?"
        if not query_text and not normalized_media:
            return "Please send a message."

        provider = self._providers.get()

        query_embedding = [0.0] * self._embeddings.dimensions
        memories: list[dict[str, Any]] = []
        memory_block = ""
        continuity_summary = self._load_continuity_summary(session_key)
        if self._settings.memory_enabled and query_text:
            await self._workspace_memory_indexer.sync()
            query_embedding = await self._embeddings.embed_query(query_text)
            memories = self._store.search_memory(
                query_text=query_text,
                query_embedding=query_embedding,
                limit=max(
                    int(self._settings.memory_top_k),
                    int(self._settings.memory_capsule_search_limit),
                ),
            )
            graph_candidates = self._gather_graph_candidates(
                query_text=query_text,
                memories=memories,
            )
            if graph_candidates:
                memories = memories + graph_candidates
            memory_block = self._memory_capsule_builder.build(
                query_text=query_text,
                candidates=memories,
                continuity_summary=continuity_summary,
            )
            if not memory_block:
                memory_block = self._build_memory_block(memories)

        raw_history_rows = self._store.read_history(
            session_key,
            limit=self._settings.session_history_limit,
        )
        history_rows, history_summary = await self._prepare_history(
            provider_name=provider.name,
            history_rows=raw_history_rows,
        )

        provider_messages: list[Message] = []
        for row in history_rows:
            provider_messages.append(
                Message(
                    role=self._message_role(str(row.get("role") or "user")),
                    content=str(row.get("content") or ""),
                )
            )
        turn_start_index = len(provider_messages)
        provider_messages.append(
            Message(
                role=MessageRole.USER,
                content=self._build_user_message_content(query_text, normalized_media),
            )
        )

        tool_registry = build_default_registry(
            settings=self._settings,
            store=self._store,
            embeddings=self._embeddings,
            workspace_memory_indexer=self._workspace_memory_indexer,
            current_chat_id=lambda: chat_id,
            current_session_key=lambda: session_key,
        )
        tool_names = list(dict.fromkeys([*tool_registry.names(), *internal_loop_tool_names()]))
        system_prompt = self._prompt_assembler.assemble(
            base_prompt=SYSTEM_PROMPT,
            memory_block=memory_block,
            continuity_summary="" if memory_block else continuity_summary,
            history_summary=history_summary,
            provider_name=provider.name,
            tool_names=tool_names,
        )

        assistant_text = ""
        try:
            runner = DefaultSingleLoopRunner(
                provider=provider,
                tool_registry=tool_registry,
                settings=self._settings,
            )
            run = await runner.run_turn(
                messages=provider_messages,
                system_prompt=system_prompt,
                status_callback=status_callback,
                answer_stream_callback=answer_stream_callback,
            )
            assistant_text = str(run.final_text or "").strip()
            if not assistant_text:
                # fallback to non-stream if the provider didn't emit deltas
                chat = await provider.chat(
                    provider_messages,
                    system=system_prompt,
                    tools=tool_registry.to_definitions(),
                )
                assistant_text = str(chat.message.content or "").strip()
        except Exception as exc:
            logger.exception("Provider request failed")
            assistant_text = f"Provider error: {exc}"

        if not assistant_text:
            assistant_text = "I don't have a response for that yet."

        duration_ms = int((time.monotonic() - started) * 1000)
        self._last_run = {
            "provider": provider.name,
            "model": provider.model,
            "chat_id": int(chat_id),
            "session_key": session_key,
            "duration_ms": duration_ms,
            "text_chars": len(assistant_text),
        }
        if "run" in locals():
            self._last_run.update(
                {
                    "run_id": run.run_id,
                    "iterations": int(run.iterations),
                    "tool_calls": int(run.tool_calls),
                    "usage": dict(run.usage or {}),
                    "stopped_by_limit": bool(run.stopped_by_limit),
                    "provider_error": str(run.provider_error or ""),
                    "run_duration_ms": int(run.duration_ms),
                }
            )
        logger.info(
            "Agent run complete provider=%s chat_id=%s session_key=%s iterations=%s tool_calls=%s duration_ms=%s",
            provider.name,
            chat_id,
            session_key,
            int((self._last_run or {}).get("iterations", 0)),
            int((self._last_run or {}).get("tool_calls", 0)),
            duration_ms,
        )

        # Persist session transcript.
        self._store.append_message(session_key, "user", query_text)
        self._store.append_message(session_key, "assistant", assistant_text)

        # Persist JSONL transcript files for debugging parity with reference implementation patterns.
        full_messages = list(provider_messages[turn_start_index:])
        if not full_messages:
            full_messages = [Message(role=MessageRole.USER, content=query_text)]
        last = full_messages[-1]
        last_content = str(last.content or "").strip() if last.role == MessageRole.ASSISTANT else ""
        if last.role != MessageRole.ASSISTANT or not last_content:
            full_messages.append(Message(role=MessageRole.ASSISTANT, content=assistant_text))
        self._session_jsonl.append_user_assistant(
            session_key=session_key,
            user_text=query_text,
            assistant_text=assistant_text,
        )
        self._session_jsonl.append_full_messages(
            session_key=session_key,
            messages=full_messages,
        )

        # Persist long-term memory.
        if self._settings.memory_enabled:
            user_embedding = await self._embeddings.embed_document(query_text)
            self._store.add_memory(
                session_key=session_key,
                role="user",
                content=query_text,
                embedding=user_embedding,
            )
            assistant_embedding = await self._embeddings.embed_document(assistant_text)
            self._store.add_memory(
                session_key=session_key,
                role="assistant",
                content=assistant_text,
                embedding=assistant_embedding,
            )

        return assistant_text

    async def close(self) -> None:
        await self._providers.close()
        await self._embeddings.close()
