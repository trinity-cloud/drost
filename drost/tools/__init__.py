from __future__ import annotations

from collections.abc import Callable

from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.followups import FollowUpStore
from drost.storage import SQLiteStore, WorkspaceMemoryIndexer
from drost.tools.deployer_request import DeployerRequestTool
from drost.tools.deployer_status import DeployerStatusTool
from drost.tools.file_read import FileReadTool
from drost.tools.file_write import FileWriteTool
from drost.tools.followup_status import FollowUpStatusTool
from drost.tools.followup_update import FollowUpUpdateTool
from drost.tools.memory_get import MemoryGetTool
from drost.tools.memory_search import MemorySearchTool
from drost.tools.registry import ToolRegistry
from drost.tools.session_status import SessionStatusTool
from drost.tools.shell_execute import ShellExecuteTool
from drost.tools.web_fetch import WebFetchTool
from drost.tools.web_search import WebSearchTool
from drost.tools.worker_request import WorkerRequestTool
from drost.tools.worker_status import WorkerStatusTool

__all__ = [
    "ToolRegistry",
    "build_default_registry",
]


def build_default_registry(
    *,
    settings: Settings,
    store: SQLiteStore,
    embeddings: EmbeddingService,
    workspace_memory_indexer: WorkspaceMemoryIndexer,
    followups: FollowUpStore,
    current_chat_id: Callable[[], int],
    current_session_key: Callable[[], str],
) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        MemorySearchTool(
            store=store,
            embeddings=embeddings,
            workspace_memory_indexer=workspace_memory_indexer,
            default_limit=settings.memory_top_k,
        )
    )
    registry.register(FollowUpStatusTool(followups=followups, current_chat_id=current_chat_id))
    registry.register(FollowUpUpdateTool(followups=followups, current_chat_id=current_chat_id))
    registry.register(MemoryGetTool(store=store, workspace_dir=settings.workspace_dir))
    registry.register(
        SessionStatusTool(
            settings=settings,
            store=store,
            current_chat_id=current_chat_id,
            current_session_key=current_session_key,
        )
    )
    registry.register(DeployerStatusTool(settings=settings))
    registry.register(DeployerRequestTool(settings=settings))
    registry.register(WorkerStatusTool(settings=settings))
    registry.register(WorkerRequestTool(settings=settings))
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(ShellExecuteTool(default_timeout_seconds=settings.agent_tool_timeout_seconds))
    registry.register(WebSearchTool(api_key=settings.exa_api_key))
    registry.register(WebFetchTool())
    return registry
