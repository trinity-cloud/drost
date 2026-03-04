from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from drost.agent_loop import (
    LOOP_CHECKLIST_PATCH,
    LOOP_FINISH,
    DefaultSingleLoopRunner,
)
from drost.config import Settings
from drost.providers.base import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
)
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


class _BaseFakeProvider(BaseProvider):
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
            message=Message(role=MessageRole.ASSISTANT, content="fallback"),
            finish_reason="stop",
            usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )


class ToolThenFinishProvider(_BaseFakeProvider):
    def __init__(self) -> None:
        self.calls = 0

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
        if self.calls == 0:
            self.calls += 1
            yield StreamDelta(
                tool_call=ToolCall(
                    id="call-1",
                    name="echo",
                    arguments={"text": "tool output"},
                )
            )
            yield StreamDelta(usage={"input_tokens": 8, "output_tokens": 2, "total_tokens": 10})
            return
        self.calls += 1
        yield StreamDelta(
            tool_call=ToolCall(
                id="call-finish",
                name=LOOP_FINISH,
                arguments={"final_response": "done"},
            )
        )
        yield StreamDelta(usage={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})


class ChecklistThenFinishProvider(_BaseFakeProvider):
    def __init__(self) -> None:
        self.calls = 0

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
        if self.calls == 0:
            self.calls += 1
            yield StreamDelta(
                tool_call=ToolCall(
                    id="call-checklist",
                    name=LOOP_CHECKLIST_PATCH,
                    arguments={
                        "operations": [
                            {"op": "add", "id": "verify", "text": "Verify claim with sources"},
                            {"op": "set_status", "id": "verify", "status": "done"},
                        ]
                    },
                )
            )
            return
        self.calls += 1
        yield StreamDelta(
            tool_call=ToolCall(
                id="call-finish",
                name=LOOP_FINISH,
                arguments={
                    "final_response": "done with checklist",
                    "completion_check": {
                        "items": [
                            {
                                "id": "verify",
                                "outcome": "done",
                                "note": "Verified from tool outputs.",
                            }
                        ]
                    },
                },
            )
        )


class ToolThenPlainTextProvider(_BaseFakeProvider):
    def __init__(self) -> None:
        self.calls = 0

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
        if self.calls == 0:
            self.calls += 1
            yield StreamDelta(
                tool_call=ToolCall(
                    id="call-1",
                    name="echo",
                    arguments={"text": "tool output"},
                )
            )
            return
        self.calls += 1
        yield StreamDelta(content="done")


class ChecklistFinishMissingCompletionProvider(_BaseFakeProvider):
    def __init__(self) -> None:
        self.calls = 0

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
        if self.calls == 0:
            self.calls += 1
            yield StreamDelta(
                tool_call=ToolCall(
                    id="call-checklist",
                    name=LOOP_CHECKLIST_PATCH,
                    arguments={"operations": [{"op": "add", "id": "verify", "text": "Verify claim"}]},
                )
            )
            return
        self.calls += 1
        yield StreamDelta(
            tool_call=ToolCall(
                id=f"call-finish-{self.calls}",
                name=LOOP_FINISH,
                arguments={"final_response": "done without completion check"},
            )
        )


class AlwaysToolProvider(_BaseFakeProvider):
    @property
    def model(self) -> str:
        return "fake-model"

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
        provider=ToolThenFinishProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.final_text == "done"
    assert result.tool_calls == 2
    assert not result.stopped_by_limit


@pytest.mark.asyncio
async def test_agent_loop_emits_status_updates(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path)
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = DefaultSingleLoopRunner(
        provider=ToolThenFinishProvider(),
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
    assert any(f"Running control tool: {LOOP_FINISH}" in s for s in statuses)


@pytest.mark.asyncio
async def test_agent_loop_requires_explicit_finish_after_tool_use(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path, agent_max_iterations=3)
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = DefaultSingleLoopRunner(
        provider=ToolThenPlainTextProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.stopped_by_limit
    assert "loop limit" in result.final_text


@pytest.mark.asyncio
async def test_agent_loop_checklist_patch_then_finish(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path)
    registry = ToolRegistry()
    runner = DefaultSingleLoopRunner(
        provider=ChecklistThenFinishProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.final_text == "done with checklist"
    assert result.tool_calls == 2
    assert not result.stopped_by_limit


@pytest.mark.asyncio
async def test_agent_loop_finish_requires_completion_check_when_checklist_exists(tmp_path) -> None:
    settings = Settings(workspace_dir=tmp_path, agent_max_iterations=4)
    registry = ToolRegistry()
    runner = DefaultSingleLoopRunner(
        provider=ChecklistFinishMissingCompletionProvider(),
        tool_registry=registry,
        settings=settings,
    )

    result = await runner.run_turn(
        messages=[Message(role=MessageRole.USER, content="hi")],
        system_prompt="system",
    )
    assert result.stopped_by_limit
    assert "completion_check" in result.final_text


@pytest.mark.asyncio
async def test_agent_loop_limit_stop_with_repeated_tool_calls(tmp_path) -> None:
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
