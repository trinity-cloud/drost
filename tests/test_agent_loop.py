from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from drost.agent_loop import DefaultSingleLoopRunner
from drost.config import Settings
from drost.providers.base import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta, ToolCall
from drost.tools.base import BaseTool
from drost.tools.registry import ToolRegistry


class EchoTool(BaseTool):
    @property
    def name(self) -> str:
        return "echo"

    @property
    def description(self) -> str:
        return "Echo"

    @property
    def parameters(self) -> dict[str, object]:
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}

    async def execute(self, **kwargs: object) -> str:
        return str(kwargs.get("text") or "")


class ToolThenTextProvider(BaseProvider):
    @property
    def name(self) -> str:
        return "fake"

    @property
    def model(self) -> str:
        return "fake-model"

    async def chat(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content="done"),
            finish_reason="stop",
            usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        _ = system, tools, max_tokens, temperature, stop_sequences
        if messages and messages[-1].role == MessageRole.TOOL:
            yield StreamDelta(content="done")
            yield StreamDelta(usage={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})
            return
        yield StreamDelta(
            tool_call=ToolCall(
                id="call-1",
                name="echo",
                arguments={"text": "tool output"},
            )
        )
        yield StreamDelta(usage={"input_tokens": 8, "output_tokens": 2, "total_tokens": 10})


class AlwaysToolProvider(BaseProvider):
    @property
    def name(self) -> str:
        return "fake"

    @property
    def model(self) -> str:
        return "fake-model"

    async def chat(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        return ChatResponse(message=Message(role=MessageRole.ASSISTANT, content=None), finish_reason="tool_calls")

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        yield StreamDelta(tool_call=ToolCall(id="loop-1", name="echo", arguments={"text": "x"}))


@pytest.mark.asyncio
async def test_agent_loop_tool_then_completion(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path)
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = DefaultSingleLoopRunner(
        provider=ToolThenTextProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.final_text == "done"
    assert result.tool_calls == 1
    assert not result.stopped_by_limit


@pytest.mark.asyncio
async def test_agent_loop_emits_status_updates(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path)
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = DefaultSingleLoopRunner(
        provider=ToolThenTextProvider(),
        tool_registry=registry,
        settings=settings,
    )

    statuses: list[str] = []

    async def _status(text: str) -> None:
        statuses.append(text)

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
        status_callback=_status,
    )
    assert result.final_text == "done"
    assert statuses
    assert any("Running tool: echo" in s for s in statuses)


@pytest.mark.asyncio
async def test_agent_loop_limit_stop(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path, agent_max_iterations=2)
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = DefaultSingleLoopRunner(
        provider=AlwaysToolProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.stopped_by_limit
    assert "loop limit" in result.final_text
