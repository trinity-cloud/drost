from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable

from fastapi import FastAPI


class BaseChannel(ABC):
    @abstractmethod
    async def start(self, app: FastAPI) -> None:
        ...

    @abstractmethod
    async def stop(self) -> None:
        ...

    @abstractmethod
    async def send(self, target: str | int, message: str, **kwargs: Any) -> Any:
        ...

    @abstractmethod
    def set_message_handler(self, handler: Callable[[dict[str, Any]], Awaitable[str | None]]) -> None:
        ...
