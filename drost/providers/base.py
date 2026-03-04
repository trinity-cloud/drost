"""Provider abstractions for Drost."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    tool_call_id: str
    content: str
    is_error: bool = False


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]

    def to_anthropic_format(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


@dataclass
class Message:
    role: MessageRole
    content: str | list[dict[str, Any]] | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    name: str | None = None


@dataclass
class StreamDelta:
    content: str | None = None
    tool_call: ToolCall | None = None
    finish_reason: str | None = None
    usage: dict[str, int] | None = None


@dataclass
class ChatResponse:
    message: Message
    finish_reason: str
    usage: dict[str, int] | None = None


class BaseProvider(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def model(self) -> str:
        ...

    @property
    def requires_user_followup_turn(self) -> bool:
        """Whether continuation requests must end with a user role message."""
        return False

    @abstractmethod
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
        ...

    @abstractmethod
    def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[ToolDefinition] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        ...

    async def close(self) -> None:
        return None
