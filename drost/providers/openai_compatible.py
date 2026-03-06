"""OpenAI-compatible Responses API provider.

Used for:
- OpenAI Codex OAuth (ChatGPT backend)
- OpenAI API key mode
- xAI Responses-compatible mode (via base_url)
"""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

from openai import AsyncOpenAI, AsyncStream, AuthenticationError
from openai.types.responses import ResponseStreamEvent

from drost.providers.base import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
    ToolDefinition,
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

        api_key: str | Callable[[], Awaitable[str]] | None = (
            self._static_token if self._static_token is not None else self._codex_access_token
        )

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
            now = datetime.now(UTC)
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
                        elif ptype == "image":
                            data = str(part.get("data") or "").strip()
                            mime_type = str(part.get("mime_type") or "image/jpeg").strip()
                            if data:
                                content.append(
                                    {
                                        "type": "input_image",
                                        "detail": "auto",
                                        "image_url": f"data:{mime_type};base64,{data}",
                                    }
                                )
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

    def _convert_tools(self, tools: list[ToolDefinition] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return None

        def _make_nullable(schema: Any) -> Any:
            if not isinstance(schema, dict):
                return schema
            schema_type = schema.get("type")
            if isinstance(schema_type, str):
                if schema_type != "null":
                    schema["type"] = [schema_type, "null"]
            elif isinstance(schema_type, list) and "null" not in schema_type:
                schema["type"] = [*schema_type, "null"]
            return schema

        def _normalize_strict_schema(schema: Any) -> Any:
            if isinstance(schema, list):
                for item in schema:
                    _normalize_strict_schema(item)
                return schema
            if not isinstance(schema, dict):
                return schema

            if schema.get("type") == "object" or "properties" in schema:
                schema.setdefault("type", "object")
                schema["additionalProperties"] = False
                props = schema.get("properties")
                if isinstance(props, dict):
                    required = schema.get("required")
                    required_set = set(required) if isinstance(required, list) else set()
                    schema["required"] = list(props.keys())
                    for name, sub in props.items():
                        if name not in required_set:
                            _make_nullable(sub)

            for key in ("properties", "$defs", "definitions"):
                subs = schema.get(key)
                if isinstance(subs, dict):
                    for sub in subs.values():
                        _normalize_strict_schema(sub)

            for key in ("items", "oneOf", "anyOf", "allOf", "if", "then", "else", "not"):
                if key in schema:
                    _normalize_strict_schema(schema[key])
            return schema

        if not self._tools_strict:
            return [
                {
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": copy.deepcopy(t.input_schema),
                    "strict": False,
                }
                for t in tools
            ]

        return [
            {
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": _normalize_strict_schema(copy.deepcopy(t.input_schema)),
                "strict": True,
            }
            for t in tools
        ]

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

    @classmethod
    def _extract_tool_calls_from_output(cls, output_items: list[Any] | None) -> list[ToolCall]:
        calls: list[ToolCall] = []
        for item in output_items or []:
            if getattr(item, "type", None) != "function_call":
                continue
            call_id = str(getattr(item, "call_id", "") or "").strip()
            if not call_id:
                call_id = str(getattr(item, "id", "") or "").strip()
            name = str(getattr(item, "name", "") or "").strip()
            raw_args = str(getattr(item, "arguments", "") or "")
            if call_id and name:
                calls.append(ToolCall(id=call_id, name=name, arguments=cls._safe_json_object(raw_args)))
        return calls

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
        tools: list[ToolDefinition] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = stop_sequences

        input_items = self._convert_messages_to_input(messages)
        openai_tools = self._convert_tools(tools)

        if self._is_codex_backend:
            return await self._chat_from_stream(
                input_items=input_items,
                system=system,
                tools=openai_tools,
                max_tokens=max_tokens,
                temperature=temperature,
            )

        async def _call() -> Any:
            kwargs: dict[str, Any] = {
                "model": self._model,
                "input": cast(Any, input_items),
                "instructions": self._resolve_instructions(system),
                "store": False,
                "stream": False,
                "max_output_tokens": max_tokens or self._max_tokens,
            }
            if openai_tools is not None:
                kwargs["tools"] = cast(Any, openai_tools)
            if temperature is not None:
                kwargs["temperature"] = temperature
            return await self._client.responses.create(**kwargs)

        try:
            resp = await _call()
        except AuthenticationError:
            if self._use_codex_oauth:
                await self._refresh_codex()
                resp = await _call()
            else:
                raise

        message = Message(
            role=MessageRole.ASSISTANT,
            content=self._extract_text_from_output(getattr(resp, "output", None)) or None,
            tool_calls=self._extract_tool_calls_from_output(getattr(resp, "output", None)),
        )
        usage = None
        if getattr(resp, "usage", None):
            usage = {
                "input_tokens": int(getattr(resp.usage, "input_tokens", 0) or 0),
                "output_tokens": int(getattr(resp.usage, "output_tokens", 0) or 0),
            }
            usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
        return ChatResponse(
            message=message,
            finish_reason="tool_calls" if message.tool_calls else "stop",
            usage=usage,
        )

    async def _chat_from_stream(
        self,
        *,
        input_items: list[dict[str, Any]],
        system: str | None,
        tools: list[dict[str, Any]] | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> ChatResponse:
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        usage: dict[str, int] | None = None
        async for delta in self._iter_openai_stream(
            input_items=input_items,
            system=system,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
        ):
            if delta.content:
                text_parts.append(delta.content)
            if delta.tool_call:
                tool_calls.append(delta.tool_call)
            if delta.usage:
                usage = delta.usage

        return ChatResponse(
            message=Message(
                role=MessageRole.ASSISTANT,
                content=("".join(text_parts) if text_parts else None),
                tool_calls=tool_calls,
            ),
            finish_reason="tool_calls" if tool_calls else "stop",
            usage=usage,
        )

    async def _iter_openai_stream(
        self,
        *,
        input_items: list[dict[str, Any]],
        system: str | None,
        tools: list[dict[str, Any]] | None,
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
        if tools is not None:
            kwargs["tools"] = cast(Any, tools)

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
            emitted_call_ids: set[str] = set()
            item_id_to_call_id: dict[str, str] = {}
            pending_by_item_id: dict[str, tuple[str, str]] = {}

            async for event in stream:
                etype = str(getattr(event, "type", "") or "")

                if etype == "response.output_text.delta":
                    delta_text = str(getattr(event, "delta", "") or "")
                    if delta_text:
                        emitted_text += delta_text
                        yield StreamDelta(content=delta_text)
                    continue

                if etype == "response.output_item.added":
                    item = getattr(event, "item", None)
                    if item is not None and getattr(item, "type", "") == "function_call":
                        item_id = str(getattr(item, "id", "") or "").strip()
                        call_id = str(getattr(item, "call_id", "") or "").strip()
                        if item_id and call_id:
                            item_id_to_call_id[item_id] = call_id
                            pending = pending_by_item_id.pop(item_id, None)
                            if pending and call_id not in emitted_call_ids:
                                name, raw = pending
                                emitted_call_ids.add(call_id)
                                yield StreamDelta(
                                    tool_call=ToolCall(
                                        id=call_id,
                                        name=name,
                                        arguments=self._safe_json_object(raw),
                                    )
                                )
                    continue

                if etype == "response.function_call_arguments.done":
                    item_id = str(getattr(event, "item_id", "") or "").strip()
                    name = str(getattr(event, "name", "") or "").strip()
                    raw = str(getattr(event, "arguments", "") or "").strip()
                    if item_id and name:
                        pending_by_item_id[item_id] = (name, raw)
                        call_id = item_id_to_call_id.get(item_id)
                        if call_id and call_id not in emitted_call_ids:
                            pending_by_item_id.pop(item_id, None)
                            emitted_call_ids.add(call_id)
                            yield StreamDelta(
                                tool_call=ToolCall(
                                    id=call_id,
                                    name=name,
                                    arguments=self._safe_json_object(raw),
                                )
                            )
                    continue

                if etype == "response.output_item.done":
                    item = getattr(event, "item", None)
                    if item is not None and getattr(item, "type", "") == "function_call":
                        item_id = str(getattr(item, "id", "") or "").strip()
                        call_id = str(getattr(item, "call_id", "") or "").strip()
                        name = str(getattr(item, "name", "") or "").strip()
                        raw = str(getattr(item, "arguments", "") or "")
                        if item_id and call_id:
                            item_id_to_call_id[item_id] = call_id
                            pending_by_item_id.pop(item_id, None)
                        if call_id and name and call_id not in emitted_call_ids:
                            emitted_call_ids.add(call_id)
                            yield StreamDelta(
                                tool_call=ToolCall(
                                    id=call_id,
                                    name=name,
                                    arguments=self._safe_json_object(raw),
                                )
                            )
                    continue

                if etype == "response.completed":
                    response = getattr(event, "response", None)
                    if response is None:
                        continue

                    for tc in self._extract_tool_calls_from_output(getattr(response, "output", None)):
                        if tc.id in emitted_call_ids:
                            continue
                        emitted_call_ids.add(tc.id)
                        yield StreamDelta(tool_call=tc)

                    final_text = self._extract_text_from_output(getattr(response, "output", None))
                    if final_text and final_text.startswith(emitted_text) and len(final_text) > len(emitted_text):
                        yield StreamDelta(content=final_text[len(emitted_text) :])

                    if getattr(response, "usage", None):
                        usage = {
                            "input_tokens": int(getattr(response.usage, "input_tokens", 0) or 0),
                            "output_tokens": int(getattr(response.usage, "output_tokens", 0) or 0),
                        }
                        usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
                        yield StreamDelta(usage=usage)
        finally:
            if stream is not None:
                await stream.close()

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[ToolDefinition] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        _ = stop_sequences

        input_items = self._convert_messages_to_input(messages)
        openai_tools = self._convert_tools(tools)
        async for delta in self._iter_openai_stream(
            input_items=input_items,
            system=system,
            tools=openai_tools,
            max_tokens=max_tokens,
            temperature=temperature,
        ):
            yield delta

    async def close(self) -> None:
        await self._client.close()
