"""Anthropic Claude provider with setup-token support (Claude Code style)."""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

import anthropic
from anthropic.types import (
    ContentBlockDeltaEvent,
    MessageDeltaEvent,
    MessageStartEvent,
    TextBlock,
    TextDelta,
)

from drost.providers.base import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta

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
                    else:
                        blocks.append({"type": "text", "text": str(part)})
                out.append({"role": "user", "content": blocks})
            else:
                out.append({"role": "user", "content": str(msg.content or "")})
            continue

        if msg.role == MessageRole.ASSISTANT:
            out.append({"role": "assistant", "content": str(msg.content or "")})
            continue

        if msg.role == MessageRole.TOOL:
            # Drost stripped-down runtime does not use tool call loops.
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
            # Mirror Morpheus/OAuth behavior for Claude Code setup-token or OAuth token.
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

    def _build_system(self, system: str | None) -> Any:
        if not self._is_setup_token:
            return system

        # Claude Code-style identity for setup tokens.
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

        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": _convert_messages(messages),
            "max_tokens": max_tokens or self._max_tokens,
        }

        built_system = self._build_system(system)
        if built_system:
            kwargs["system"] = built_system

        if temperature is not None:
            kwargs["temperature"] = temperature
        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

        try:
            response = await self._client.messages.create(**kwargs)
            content_parts: list[str] = []
            for block in response.content:
                if isinstance(block, TextBlock):
                    content_parts.append(block.text)
            usage = None
            if response.usage:
                usage = {
                    "input_tokens": int(response.usage.input_tokens or 0),
                    "output_tokens": int(response.usage.output_tokens or 0),
                }
                usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
            return ChatResponse(
                message=Message(role=MessageRole.ASSISTANT, content="".join(content_parts) or None),
                finish_reason=str(response.stop_reason or "end_turn"),
                usage=usage,
            )
        except ValueError as exc:
            if STREAM_REQUIRED_ERROR_SNIPPET not in str(exc):
                raise
            return await self._chat_from_stream(
                messages=messages,
                system=system,
                max_tokens=max_tokens,
                temperature=temperature,
                stop_sequences=stop_sequences,
            )

    async def _chat_from_stream(
        self,
        *,
        messages: list[Message],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
        stop_sequences: list[str] | None,
    ) -> ChatResponse:
        text_parts: list[str] = []
        usage: dict[str, int] | None = None
        async for delta in self.chat_stream(
            messages,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            stop_sequences=stop_sequences,
        ):
            if delta.content:
                text_parts.append(delta.content)
            if delta.usage:
                usage = delta.usage

        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content="".join(text_parts) or None),
            finish_reason="stop",
            usage=usage,
        )

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

        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": _convert_messages(messages),
            "max_tokens": max_tokens or self._max_tokens,
        }

        built_system = self._build_system(system)
        if built_system:
            kwargs["system"] = built_system

        if temperature is not None:
            kwargs["temperature"] = temperature

        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

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

                if isinstance(event, ContentBlockDeltaEvent):
                    delta = event.delta
                    if isinstance(delta, TextDelta):
                        text = str(delta.text or "")
                        if text:
                            yield StreamDelta(content=text)
                    continue

                if isinstance(event, MessageDeltaEvent):
                    usage_obj = getattr(event, "usage", None)
                    if usage_obj is None:
                        continue
                    usage = {
                        "input_tokens": int(getattr(usage_obj, "input_tokens", 0) or last_usage["input_tokens"]),
                        "output_tokens": int(getattr(usage_obj, "output_tokens", 0) or 0),
                    }
                    usage["total_tokens"] = int(usage["input_tokens"] + usage["output_tokens"])
                    if usage != last_usage:
                        last_usage = usage
                        yield StreamDelta(usage=usage)

    async def close(self) -> None:
        await self._client.close()
