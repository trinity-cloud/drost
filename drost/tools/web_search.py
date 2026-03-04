from __future__ import annotations

import json
from typing import Any

import httpx

from drost.tools.base import BaseTool

EXA_SEARCH_URL = "https://api.exa.ai/search"


class WebSearchTool(BaseTool):
    def __init__(self, *, api_key: str) -> None:
        self._api_key = (api_key or "").strip()

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return "Search the web using Exa and return ranked results."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
                "limit": {"type": "integer", "description": "Number of results.", "minimum": 1},
            },
            "required": ["query"],
        }

    @staticmethod
    def _clip(text: str, limit: int = 220) -> str:
        cleaned = " ".join((text or "").split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[:limit].rstrip() + "..."

    async def execute(self, *, query: str, limit: int | None = None) -> str:
        if not self._api_key:
            return "Error: EXA_API_KEY is not configured"

        query_text = str(query or "").strip()
        if not query_text:
            return "Error: query is required"

        k = 5 if limit is None else max(1, min(int(limit), 10))
        payload: dict[str, Any] = {
            "query": query_text,
            "numResults": k,
            "type": "keyword",
        }
        headers = {
            "x-api-key": self._api_key,
            "content-type": "application/json",
        }
        timeout = httpx.Timeout(20.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(EXA_SEARCH_URL, headers=headers, content=json.dumps(payload))
            if resp.status_code >= 400:
                body = self._clip(resp.text, 300)
                return f"Error: Exa search failed ({resp.status_code}): {body}"
            data = resp.json()

        results = data.get("results")
        if not isinstance(results, list) or not results:
            return "No web search results found."

        lines = [f"Exa search results for: {query_text}"]
        for idx, item in enumerate(results[:k], start=1):
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip() or "(untitled)"
            url = str(item.get("url") or "").strip()
            published = str(item.get("publishedDate") or "").strip()
            snippet = self._clip(str(item.get("text") or ""))
            lines.append(f"{idx}. {title}")
            if url:
                lines.append(f"   url: {url}")
            if published:
                lines.append(f"   published: {published}")
            if snippet:
                lines.append(f"   snippet: {snippet}")
        return "\n".join(lines)

