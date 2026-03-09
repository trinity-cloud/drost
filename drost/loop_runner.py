from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from drost.providers import Message

StatusCallback = Callable[[str], Awaitable[None]]
AnswerStreamCallback = Callable[[str | None], Awaitable[None]]


@dataclass
class LoopRunResult:
    final_text: str
    run_id: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    iterations: int = 0
    tool_calls: int = 0
    duration_ms: int = 0
    provider_error: str = ""
    stopped_by_limit: bool = False


class LoopRunner(Protocol):
    async def run_turn(
        self,
        *,
        messages: list[Message],
        system_prompt: str,
        status_callback: StatusCallback | None = None,
        answer_stream_callback: AnswerStreamCallback | None = None,
    ) -> LoopRunResult:
        ...
