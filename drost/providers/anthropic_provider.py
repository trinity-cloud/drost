"""Anthropic Claude provider with setup-token support and native tool calling."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic.types import (
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    MessageDeltaEvent,
    MessageStartEvent,
    TextBlock,
    TextDelta,
    ToolUseBlock,
)
from anthropic.types.input_json_delta import InputJsonDelta

from drost.providers.base import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
    ToolDefinition,
)

logger = logging.getLogger(__name__)

STREAM_REQUIRED_ERROR_SNIPPET = "Streaming is required for operations that may take longer than 10 minutes"


def _convert_messages(messages: list[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for msg in messages:
        if msg.role == MessageRole.SYSTEM:
            continue

        if msg.role == MessageRole.USER:
            if isinstance(msg.content, list):
                blocks: list[dict[str, Any]] = []
                for part in msg.content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        blocks.append({"type": "text", "text": str(part.get("text") or "")})
                    elif isinstance(part, dict) and part.get("type") == "image":
                        data = str(part.get("data") or "").strip()
                        mime_type = str(part.get("mime_type") or "image/jpeg").strip()
                        if data:
                            blocks.append(
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": mime_type,
                                        "data": data,
                                    },
                                }
                            )
                    else:
                        blocks.append({"type": "text", "text": str(part)})
                out.append({"role": "user", "content": blocks})
            else:
                out.append({"role": "user", "content": str(msg.content or "")})
            continue

        if msg.role == MessageRole.ASSISTANT:
            content: list[dict[str, Any]] = []
            if msg.content:
                content.append({"type": "text", "text": str(msg.content)})
            for tc in msg.tool_calls:
                content.append(
                    {
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments,
                    }
                )
            out.append({"role": "assistant", "content": content if content else ""})
            continue

        if msg.role == MessageRole.TOOL:
            blocks: list[dict[str, Any]] = []
            for tr in msg.tool_results:
                blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tr.tool_call_id,
                        "content": tr.content,
                        "is_error": bool(tr.is_error),
                    }
                )
            out.append({"role": "user", "content": blocks})
            continue

    return out


class AnthropicProvider(BaseProvider):
    def __init__(self, *, model: str, token: str) -> None:
        self._model = model
        self._max_tokens = 8_192

        client_kwargs: dict[str, Any] = {}
        default_headers: dict[str, str] = {}
        token = (token or "").strip()
        if not token:
            raise ValueError("Anthropic token is required for anthropic provider")

        self._is_setup_token = "sk-ant-oat" in token
        if self._is_setup_token:
            # Mirror reference implementation/OAuth behavior for Claude Code setup-token or OAuth token.
            for var in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]:
                os.environ.pop(var, None)
            client_kwargs["api_key"] = None
            client_kwargs["auth_token"] = token
            default_headers = {
                "accept": "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
                "user-agent": "claude-cli/2.1.2 (external, cli)",
                "x-app": "cli",
            }
        else:
            client_kwargs["api_key"] = token

        if default_headers:
            client_kwargs["default_headers"] = default_headers

        self._client = anthropic.AsyncAnthropic(**client_kwargs)

    @property
    def name(self) -> str:
        return "anthropic"

    @property
    def model(self) -> str:
        return self._model

    @property
    def requires_user_followup_turn(self) -> bool:
        # Some Claude models reject assistant-prefill continuations and require a trailing user turn.
        return True

    def _build_system(self, system: str | None) -> Any:
        if not self._is_setup_token:
            return system

        blocks: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": "You are Claude Code, Anthropic's official CLI for Claude.",
                "cache_control": {"type": "ephemeral"},
            }
        ]
        if system:
            blocks.append(
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            )
        return blocks

    @staticmethod
    def _convert_tools(tools: list[ToolDefinition] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        return [t.to_anthropic_format() for t in tools]

    @staticmethod
    def _parse_response_content(blocks: list[Any]) -> tuple[str | None, list[ToolCall]]:
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in blocks:
            if isinstance(block, TextBlock):
                text_parts.append(block.text)
            elif isinstance(block, ToolUseBlock):
                tool_calls.append(
                    ToolCall(
                        id=block.id,
                        name=block.name,
                        arguments=dict(block.input) if isinstance(block.input, dict) else {},
                    )
                )
        return ("".join(text_parts) or None, tool_calls)

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
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": _convert_messages(messages),
            "max_tokens": max_tokens or self._max_tokens,
        }

        built_system = self._build_system(system)
        if built_system:
            kwargs["system"] = built_system
        converted_tools = self._convert_tools(tools)
        if converted_tools:
            kwargs["tools"] = converted_tools
        if temperature is not None:
            kwargs["temperature"] = temperature
        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

        try:
            response = await self._client.messages.create(**kwargs)
            content_text, tool_calls = self._parse_response_content(response.content)
            usage = None
            if response.usage:
                usage = {
                    "input_tokens": int(response.usage.input_tokens or 0),
                    "output_tokens": int(response.usage.output_tokens or 0),
                }
                usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
            return ChatResponse(
                message=Message(
                    role=MessageRole.ASSISTANT,
                    content=content_text,
                    tool_calls=tool_calls,
                ),
                finish_reason=str(response.stop_reason or "end_turn"),
                usage=usage,
            )
        except ValueError as exc:
            if STREAM_REQUIRED_ERROR_SNIPPET not in str(exc):
                raise
            return await self._chat_from_stream(
                messages=messages,
                system=system,
                tools=tools,
                max_tokens=max_tokens,
                temperature=temperature,
                stop_sequences=stop_sequences,
            )

    async def _chat_from_stream(
        self,
        *,
        messages: list[Message],
        system: str | None,
        tools: list[ToolDefinition] | None,
        max_tokens: int | None,
        temperature: float | None,
        stop_sequences: list[str] | None,
    ) -> ChatResponse:
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        usage: dict[str, int] | None = None
        finish_reason = "stop"
        async for delta in self.chat_stream(
            messages,
            system=system,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            stop_sequences=stop_sequences,
        ):
            if delta.content:
                text_parts.append(delta.content)
            if delta.tool_call:
                tool_calls.append(delta.tool_call)
            if delta.usage:
                usage = delta.usage
            if delta.finish_reason:
                finish_reason = delta.finish_reason

        return ChatResponse(
            message=Message(
                role=MessageRole.ASSISTANT,
                content="".join(text_parts) or None,
                tool_calls=tool_calls,
            ),
            finish_reason=finish_reason,
            usage=usage,
        )

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
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": _convert_messages(messages),
            "max_tokens": max_tokens or self._max_tokens,
        }

        built_system = self._build_system(system)
        if built_system:
            kwargs["system"] = built_system
        converted_tools = self._convert_tools(tools)
        if converted_tools:
            kwargs["tools"] = converted_tools
        if temperature is not None:
            kwargs["temperature"] = temperature
        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

        current_tool_id: str | None = None
        current_tool_name: str | None = None
        current_tool_json = ""
        last_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

        async with self._client.messages.stream(**kwargs) as stream:
            async for event in stream:
                if isinstance(event, MessageStartEvent):
                    usage_obj = getattr(getattr(event, "message", None), "usage", None)
                    if usage_obj is None:
                        continue
                    usage = {
                        "input_tokens": int(getattr(usage_obj, "input_tokens", 0) or 0),
                        "output_tokens": int(getattr(usage_obj, "output_tokens", 0) or 0),
                    }
                    usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
                    last_usage = usage
                    yield StreamDelta(usage=usage)
                    continue

                if isinstance(event, ContentBlockStartEvent):
                    block = event.content_block
                    if getattr(block, "type", "") == "tool_use":
                        current_tool_id = str(getattr(block, "id", "") or "").strip() or None
                        current_tool_name = str(getattr(block, "name", "") or "").strip() or None
                        current_tool_json = ""
                    continue

                if isinstance(event, ContentBlockDeltaEvent):
                    delta = event.delta
                    if isinstance(delta, TextDelta):
                        text = str(delta.text or "")
                        if text:
                            yield StreamDelta(content=text)
                    elif isinstance(delta, InputJsonDelta):
                        current_tool_json += str(delta.partial_json or "")
                    continue

                if isinstance(event, ContentBlockStopEvent):
                    if current_tool_id and current_tool_name:
                        arguments: dict[str, Any]
                        try:
                            parsed = json.loads(current_tool_json) if current_tool_json else {}
                        except json.JSONDecodeError:
                            parsed = {}
                        arguments = parsed if isinstance(parsed, dict) else {}
                        yield StreamDelta(
                            tool_call=ToolCall(
                                id=current_tool_id,
                                name=current_tool_name,
                                arguments=arguments,
                            )
                        )
                    current_tool_id = None
                    current_tool_name = None
                    current_tool_json = ""
                    continue

                if isinstance(event, MessageDeltaEvent):
                    usage_obj = getattr(event, "usage", None)
                    if usage_obj is not None:
                        usage = {
                            "input_tokens": int(getattr(usage_obj, "input_tokens", last_usage["input_tokens"]) or 0),
                            "output_tokens": int(getattr(usage_obj, "output_tokens", 0) or 0),
                        }
                        usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
                        if usage != last_usage:
                            last_usage = usage
                            yield StreamDelta(usage=usage)

                    stop_reason = str(getattr(getattr(event, "delta", None), "stop_reason", "") or "").strip()
                    if stop_reason:
                        yield StreamDelta(finish_reason=stop_reason)

                    if current_tool_id and current_tool_name:
                        try:
                            parsed = json.loads(current_tool_json) if current_tool_json else {}
                        except json.JSONDecodeError:
                            parsed = {}
                        arguments = parsed if isinstance(parsed, dict) else {}
                        yield StreamDelta(
                            tool_call=ToolCall(
                                id=current_tool_id,
                                name=current_tool_name,
                                arguments=arguments,
                            )
                        )
                        current_tool_id = None
                        current_tool_name = None
                        current_tool_json = ""

    async def close(self) -> None:
        await self._client.close()
