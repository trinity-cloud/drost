from __future__ import annotations

import re

import httpx

from drost.tools.base import BaseTool

_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


class WebFetchTool(BaseTool):
    def __init__(self, *, default_max_chars: int = 8_000) -> None:
        self._default_max_chars = max(512, int(default_max_chars))

    @property
    def name(self) -> str:
        return "web_fetch"

    @property
    def description(self) -> str:
        return "Fetch URL content and return readable text."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch."},
                "max_chars": {"type": "integer", "description": "Maximum output text length."},
            },
            "required": ["url"],
        }

    @staticmethod
    def _html_to_text(html: str) -> str:
        without_scripts = _SCRIPT_RE.sub(" ", html)
        without_tags = _TAG_RE.sub(" ", without_scripts)
        return _WS_RE.sub(" ", without_tags).strip()

    async def execute(self, *, url: str, max_chars: int | None = None) -> str:
        target = str(url or "").strip()
        if not target:
            return "Error: url is required"
        if not (target.startswith("http://") or target.startswith("https://")):
            return "Error: url must start with http:// or https://"

        cap = self._default_max_chars if max_chars is None else max(256, min(int(max_chars), 64_000))
        timeout = httpx.Timeout(20.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(target)
        if resp.status_code >= 400:
            body = resp.text[:300]
            return f"Error: fetch failed ({resp.status_code}): {body}"

        ctype = str(resp.headers.get("content-type") or "").lower()
        raw = resp.text
        text = self._html_to_text(raw) if "html" in ctype else raw
        if len(text) > cap:
            text = text[:cap] + f"\n...[truncated {len(text) - cap} chars]"

        return (
            f"url={str(resp.url)}\n"
            f"status={resp.status_code}\n"
            f"content_type={ctype}\n\n"
            f"{text}"
        )

