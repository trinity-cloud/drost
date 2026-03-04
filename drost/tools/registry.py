from __future__ import annotations

from typing import Any

from drost.providers.base import ToolDefinition
from drost.tools.base import BaseTool


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def get(self, name: str) -> BaseTool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def to_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name=tool.name,
                description=tool.description,
                input_schema=tool.parameters,
            )
            for tool in self._tools.values()
        ]

    async def dispatch(self, name: str, params: dict[str, Any] | None) -> str:
        tool = self.get(name)
        if not tool:
            return f"Error: Unknown tool '{name}'"

        cleaned: dict[str, Any] = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            return await tool.execute(**cleaned)
        except Exception as exc:
            return f"Error executing {name}: {exc}"

