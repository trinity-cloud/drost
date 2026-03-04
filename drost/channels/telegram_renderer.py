"""Markdown -> Telegram HTML conversion helpers.

This keeps conversion intentionally small and safe for LLM-style output.
"""

from __future__ import annotations

import html
import re

_FENCED_CODE_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]+)`")

_HR = re.compile(r"(?m)^\s*([-*_])\1\1+\s*$")
_HEADING = re.compile(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*$")
_BULLET = re.compile(r"(?m)^\s*[-*]\s+")
_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
_BOLD_ASTERISK = re.compile(r"\*\*(.+?)\*\*")
_BOLD_UNDERSCORE = re.compile(r"__(.+?)__")
_STRIKE = re.compile(r"~~(.+?)~~")
_ITALIC_ASTERISK = re.compile(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)")
_ITALIC_UNDERSCORE = re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)")


def markdown_to_telegram_html(markdown: str) -> str:
    text = (markdown or "").replace("\r\n", "\n")
    code_blocks: list[str] = []
    inline_codes: list[str] = []

    def _code_block_repl(match: re.Match[str]) -> str:
        code = match.group(1) or ""
        idx = len(code_blocks)
        code_blocks.append(f"<pre><code>{html.escape(code)}</code></pre>")
        return f"\x00CB{idx}\x00"

    def _inline_code_repl(match: re.Match[str]) -> str:
        code = match.group(1) or ""
        idx = len(inline_codes)
        inline_codes.append(f"<code>{html.escape(code)}</code>")
        return f"\x00IC{idx}\x00"

    text = _FENCED_CODE_BLOCK.sub(_code_block_repl, text)
    text = _INLINE_CODE.sub(_inline_code_repl, text)
    text = html.escape(text, quote=True)
    text = _HR.sub("", text)
    text = _HEADING.sub(r"<b>\1</b>", text)
    text = _BULLET.sub("• ", text)

    def _link_repl(match: re.Match[str]) -> str:
        label = match.group(1)
        href = match.group(2).strip()
        if not href:
            return label
        return f'<a href="{href}">{label}</a>'

    text = _LINK.sub(_link_repl, text)
    text = _STRIKE.sub(r"<s>\1</s>", text)
    text = _BOLD_ASTERISK.sub(r"<b>\1</b>", text)
    text = _BOLD_UNDERSCORE.sub(r"<b>\1</b>", text)
    text = _ITALIC_ASTERISK.sub(r"<i>\1</i>", text)
    text = _ITALIC_UNDERSCORE.sub(r"<i>\1</i>", text)

    for idx, block in enumerate(code_blocks):
        text = text.replace(f"\x00CB{idx}\x00", block)
    for idx, code in enumerate(inline_codes):
        text = text.replace(f"\x00IC{idx}\x00", code)
    return text


def split_for_telegram(text: str, *, max_chars: int = 4000) -> list[str]:
    raw = str(text or "")
    if len(raw) <= max_chars:
        return [raw] if raw else []

    chunks: list[str] = []
    remaining = raw
    while remaining:
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break

        window = remaining[: max_chars + 1]
        split_at = window.rfind("\n")
        if split_at <= 0 or split_at < int(max_chars * 0.5):
            split_at = window.rfind(" ")
        if split_at <= 0 or split_at < int(max_chars * 0.5):
            split_at = max_chars

        chunk = remaining[:split_at].rstrip("\n")
        if not chunk:
            chunk = remaining[:max_chars]
            split_at = len(chunk)

        chunks.append(chunk)
        remaining = remaining[split_at:].lstrip("\n")

    return [chunk for chunk in chunks if chunk]
