from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from drost.config import Settings
from drost.context_budget import truncate_text_to_budget

_SOURCE_ORDER = [
    "workspace_memory",
    "session_continuity",
    "daily_memory",
    "entity_summary",
    "entity_item",
    "transcript_message",
    "transcript_tool",
]
_SOURCE_LIMITS = {
    "workspace_memory": 1,
    "session_continuity": 1,
    "daily_memory": 2,
    "entity_summary": 2,
    "entity_item": 1,
    "transcript_message": 2,
    "transcript_tool": 1,
}
_SOURCE_BOOST = {
    "workspace_memory": 0.0050,
    "session_continuity": 0.0045,
    "daily_memory": 0.0040,
    "entity_summary": 0.0035,
    "entity_item": 0.0025,
    "transcript_message": 0.0010,
    "transcript_tool": 0.0008,
}
_SECTION_LABELS = {
    "workspace_memory": "[Relevant MEMORY.md]",
    "session_continuity": "[Session Continuity]",
    "daily_memory": "[Relevant Daily Memory]",
    "entity_summary": "[Relevant Entity Summaries]",
    "entity_item": "[Relevant Atomic Facts]",
    "transcript_message": "[Relevant Transcript Recall]",
    "transcript_tool": "[Relevant Tool Recall]",
}


@dataclass(slots=True)
class _RankedCandidate:
    row: dict[str, Any]
    source_kind: str
    score: float
    lexical_overlap: float


class MemoryCapsuleBuilder:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def build(
        self,
        *,
        query_text: str,
        candidates: list[dict[str, Any]],
        continuity_summary: str = "",
    ) -> str:
        if not self._settings.memory_capsule_enabled:
            return ""

        ranked = self._rank_candidates(
            query_text=query_text,
            candidates=candidates,
            continuity_summary=continuity_summary,
        )
        if not ranked:
            return ""

        selected = self._select_candidates(ranked)
        if not selected:
            return ""

        sections = ["[Memory Capsule]"]
        grouped: dict[str, list[_RankedCandidate]] = defaultdict(list)
        for item in selected:
            grouped[item.source_kind].append(item)

        for source_kind in _SOURCE_ORDER:
            bucket = grouped.get(source_kind) or []
            if not bucket:
                continue
            label = _SECTION_LABELS.get(source_kind, f"[{source_kind}]")
            sections.append(label)
            if source_kind == "session_continuity":
                continuity = str(bucket[0].row.get("content") or bucket[0].row.get("snippet") or "").strip()
                if continuity:
                    sections.append(continuity)
                continue
            for item in bucket:
                sections.append(self._format_candidate(item.row))

        return truncate_text_to_budget(
            "\n".join(section for section in sections if section).strip(),
            self._settings.context_budget_memory_tokens,
        )

    def _rank_candidates(
        self,
        *,
        query_text: str,
        candidates: list[dict[str, Any]],
        continuity_summary: str,
    ) -> list[_RankedCandidate]:
        tokens = self._tokenize(query_text)
        ranked: list[_RankedCandidate] = []
        continuity_loaded = bool(str(continuity_summary or "").strip())

        if continuity_loaded:
            ranked.append(
                _RankedCandidate(
                    row={
                        "id": 0,
                        "source_kind": "session_continuity",
                        "path": "",
                        "title": "session continuity",
                        "content": str(continuity_summary).strip(),
                        "snippet": str(continuity_summary).strip(),
                        "line_start": 1,
                        "line_end": max(1, len(str(continuity_summary).splitlines())),
                    },
                    source_kind="session_continuity",
                    score=1.0,
                    lexical_overlap=self._lexical_overlap(tokens, str(continuity_summary)),
                )
            )

        for raw in candidates:
            if not isinstance(raw, dict):
                continue
            source_kind = str(raw.get("source_kind") or "transcript_message").strip() or "transcript_message"
            if continuity_loaded and source_kind == "session_continuity":
                continue
            content = str(raw.get("snippet") or raw.get("content") or "").strip()
            if not content:
                continue
            base = float(raw.get("fused_score") or raw.get("score") or 0.0)
            lexical = self._lexical_overlap(tokens, self._candidate_text(raw))
            score = base + _SOURCE_BOOST.get(source_kind, 0.0) + (lexical * 0.006)
            ranked.append(
                _RankedCandidate(
                    row=raw,
                    source_kind=source_kind,
                    score=score,
                    lexical_overlap=lexical,
                )
            )

        ranked.sort(
            key=lambda item: (
                -item.score,
                _SOURCE_ORDER.index(item.source_kind) if item.source_kind in _SOURCE_ORDER else 999,
                str(item.row.get("path") or ""),
                int(item.row.get("id") or 0),
            )
        )
        return ranked

    def _select_candidates(self, ranked: list[_RankedCandidate]) -> list[_RankedCandidate]:
        selected: list[_RankedCandidate] = []
        seen_keys: set[tuple[str, str]] = set()
        counts: dict[str, int] = defaultdict(int)

        def add_from(source_kind: str, *, require_overlap: bool = False) -> None:
            limit = int(_SOURCE_LIMITS.get(source_kind, 1))
            for item in ranked:
                if item.source_kind != source_kind:
                    continue
                if counts[source_kind] >= limit:
                    break
                if require_overlap and item.lexical_overlap <= 0.0:
                    continue
                key = self._dedupe_key(item.row, source_kind)
                if key in seen_keys:
                    continue
                selected.append(item)
                seen_keys.add(key)
                counts[source_kind] += 1

        add_from("workspace_memory")
        add_from("session_continuity")
        add_from("daily_memory")
        add_from("entity_summary")

        primary_count = sum(counts[kind] for kind in ("workspace_memory", "session_continuity", "daily_memory", "entity_summary"))
        if primary_count < 3:
            add_from("entity_item", require_overlap=True)
        if primary_count < 3 or not selected:
            add_from("transcript_message", require_overlap=True)
            add_from("transcript_tool", require_overlap=True)

        if not selected:
            for item in ranked[:3]:
                key = self._dedupe_key(item.row, item.source_kind)
                if key in seen_keys:
                    continue
                selected.append(item)
                seen_keys.add(key)

        selected.sort(
            key=lambda item: (
                _SOURCE_ORDER.index(item.source_kind) if item.source_kind in _SOURCE_ORDER else 999,
                -item.score,
                str(item.row.get("path") or ""),
                int(item.row.get("id") or 0),
            )
        )
        return selected

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        return {token for token in re.findall(r"[a-z0-9_]{3,}", str(text or "").lower()) if token}

    @classmethod
    def _lexical_overlap(cls, query_tokens: set[str], text: str) -> float:
        if not query_tokens:
            return 0.0
        haystack = str(text or "").lower()
        matches = sum(1 for token in query_tokens if token in haystack)
        if matches <= 0:
            return 0.0
        return matches / max(1, len(query_tokens))

    @staticmethod
    def _candidate_text(row: dict[str, Any]) -> str:
        return " ".join(
            part
            for part in [
                str(row.get("title") or "").strip(),
                str(row.get("path") or "").strip(),
                str(row.get("snippet") or row.get("content") or "").strip(),
            ]
            if part
        )

    @staticmethod
    def _dedupe_key(row: dict[str, Any], source_kind: str) -> tuple[str, str]:
        path = str(row.get("path") or "").strip()
        title = str(row.get("title") or "").strip()
        identifier = str(row.get("id") or "").strip()
        return source_kind, path or title or identifier

    @staticmethod
    def _format_candidate(row: dict[str, Any]) -> str:
        label = (
            str(row.get("title") or "").strip()
            or str(row.get("path") or "").strip()
            or str(row.get("session_key") or "").strip()
            or str(row.get("source_kind") or "memory").strip()
        )
        path = str(row.get("path") or "").strip()
        line_start = int(row.get("line_start") or 1)
        line_end = int(row.get("line_end") or line_start)
        location = path
        if path:
            location = f"{path}:{line_start}" if line_start == line_end else f"{path}:{line_start}-{line_end}"
        snippet = str(row.get("snippet") or row.get("content") or "").strip()
        if len(snippet) > 500:
            snippet = snippet[:500].rstrip() + "..."
        if location and location != label:
            return f"- ({label}; {location}) {snippet}"
        return f"- ({label}) {snippet}"
