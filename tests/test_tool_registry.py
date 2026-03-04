from __future__ import annotations

import pytest

from drost.tools.base import BaseTool
from drost.tools.registry import ToolRegistry


class EchoTool(BaseTool):
    @property
    def name(self) -> str:
        return "echo"

    @property
    def description(self) -> str:
        return "Echo tool for tests."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "suffix": {"type": "string"},
            },
            "required": ["text"],
        }

    async def execute(self, **kwargs: object) -> str:
        text = str(kwargs.get("text") or "")
        suffix = str(kwargs.get("suffix") or "default")
        return f"{text}|{suffix}"


@pytest.mark.asyncio
async def test_registry_dispatch_strips_none() -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())

    result = await registry.dispatch("echo", {"text": "hello", "suffix": None})
    assert result == "hello|default"


@pytest.mark.asyncio
async def test_registry_unknown_tool() -> None:
    registry = ToolRegistry()
    result = await registry.dispatch("missing", {"x": 1})
    assert "Unknown tool" in result

