"""OpenAI-compatible Responses API provider.

Used for:
- OpenAI Codex OAuth (ChatGPT backend)
- OpenAI API key mode
- xAI Responses-compatible mode (via base_url)
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, cast

from openai import AsyncOpenAI, AsyncStream, AuthenticationError
from openai.types.responses import ResponseStreamEvent

from drost.providers.base import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
)
from drost.providers.openai_oauth import (
    CODEX_AUTH_PATH,
    load_codex_tokens,
    persist_codex_tokens,
    refresh_codex_tokens,
)

DEFAULT_REFRESH_WINDOW = timedelta(minutes=5)
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
DEFAULT_CODEX_INSTRUCTIONS = "You are Drost, a helpful and reliable assistant."


class OpenAICompatibleProvider(BaseProvider):
    def __init__(
        self,
        *,
        provider_name: str,
        model: str,
        token: str = "",
        base_url: str | None = None,
        organization: str | None = None,
        project: str | None = None,
        codex_auth_path: str | None = None,
        tools_strict: bool = True,
    ) -> None:
        self._provider_name = provider_name
        self._model = model
        self._max_tokens = 8_192
        self._tools_strict = bool(tools_strict)

        self._static_token = (token or "").strip() or None
        self._use_codex_oauth = self._static_token is None and provider_name == "openai-codex"
        self._codex_auth_path = CODEX_AUTH_PATH if not codex_auth_path else Path(codex_auth_path).expanduser()
        self._oauth_lock = asyncio.Lock()

        client_kwargs: dict[str, Any] = {}
        if base_url:
            client_kwargs["base_url"] = base_url
        elif self._use_codex_oauth:
            client_kwargs["base_url"] = DEFAULT_CODEX_BASE_URL
        self._is_codex_backend = (
            str(client_kwargs.get("base_url") or "").rstrip("/") == DEFAULT_CODEX_BASE_URL.rstrip("/")
        )
        if organization:
            client_kwargs["organization"] = organization
        if project:
            client_kwargs["project"] = project

        api_key: str | Callable[[], Awaitable[str]] | None
        if self._static_token is not None:
            api_key = self._static_token
        else:
            api_key = self._codex_access_token

        self._client = AsyncOpenAI(api_key=api_key, **client_kwargs)

    @property
    def name(self) -> str:
        return self._provider_name

    @property
    def model(self) -> str:
        return self._model

    async def _codex_access_token(self) -> str:
        async with self._oauth_lock:
            tokens = load_codex_tokens(self._codex_auth_path)
            now = datetime.now(timezone.utc)
            needs_refresh = tokens.expires_at is None or tokens.expires_at <= (now + DEFAULT_REFRESH_WINDOW)
            if needs_refresh:
                refreshed = await refresh_codex_tokens(
                    refresh_token=tokens.refresh_token,
                    client_id=tokens.client_id,
                )
                persist_codex_tokens(refreshed, path=self._codex_auth_path)
                tokens = load_codex_tokens(self._codex_auth_path)
            return tokens.access_token

    async def _refresh_codex(self) -> str:
        async with self._oauth_lock:
            tokens = load_codex_tokens(self._codex_auth_path)
            refreshed = await refresh_codex_tokens(
                refresh_token=tokens.refresh_token,
                client_id=tokens.client_id,
            )
            persist_codex_tokens(refreshed, path=self._codex_auth_path)
            tokens = load_codex_tokens(self._codex_auth_path)
            return tokens.access_token

    def _convert_messages_to_input(self, messages: list[Message]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == MessageRole.SYSTEM:
                continue
            if msg.role == MessageRole.USER:
                if isinstance(msg.content, list):
                    content: list[dict[str, Any]] = []
                    for part in msg.content:
                        if not isinstance(part, dict):
                            content.append({"type": "input_text", "text": str(part)})
                            continue
                        ptype = part.get("type")
                        if ptype == "text":
                            content.append({"type": "input_text", "text": str(part.get("text") or "")})
                        else:
                            content.append({"type": "input_text", "text": str(part)})
                    out.append({"type": "message", "role": "user", "content": content})
                else:
                    out.append({"type": "message", "role": "user", "content": str(msg.content or "")})
                continue

            if msg.role == MessageRole.ASSISTANT:
                if msg.content:
                    out.append({"type": "message", "role": "assistant", "content": str(msg.content)})
                for tc in msg.tool_calls:
                    out.append(
                        {
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        }
                    )
                continue

            if msg.role == MessageRole.TOOL:
                for tr in msg.tool_results:
                    out.append(
                        {
                            "type": "function_call_output",
                            "call_id": tr.tool_call_id,
                            "output": tr.content,
                        }
                    )
                continue

        return out

    @staticmethod
    def _safe_json_object(raw: str) -> dict[str, Any]:
        cleaned = (raw or "").strip()
        if not cleaned:
            return {}
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _extract_text_from_output(output_items: list[Any] | None) -> str:
        text_parts: list[str] = []
        for item in output_items or []:
            if getattr(item, "type", None) != "message":
                continue
            for part in getattr(item, "content", []) or []:
                if getattr(part, "type", None) == "output_text":
                    text_parts.append(str(getattr(part, "text", "") or ""))
        return "".join(text_parts)

    def _resolve_instructions(self, system: str | None) -> str | None:
        cleaned = (system or "").strip()
        if cleaned:
            return cleaned
        if self._is_codex_backend:
            return DEFAULT_CODEX_INSTRUCTIONS
        return None

    async def chat(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[Any] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = tools
        _ = stop_sequences

        input_items = self._convert_messages_to_input(messages)

        async def _call(stream: bool) -> Any:
            kwargs: dict[str, Any] = {
                "model": self._model,
                "input": cast(Any, input_items),
                "instructions": self._resolve_instructions(system),
                "store": False,
                "stream": stream,
            }
            if not self._is_codex_backend:
                kwargs["max_output_tokens"] = max_tokens or self._max_tokens
                if temperature is not None:
                    kwargs["temperature"] = temperature
            return await self._client.responses.create(**kwargs)

        if self._is_codex_backend:
            # Codex backend requires stream=true; buffer into a full response.
            return await self._chat_from_stream(input_items=input_items, system=system, max_tokens=max_tokens)

        try:
            resp = await _call(stream=False)
        except AuthenticationError:
            if self._use_codex_oauth:
                await self._refresh_codex()
                resp = await _call(stream=False)
            else:
                raise

        text = self._extract_text_from_output(getattr(resp, "output", None))
        usage = None
        if getattr(resp, "usage", None):
            usage = {
                "input_tokens": int(getattr(resp.usage, "input_tokens", 0) or 0),
                "output_tokens": int(getattr(resp.usage, "output_tokens", 0) or 0),
            }
            usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])

        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=text if text else None),
            finish_reason="stop",
            usage=usage,
        )

    async def _chat_from_stream(
        self,
        *,
        input_items: list[dict[str, Any]],
        system: str | None,
        max_tokens: int | None,
    ) -> ChatResponse:
        text_parts: list[str] = []
        usage: dict[str, int] | None = None
        async for delta in self._iter_openai_stream(
            input_items=input_items,
            system=system,
            max_tokens=max_tokens,
            temperature=None,
        ):
            if delta.content:
                text_parts.append(delta.content)
            if delta.usage:
                usage = delta.usage
        text = "".join(text_parts)
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=text if text else None),
            finish_reason="stop",
            usage=usage,
        )

    async def _iter_openai_stream(
        self,
        *,
        input_items: list[dict[str, Any]],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[StreamDelta]:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "input": cast(Any, input_items),
            "instructions": self._resolve_instructions(system),
            "store": False,
            "stream": True,
        }
        if not self._is_codex_backend:
            kwargs["max_output_tokens"] = max_tokens or self._max_tokens
            if temperature is not None:
                kwargs["temperature"] = temperature

        stream: AsyncStream[ResponseStreamEvent] | None = None
        try:
            try:
                stream = cast(AsyncStream[ResponseStreamEvent], await self._client.responses.create(**kwargs))
            except AuthenticationError:
                if self._use_codex_oauth:
                    await self._refresh_codex()
                    stream = cast(AsyncStream[ResponseStreamEvent], await self._client.responses.create(**kwargs))
                else:
                    raise

            emitted_text = ""
            async for event in stream:
                etype = str(getattr(event, "type", "") or "")
                if etype == "response.output_text.delta":
                    delta = str(getattr(event, "delta", "") or "")
                    if delta:
                        emitted_text += delta
                        yield StreamDelta(content=delta)
                    continue

                if etype == "response.completed":
                    response = getattr(event, "response", None)
                    if response is None:
                        continue
                    if getattr(response, "usage", None):
                        usage = {
                            "input_tokens": int(getattr(response.usage, "input_tokens", 0) or 0),
                            "output_tokens": int(getattr(response.usage, "output_tokens", 0) or 0),
                        }
                        usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
                        yield StreamDelta(usage=usage)

                    final_text = self._extract_text_from_output(getattr(response, "output", None))
                    if final_text and final_text.startswith(emitted_text) and len(final_text) > len(emitted_text):
                        yield StreamDelta(content=final_text[len(emitted_text) :])
        finally:
            if stream is not None:
                await stream.close()

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[Any] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        _ = tools
        _ = stop_sequences

        input_items = self._convert_messages_to_input(messages)
        async for delta in self._iter_openai_stream(
            input_items=input_items,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
        ):
            yield delta

    async def close(self) -> None:
        await self._client.close()
