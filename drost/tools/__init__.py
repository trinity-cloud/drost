from __future__ import annotations

import os
from collections.abc import Callable

from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.storage import SQLiteStore
from drost.tools.file_read import FileReadTool
from drost.tools.file_write import FileWriteTool
from drost.tools.memory_get import MemoryGetTool
from drost.tools.memory_search import MemorySearchTool
from drost.tools.registry import ToolRegistry
from drost.tools.session_status import SessionStatusTool
from drost.tools.shell_execute import ShellExecuteTool
from drost.tools.web_fetch import WebFetchTool
from drost.tools.web_search import WebSearchTool

__all__ = [
    "ToolRegistry",
    "build_default_registry",
]


def build_default_registry(
    *,
    settings: Settings,
    store: SQLiteStore,
    embeddings: EmbeddingService,
    current_chat_id: Callable[[], int],
    current_session_key: Callable[[], str],
) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(MemorySearchTool(store=store, embeddings=embeddings, default_limit=settings.memory_top_k))
    registry.register(MemoryGetTool(store=store))
    registry.register(
        SessionStatusTool(
            store=store,
            current_chat_id=current_chat_id,
            current_session_key=current_session_key,
        )
    )
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(ShellExecuteTool(default_timeout_seconds=settings.agent_tool_timeout_seconds))
    registry.register(WebSearchTool(api_key=(os.environ.get("EXA_API_KEY") or "").strip()))
    registry.register(WebFetchTool())
    return registry

