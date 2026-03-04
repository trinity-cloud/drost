from __future__ import annotations

import html
import re

import httpx
from bs4 import BeautifulSoup, Comment  # type: ignore[import-untyped]

from drost.tools.base import BaseTool

_SCRIPT_RE = re.compile(r"<(script|style|noscript|template)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_MAIN_SELECTORS = (
    "main",
    "article",
    "[role='main']",
    ".article",
    ".post",
    ".entry-content",
    ".story",
    ".main-content",
    "#main",
    "#content",
)
_NOISE_SELECTORS = (
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "svg",
    "canvas",
    "button",
    "[aria-hidden='true']",
    "[class*='cookie']",
    "[id*='cookie']",
    "[class*='consent']",
    "[id*='consent']",
    "[class*='newsletter']",
    "[id*='newsletter']",
    "[class*='subscribe']",
    "[id*='subscribe']",
    "[class*='advert']",
    "[id*='advert']",
    "[class*='banner']",
    "[id*='banner']",
    "[class*='social']",
    "[id*='social']",
    "[class*='share']",
    "[id*='share']",
    "[class*='breadcrumb']",
    "[id*='breadcrumb']",
)


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
    def _clean_whitespace(text: str) -> str:
        lines = []
        for raw_line in str(text or "").splitlines():
            line = _WS_RE.sub(" ", raw_line).strip()
            if line:
                lines.append(line)
        return "\n".join(lines).strip()

    @staticmethod
    def _regex_html_to_text(raw_html: str) -> str:
        without_scripts = _SCRIPT_RE.sub(" ", raw_html)
        without_tags = _TAG_RE.sub(" ", without_scripts)
        unescaped = html.unescape(without_tags.replace("&nbsp;", " "))
        return _WS_RE.sub(" ", unescaped).strip()

    @classmethod
    def _select_content_root(cls, soup: BeautifulSoup) -> BeautifulSoup:
        body = soup.body or soup
        best = body
        best_len = len(cls._clean_whitespace(body.get_text("\n", strip=True)))
        for selector in _MAIN_SELECTORS:
            for node in soup.select(selector):
                text_len = len(cls._clean_whitespace(node.get_text("\n", strip=True)))
                if text_len > best_len:
                    best = node
                    best_len = text_len
        return best

    @classmethod
    def _html_to_text_with_soup(cls, raw_html: str) -> str:
        soup = BeautifulSoup(raw_html, "html.parser")
        for node in soup(["script", "style", "noscript", "template"]):
            node.decompose()
        for selector in _NOISE_SELECTORS:
            for node in soup.select(selector):
                node.decompose()
        for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
            comment.extract()

        root = cls._select_content_root(soup)
        text = root.get_text("\n", strip=True)
        cleaned = cls._clean_whitespace(html.unescape(text.replace("&nbsp;", " ")))
        if cleaned:
            return cleaned
        fallback = cls._clean_whitespace(html.unescape((soup.body or soup).get_text("\n", strip=True)))
        return fallback

    @classmethod
    def _html_to_text(cls, html: str) -> str:
        try:
            extracted = cls._html_to_text_with_soup(html)
            if extracted:
                return extracted
        except Exception:
            # Fallback remains available even if parser fails on malformed HTML.
            pass
        return cls._regex_html_to_text(html)

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
