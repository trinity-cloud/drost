from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Any, Awaitable, Callable

from drost.agent_loop import DefaultSingleLoopRunner
from drost.config import Settings
from drost.context_budget import (
    should_compact_history,
    trim_history_to_budget,
    truncate_text_to_budget,
)
from drost.embeddings import EmbeddingService
from drost.prompt_assembly import PromptAssembler
from drost.providers import Message, MessageRole, ProviderRegistry
from drost.storage import SQLiteStore, SessionJSONLStore, session_key_for_telegram_chat
from drost.tools import build_default_registry

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are Drost, a pragmatic and reliable AI agent. "
    "Be concise, accurate, and explicit about uncertainty."
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
            role = str(item.get("role") or "")
            snippet = str(item.get("snippet") or item.get("content") or "").strip()
            if not snippet:
                continue
            lines.append(f"- ({role}) {snippet}")

        if len(lines) == 1:
            return ""
        return truncate_text_to_budget("\n".join(lines), self._settings.context_budget_memory_tokens)

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
        status_callback: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        normalized_sid = (session_id or "").strip()
        if normalized_sid == "legacy-main":
            normalized_sid = ""
        session_key = session_key_for_telegram_chat(chat_id, normalized_sid or None)

        lock = self._session_locks[session_key]
        async with lock:
            return await self._respond_locked(
                chat_id=chat_id,
                session_key=session_key,
                text=text,
                status_callback=status_callback,
            )

    async def _respond_locked(
        self,
        *,
        chat_id: int,
        session_key: str,
        text: str,
        status_callback: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        started = time.monotonic()
        query_text = (text or "").strip()
        if not query_text:
            return "Please send a message."

        provider = self._providers.get()

        query_embedding = [0.0] * self._embeddings.dimensions
        memories: list[dict[str, Any]] = []
        if self._settings.memory_enabled:
            query_embedding = await self._embeddings.embed_one(query_text)
            memories = self._store.search_memory(
                query_text=query_text,
                query_embedding=query_embedding,
                limit=self._settings.memory_top_k,
            )

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
        provider_messages.append(Message(role=MessageRole.USER, content=query_text))

        tool_registry = build_default_registry(
            settings=self._settings,
            store=self._store,
            embeddings=self._embeddings,
            current_chat_id=lambda: chat_id,
            current_session_key=lambda: session_key,
        )
        tool_names = tool_registry.names()
        memory_block = self._build_memory_block(memories)
        system_prompt = self._prompt_assembler.assemble(
            base_prompt=SYSTEM_PROMPT,
            memory_block=memory_block,
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

        # Persist JSONL transcript files for debugging parity with Morpheus patterns.
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
            self._store.add_memory(
                session_key=session_key,
                role="user",
                content=query_text,
                embedding=query_embedding,
            )
            assistant_embedding = await self._embeddings.embed_one(assistant_text)
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
