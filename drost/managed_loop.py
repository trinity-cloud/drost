from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from enum import IntEnum, StrEnum
from typing import Any


class LoopPriority(IntEnum):
    FOREGROUND = 0
    HIGH = 10
    NORMAL = 20
    LOW = 30


class LoopVisibility(StrEnum):
    FOREGROUND = "foreground"
    BACKGROUND = "background"


class LoopLifecycleState(StrEnum):
    REGISTERED = "registered"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"


class ManagedLoop(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def priority(self) -> LoopPriority:
        ...

    @property
    @abstractmethod
    def visibility(self) -> LoopVisibility:
        ...

    @abstractmethod
    async def start(self) -> None:
        ...

    @abstractmethod
    async def stop(self) -> None:
        ...

    @abstractmethod
    def status(self) -> dict[str, Any]:
        ...


class ManagedRunnerLoop(ManagedLoop):
    def __init__(
        self,
        *,
        name: str,
        priority: LoopPriority,
        visibility: LoopVisibility,
        start_fn: Callable[[], Awaitable[None]],
        stop_fn: Callable[[], Awaitable[None]],
        status_fn: Callable[[], dict[str, Any]],
    ) -> None:
        self._name = str(name).strip()
        if not self._name:
            raise ValueError("loop name is required")
        self._priority = priority
        self._visibility = visibility
        self._start_fn = start_fn
        self._stop_fn = stop_fn
        self._status_fn = status_fn
        self._state = LoopLifecycleState.REGISTERED
        self._last_started_at = ""
        self._last_stopped_at = ""
        self._last_error = ""

    @property
    def name(self) -> str:
        return self._name

    @property
    def priority(self) -> LoopPriority:
        return self._priority

    @property
    def visibility(self) -> LoopVisibility:
        return self._visibility

    async def start(self) -> None:
        try:
            await self._start_fn()
        except Exception as exc:
            self._state = LoopLifecycleState.FAILED
            self._last_error = str(exc)
            raise
        self._state = LoopLifecycleState.RUNNING
        self._last_started_at = self._utc_now()
        self._last_error = ""

    async def stop(self) -> None:
        try:
            await self._stop_fn()
        except Exception as exc:
            self._state = LoopLifecycleState.FAILED
            self._last_error = str(exc)
            raise
        self._state = LoopLifecycleState.STOPPED
        self._last_stopped_at = self._utc_now()

    def status(self) -> dict[str, Any]:
        details: dict[str, Any]
        try:
            details = dict(self._status_fn() or {})
        except Exception as exc:
            self._state = LoopLifecycleState.FAILED
            self._last_error = str(exc)
            details = {"status_error": str(exc)}
        details.update(
            {
                "name": self._name,
                "priority": int(self._priority),
                "visibility": str(self._visibility),
                "state": str(self._state),
                "last_started_at": self._last_started_at,
                "last_stopped_at": self._last_stopped_at,
                "last_error": self._last_error,
            }
        )
        return details

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()
