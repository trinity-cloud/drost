from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.providers import Message, MessageRole, ProviderRegistry
from drost.storage import SQLiteStore, session_key_for_telegram_chat

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

    @property
    def active_provider(self) -> str:
        return self._providers.active_name

    def provider_names(self) -> list[str]:
        return self._providers.names()

    def set_provider(self, name: str) -> None:
        self._providers.set_active(name)

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
        return "\n".join(lines)

    async def respond(self, *, chat_id: int, text: str, session_id: str | None) -> str:
        normalized_sid = (session_id or "").strip()
        if normalized_sid == "legacy-main":
            normalized_sid = ""
        session_key = session_key_for_telegram_chat(chat_id, normalized_sid or None)

        lock = self._session_locks[session_key]
        async with lock:
            return await self._respond_locked(session_key=session_key, text=text)

    async def _respond_locked(self, *, session_key: str, text: str) -> str:
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

        history_rows = self._store.read_history(
            session_key,
            limit=self._settings.session_history_limit,
        )

        provider_messages: list[Message] = []
        for row in history_rows:
            provider_messages.append(
                Message(
                    role=self._message_role(str(row.get("role") or "user")),
                    content=str(row.get("content") or ""),
                )
            )
        provider_messages.append(Message(role=MessageRole.USER, content=query_text))

        memory_block = self._build_memory_block(memories)
        system_prompt = SYSTEM_PROMPT if not memory_block else f"{SYSTEM_PROMPT}\n\n{memory_block}"

        assistant_text = ""
        try:
            chunks: list[str] = []
            async for delta in provider.chat_stream(provider_messages, system=system_prompt):
                if delta.content:
                    chunks.append(delta.content)
            assistant_text = "".join(chunks).strip()
            if not assistant_text:
                # fallback to non-stream if the provider didn't emit deltas
                chat = await provider.chat(provider_messages, system=system_prompt)
                assistant_text = str(chat.message.content or "").strip()
        except Exception as exc:
            logger.exception("Provider request failed")
            assistant_text = f"Provider error: {exc}"

        if not assistant_text:
            assistant_text = "I don't have a response for that yet."

        # Persist session transcript.
        self._store.append_message(session_key, "user", query_text)
        self._store.append_message(session_key, "assistant", assistant_text)

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
