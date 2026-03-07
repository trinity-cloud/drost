from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from drost.config import Settings
from drost.embeddings import EmbeddingService


class _FakeAsyncModels:
    def __init__(self, calls: list[dict[str, object]]) -> None:
        self._calls = calls

    async def embed_content(self, *, model: str, contents: str, config: object) -> object:
        self._calls.append({"model": model, "contents": contents, "config": config})
        return SimpleNamespace(
            embeddings=[
                SimpleNamespace(
                    values=[0.5, 0.25, 0.25],
                    statistics=SimpleNamespace(truncated=False, token_count=3),
                )
            ]
        )


class _FakeAsyncClient:
    def __init__(self, calls: list[dict[str, object]]) -> None:
        self.models = _FakeAsyncModels(calls)

    async def aclose(self) -> None:
        return None


class _FakeGeminiClient:
    def __init__(self, api_key: str, calls: list[dict[str, object]]) -> None:
        self.api_key = api_key
        self.aio = _FakeAsyncClient(calls)
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeEmbedContentConfig:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = dict(kwargs)


@pytest.mark.asyncio
async def test_embedding_service_uses_gemini_task_types(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []

    genai_module = ModuleType("google.genai")
    genai_module.types = SimpleNamespace(EmbedContentConfig=_FakeEmbedContentConfig)

    monkeypatch.setitem(sys.modules, "google.genai", genai_module)

    settings = Settings(
        workspace_dir=tmp_path,
        memory_embedding_provider="none",
        memory_embedding_model="gemini-embedding-001",
        memory_embedding_dimensions=3072,
    )
    service = EmbeddingService(settings)
    service._client = _FakeGeminiClient("test-gemini-key", calls)
    service._client_type = "gemini"
    service._provider = "gemini"

    query_vec = await service.embed_query("find prior preference")
    doc_vec = await service.embed_document(
        "The user prefers structured answers.",
        title="preferences/migel",
    )

    assert len(query_vec) == 3072
    assert len(doc_vec) == 3072
    assert calls[0]["model"] == "gemini-embedding-001"
    assert calls[0]["contents"] == "find prior preference"
    assert calls[0]["config"].kwargs["taskType"] == "RETRIEVAL_QUERY"
    assert calls[1]["config"].kwargs["taskType"] == "RETRIEVAL_DOCUMENT"
    assert calls[1]["config"].kwargs["title"] == "preferences/migel"
    await service.close()
