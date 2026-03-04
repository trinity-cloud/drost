from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from drost.tools.base import BaseTool

EXA_SEARCH_URL = "https://api.exa.ai/search"
_FRESH_QUERY_RE = re.compile(r"\b(latest|today|current|recent|breaking|update|now)\b", re.IGNORECASE)
_CATEGORY_VALUES = (
    "news",
    "company",
    "research paper",
    "pdf",
    "github",
    "tweet",
    "personal site",
    "linkedin profile",
    "financial report",
)


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
                "category": {
                    "type": "string",
                    "description": "Optional Exa category filter (e.g. news, company, research paper).",
                    "enum": list(_CATEGORY_VALUES),
                },
                "recency_days": {
                    "type": "integer",
                    "description": "Prefer results published in the last N days.",
                    "minimum": 1,
                },
            },
            "required": ["query"],
        }

    @staticmethod
    def _clip(text: str, limit: int = 220) -> str:
        cleaned = " ".join((text or "").split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[:limit].rstrip() + "..."

    @staticmethod
    def _is_fresh_intent(query: str) -> bool:
        return bool(_FRESH_QUERY_RE.search(query or ""))

    @staticmethod
    def _iso_utc_days_ago(days: int) -> str:
        ts = datetime.now(UTC) - timedelta(days=days)
        return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    async def execute(
        self,
        *,
        query: str,
        limit: int | None = None,
        category: str | None = None,
        recency_days: int | None = None,
    ) -> str:
        if not self._api_key:
            return "Error: EXA_API_KEY is not configured"

        query_text = str(query or "").strip()
        if not query_text:
            return "Error: query is required"

        k = 5 if limit is None else max(1, min(int(limit), 10))
        fresh_intent = self._is_fresh_intent(query_text)

        category_text = str(category or "").strip().lower()
        if category_text and category_text not in _CATEGORY_VALUES:
            return f"Error: unsupported category '{category_text}'"
        if not category_text and fresh_intent:
            category_text = "news"

        payload: dict[str, Any] = {
            "query": query_text,
            "numResults": k,
            # Leave type unset: Exa defaults to auto mode and chooses the best search strategy.
        }
        if category_text:
            payload["category"] = category_text

        days = None
        if recency_days is not None:
            days = max(1, min(int(recency_days), 3650))
        elif fresh_intent:
            days = 14
        if days is not None:
            payload["startPublishedDate"] = self._iso_utc_days_ago(days)
            payload["contents"] = {
                "livecrawl": "preferred",
                "summary": {"query": query_text},
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
            summary = self._clip(str(item.get("summary") or ""), 320)
            snippet = self._clip(str(item.get("text") or ""))
            if not snippet:
                highlights = item.get("highlights")
                if isinstance(highlights, list):
                    snippet = self._clip(" ".join(str(x or "") for x in highlights), 320)
            if not snippet:
                snippet = summary
            lines.append(f"{idx}. {title}")
            if url:
                lines.append(f"   url: {url}")
            if published:
                lines.append(f"   published: {published}")
            if snippet:
                lines.append(f"   snippet: {snippet}")
        return "\n".join(lines)
