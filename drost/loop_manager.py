from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from drost.managed_loop import ManagedLoop


class LoopManager:
    def __init__(self) -> None:
        self._loops: dict[str, ManagedLoop] = {}
        self._running = False
        self._lock = asyncio.Lock()
        self._last_error = ""
        self._last_started_at = ""
        self._last_stopped_at = ""

    def register(self, loop: ManagedLoop) -> None:
        if loop.name in self._loops:
            raise ValueError(f"Loop '{loop.name}' is already registered")
        self._loops[loop.name] = loop

    def get(self, name: str) -> ManagedLoop:
        if name not in self._loops:
            raise KeyError(name)
        return self._loops[name]

    def names(self) -> list[str]:
        return [loop.name for loop in self._ordered_loops()]

    async def start(self) -> None:
        async with self._lock:
            if self._running:
                return
            try:
                for loop in self._ordered_loops():
                    await loop.start()
            except Exception as exc:
                self._last_error = str(exc)
                raise
            self._running = True
            self._last_started_at = self._utc_now()
            self._last_error = ""

    async def stop(self) -> None:
        async with self._lock:
            errors: list[str] = []
            for loop in reversed(self._ordered_loops()):
                try:
                    await loop.stop()
                except Exception as exc:
                    errors.append(f"{loop.name}: {exc}")
            self._running = False
            self._last_stopped_at = self._utc_now()
            self._last_error = "; ".join(errors)
            if errors:
                raise RuntimeError(self._last_error)

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "loop_count": len(self._loops),
            "loop_names": self.names(),
            "last_started_at": self._last_started_at,
            "last_stopped_at": self._last_stopped_at,
            "last_error": self._last_error,
            "loops": {loop.name: loop.status() for loop in self._ordered_loops()},
        }

    def _ordered_loops(self) -> list[ManagedLoop]:
        return sorted(self._loops.values(), key=lambda loop: (int(loop.priority), loop.name))

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()
