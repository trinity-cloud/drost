from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

import drost.providers.anthropic_provider as anthropic_module
from drost.providers.anthropic_provider import AnthropicProvider
from drost.providers.base import Message, MessageRole, ToolCall, ToolDefinition, ToolResult
from drost.providers.openai_compatible import OpenAICompatibleProvider


class FakeOpenAIStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self._index = 0
        self.closed = False

    def __aiter__(self) -> FakeOpenAIStream:
        return self

    async def __anext__(self) -> Any:
        if self._index >= len(self._events):
            raise StopAsyncIteration
        event = self._events[self._index]
        self._index += 1
        return event

    async def close(self) -> None:
        self.closed = True


class FakeOpenAIResponses:
    def __init__(self, stream: FakeOpenAIStream) -> None:
        self._stream = stream

    async def create(self, **kwargs: Any) -> FakeOpenAIStream:
        _ = kwargs
        return self._stream


class FakeOpenAIClient:
    def __init__(self, stream: FakeOpenAIStream) -> None:
        self.responses = FakeOpenAIResponses(stream)

    async def close(self) -> None:
        return None


class FakeAnthropicStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self._index = 0

    def __aiter__(self) -> FakeAnthropicStream:
        return self

    async def __anext__(self) -> Any:
        if self._index >= len(self._events):
            raise StopAsyncIteration
        event = self._events[self._index]
        self._index += 1
        return event


class FakeAnthropicStreamContext:
    def __init__(self, events: list[Any]) -> None:
        self._stream = FakeAnthropicStream(events)

    async def __aenter__(self) -> FakeAnthropicStream:
        return self._stream

    async def __aexit__(self, exc_type, exc, tb) -> None:
        _ = exc_type, exc, tb
        return None


class FakeAnthropicMessages:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def stream(self, **kwargs: Any) -> FakeAnthropicStreamContext:
        _ = kwargs
        return FakeAnthropicStreamContext(self._events)


class FakeAnthropicClient:
    def __init__(self, events: list[Any]) -> None:
        self.messages = FakeAnthropicMessages(events)

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_openai_stream_parses_tool_call_and_usage() -> None:
    provider = OpenAICompatibleProvider(
        provider_name="xai",
        model="grok-3-latest",
        token="test-token",
        base_url="https://api.x.ai/v1",
    )
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="hello "),
        SimpleNamespace(
            type="response.output_item.added",
            item=SimpleNamespace(type="function_call", id="item-1", call_id="call-1"),
        ),
        SimpleNamespace(
            type="response.function_call_arguments.done",
            item_id="item-1",
            name="web_search",
            arguments='{"query":"drost"}',
        ),
        SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(
                output=[],
                usage=SimpleNamespace(input_tokens=12, output_tokens=4),
            ),
        ),
    ]
    fake_stream = FakeOpenAIStream(events)
    provider._client = FakeOpenAIClient(fake_stream)

    deltas = []
    async for delta in provider.chat_stream(
        [Message(role=MessageRole.USER, content="hi")],
        system="system",
    ):
        deltas.append(delta)

    content = "".join(d.content or "" for d in deltas)
    tool_calls = [d.tool_call for d in deltas if d.tool_call is not None]
    usages = [d.usage for d in deltas if d.usage is not None]

    assert content == "hello "
    assert len(tool_calls) == 1
    assert tool_calls[0].id == "call-1"
    assert tool_calls[0].name == "web_search"
    assert tool_calls[0].arguments == {"query": "drost"}
    assert usages and usages[-1]["total_tokens"] == 16
    assert fake_stream.closed


def test_openai_tool_schema_strict_normalization() -> None:
    provider = OpenAICompatibleProvider(
        provider_name="xai",
        model="grok-3-latest",
        token="test-token",
        base_url="https://api.x.ai/v1",
        tools_strict=True,
    )
    tool = ToolDefinition(
        name="demo_tool",
        description="demo",
        input_schema={
            "type": "object",
            "properties": {
                "required_field": {"type": "string"},
                "optional_field": {"type": "integer"},
            },
            "required": ["required_field"],
        },
    )
    converted = provider._convert_tools([tool])
    assert converted is not None
    params = converted[0]["parameters"]
    assert params["additionalProperties"] is False
    assert set(params["required"]) == {"required_field", "optional_field"}
    assert "null" in params["properties"]["optional_field"]["type"]


def test_openai_multimodal_message_conversion() -> None:
    provider = OpenAICompatibleProvider(
        provider_name="xai",
        model="grok-3-latest",
        token="test-token",
        base_url="https://api.x.ai/v1",
    )
    converted = provider._convert_messages_to_input(
        [
            Message(
                role=MessageRole.USER,
                content=[
                    {"type": "text", "text": "What is in this image?"},
                    {"type": "image", "mime_type": "image/png", "data": "YWJj", "path": "/tmp/img.png"},
                ],
            )
        ]
    )
    assert converted == [
        {
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is in this image?"},
                {"type": "input_image", "detail": "auto", "image_url": "data:image/png;base64,YWJj"},
            ],
        }
    ]


def test_anthropic_multimodal_message_conversion() -> None:
    converted = anthropic_module._convert_messages(
        [
            Message(
                role=MessageRole.USER,
                content=[
                    {"type": "text", "text": "Describe this image"},
                    {"type": "image", "mime_type": "image/jpeg", "data": "YWJj"},
                ],
            )
        ]
    )
    assert converted == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image"},
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/jpeg", "data": "YWJj"},
                },
            ],
        }
    ]


@pytest.mark.asyncio
async def test_anthropic_stream_parses_tool_use_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = AnthropicProvider(model="claude-sonnet-4-20250514", token="sk-ant-test")

    class FakeMessageStartEvent:
        def __init__(self) -> None:
            self.message = SimpleNamespace(usage=SimpleNamespace(input_tokens=8, output_tokens=0))

    class FakeContentBlockStartEvent:
        def __init__(self) -> None:
            self.content_block = SimpleNamespace(type="tool_use", id="toolu_1", name="web_fetch")

    class FakeTextDelta:
        def __init__(self, text: str) -> None:
            self.text = text

    class FakeInputJsonDelta:
        def __init__(self, partial_json: str) -> None:
            self.partial_json = partial_json

    class FakeContentBlockDeltaEvent:
        def __init__(self, delta: Any) -> None:
            self.delta = delta

    class FakeContentBlockStopEvent:
        pass

    class FakeMessageDeltaEvent:
        def __init__(self) -> None:
            self.usage = SimpleNamespace(input_tokens=8, output_tokens=5)
            self.delta = SimpleNamespace(stop_reason="end_turn")

    monkeypatch.setattr(anthropic_module, "MessageStartEvent", FakeMessageStartEvent)
    monkeypatch.setattr(anthropic_module, "ContentBlockStartEvent", FakeContentBlockStartEvent)
    monkeypatch.setattr(anthropic_module, "TextDelta", FakeTextDelta)
    monkeypatch.setattr(anthropic_module, "InputJsonDelta", FakeInputJsonDelta)
    monkeypatch.setattr(anthropic_module, "ContentBlockDeltaEvent", FakeContentBlockDeltaEvent)
    monkeypatch.setattr(anthropic_module, "ContentBlockStopEvent", FakeContentBlockStopEvent)
    monkeypatch.setattr(anthropic_module, "MessageDeltaEvent", FakeMessageDeltaEvent)

    events = [
        FakeMessageStartEvent(),
        FakeContentBlockDeltaEvent(FakeTextDelta("thinking...")),
        FakeContentBlockStartEvent(),
        FakeContentBlockDeltaEvent(FakeInputJsonDelta('{"url":"https://example.com"}')),
        FakeContentBlockStopEvent(),
        FakeMessageDeltaEvent(),
    ]
    provider._client = FakeAnthropicClient(events)

    deltas = []
    async for delta in provider.chat_stream(
        [Message(role=MessageRole.USER, content="fetch it")],
        system="system",
        tools=[
            ToolDefinition(
                name="web_fetch",
                description="fetch url",
                input_schema={"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
            )
        ],
    ):
        deltas.append(delta)

    texts = "".join(d.content or "" for d in deltas)
    tool_calls = [d.tool_call for d in deltas if d.tool_call is not None]
    finish_reasons = [d.finish_reason for d in deltas if d.finish_reason]

    assert "thinking..." in texts
    assert len(tool_calls) == 1
    assert tool_calls[0] == ToolCall(
        id="toolu_1",
        name="web_fetch",
        arguments={"url": "https://example.com"},
    )
    assert "end_turn" in finish_reasons


def test_anthropic_message_conversion_includes_tool_blocks() -> None:
    messages = [
        Message(
            role=MessageRole.ASSISTANT,
            content="using tools",
            tool_calls=[ToolCall(id="call1", name="shell_execute", arguments={"command": "pwd"})],
        ),
        Message(
            role=MessageRole.TOOL,
            tool_results=[ToolResult(tool_call_id="call1", content="/tmp", is_error=False)],
        ),
    ]
    converted = anthropic_module._convert_messages(messages)
    assert converted[0]["role"] == "assistant"
    assert converted[0]["content"][1]["type"] == "tool_use"
    assert converted[1]["role"] == "user"
    assert converted[1]["content"][0]["type"] == "tool_result"
