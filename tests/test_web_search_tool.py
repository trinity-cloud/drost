from __future__ import annotations

import json
from typing import Any

import pytest

from drost.tools.web_search import WebSearchTool


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], *, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeAsyncClient:
    def __init__(self, payload: dict[str, Any], calls: list[dict[str, Any]], **kwargs: Any) -> None:
        self._payload = payload
        self._calls = calls
        _ = kwargs

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        _ = exc_type, exc, tb
        return None

    async def post(self, url: str, *, headers: dict[str, str], content: str) -> _FakeResponse:
        self._calls.append(
            {
                "url": url,
                "headers": dict(headers),
                "payload": json.loads(content),
            }
        )
        return _FakeResponse(self._payload)


@pytest.mark.asyncio
async def test_web_search_uses_news_recency_hints_for_fresh_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    response_payload = {
        "results": [
            {
                "title": "Iran live updates",
                "url": "https://example.com/live",
                "publishedDate": "2026-03-04T00:00:00.000Z",
                "summary": "Major events are unfolding.",
            }
        ]
    }

    def _fake_client_factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
        _ = args
        return _FakeAsyncClient(response_payload, calls, **kwargs)

    monkeypatch.setattr("drost.tools.web_search.httpx.AsyncClient", _fake_client_factory)

    tool = WebSearchTool(api_key="test-key")
    output = await tool.execute(query="latest Iran situation update", limit=3)

    assert "Iran live updates" in output
    assert "Major events are unfolding." in output
    assert len(calls) == 1
    sent = calls[0]["payload"]
    assert sent["numResults"] == 3
    assert sent["category"] == "news"
    assert "startPublishedDate" in sent
    assert sent["contents"]["livecrawl"] == "preferred"
    assert sent["contents"]["summary"]["query"] == "latest Iran situation update"
    assert "type" not in sent


@pytest.mark.asyncio
async def test_web_search_honors_explicit_category_without_forced_recency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    response_payload = {
        "results": [
            {
                "title": "Tokio runtime repo",
                "url": "https://github.com/tokio-rs/tokio",
            }
        ]
    }

    def _fake_client_factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
        _ = args
        return _FakeAsyncClient(response_payload, calls, **kwargs)

    monkeypatch.setattr("drost.tools.web_search.httpx.AsyncClient", _fake_client_factory)

    tool = WebSearchTool(api_key="test-key")
    output = await tool.execute(query="tokio async runtime", category="github", limit=2)

    assert "Tokio runtime repo" in output
    assert len(calls) == 1
    sent = calls[0]["payload"]
    assert sent["category"] == "github"
    assert sent["numResults"] == 2
    assert "startPublishedDate" not in sent
    assert "contents" not in sent


@pytest.mark.asyncio
async def test_web_search_rejects_unknown_category() -> None:
    tool = WebSearchTool(api_key="test-key")
    out = await tool.execute(query="anything", category="foobar")
    assert "unsupported category" in out
