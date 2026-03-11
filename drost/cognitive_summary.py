from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.config import Settings
from drost.context_budget import truncate_text_to_budget


@dataclass(slots=True)
class _RankedReflection:
    row: dict[str, Any]
    score: float
    lexical_overlap: float


@dataclass(slots=True)
class _RankedAgendaItem:
    row: dict[str, Any]
    score: float
    lexical_overlap: float


class CognitiveSummaryBuilder:
    def __init__(
        self,
        settings: Settings,
        *,
        artifact_store: CognitiveArtifactStore | None = None,
    ) -> None:
        self._settings = settings
        self._artifact_store = artifact_store or CognitiveArtifactStore(settings.workspace_dir)

    def build(self, *, query_text: str) -> str:
        summary = self._artifact_store.summary()
        reflections = self._artifact_store.list_reflections(limit=8)
        drive_state = self._artifact_store.load_drive_state()
        agenda_items = list(drive_state.get("active_items") or [])

        if not reflections and not agenda_items:
            return ""

        query_tokens = self._tokenize(query_text)
        ranked_reflections = self._rank_reflections(query_tokens, reflections)
        ranked_agenda = self._rank_agenda(query_tokens, agenda_items)

        selected_reflections = self._select_reflections(ranked_reflections)
        selected_agenda = self._select_agenda(ranked_agenda)
        if not selected_reflections and not selected_agenda:
            return ""

        sections: list[str] = []
        if selected_reflections:
            sections.append("[Recent Reflections]")
            for item in selected_reflections:
                sections.append(self._format_reflection(item.row))
        if selected_agenda:
            sections.append("[Current Internal Agenda]")
            for item in selected_agenda:
                sections.append(self._format_agenda_item(item.row))

        attention = dict(summary.get("attention") or {})
        tags = [str(tag).strip() for tag in list(attention.get("top_priority_tags") or []) if str(tag).strip()]
        if tags:
            sections.append("[Attention Tags]")
            sections.append("- " + ", ".join(tags[:5]))

        block = "\n".join(section for section in sections if section).strip()
        if not block:
            return ""
        budget_tokens = max(200, min(1200, int(self._settings.context_budget_memory_tokens) // 2))
        return truncate_text_to_budget(block, budget_tokens)

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        stopwords = {
            "the",
            "and",
            "for",
            "with",
            "that",
            "this",
            "you",
            "your",
            "are",
            "can",
            "from",
            "into",
            "what",
            "when",
            "have",
            "will",
            "should",
            "would",
            "about",
            "then",
            "than",
            "but",
            "still",
            "back",
            "need",
            "needs",
            "later",
            "line",
        }
        return {
            token
            for token in re.findall(r"[a-z0-9_]{3,}", str(text or "").lower())
            if token and token not in stopwords
        }

    @classmethod
    def _lexical_overlap(cls, query_tokens: set[str], text: str) -> float:
        if not query_tokens:
            return 0.0
        haystack = str(text or "").lower()
        matches = sum(1 for token in query_tokens if token in haystack)
        return matches / max(1, len(query_tokens))

    def _rank_reflections(self, query_tokens: set[str], reflections: list[dict[str, Any]]) -> list[_RankedReflection]:
        ranked: list[_RankedReflection] = []
        for row in reflections:
            if not isinstance(row, dict):
                continue
            text = " ".join(
                [
                    str(row.get("kind") or ""),
                    str(row.get("summary") or ""),
                    " ".join(str(tag) for tag in list(row.get("suggested_drive_tags") or [])),
                ]
            )
            lexical = self._lexical_overlap(query_tokens, text)
            score = (
                float(row.get("importance") or 0.0) * 0.012
                + float(row.get("actionability") or 0.0) * 0.010
                + float(row.get("novelty") or 0.0) * 0.004
                + lexical * 0.018
            )
            ranked.append(_RankedReflection(row=row, score=score, lexical_overlap=lexical))
        ranked.sort(
            key=lambda item: (
                -item.score,
                str(item.row.get("timestamp") or ""),
                str(item.row.get("reflection_id") or ""),
            )
        )
        return ranked

    def _rank_agenda(self, query_tokens: set[str], agenda_items: list[dict[str, Any]]) -> list[_RankedAgendaItem]:
        ranked: list[_RankedAgendaItem] = []
        for row in agenda_items:
            if not isinstance(row, dict):
                continue
            text = " ".join(
                [
                    str(row.get("title") or ""),
                    str(row.get("summary") or ""),
                    str(row.get("kind") or ""),
                    " ".join(str(ref) for ref in list(row.get("source_refs") or [])),
                ]
            )
            lexical = self._lexical_overlap(query_tokens, text)
            score = (
                float(row.get("priority") or 0.0) * 0.012
                + float(row.get("urgency") or 0.0) * 0.010
                + float(row.get("confidence") or 0.0) * 0.006
                + lexical * 0.020
            )
            ranked.append(_RankedAgendaItem(row=row, score=score, lexical_overlap=lexical))
        ranked.sort(
            key=lambda item: (
                -item.score,
                str(item.row.get("next_review_at") or ""),
                str(item.row.get("drive_id") or ""),
            )
        )
        return ranked

    @staticmethod
    def _select_reflections(ranked: list[_RankedReflection]) -> list[_RankedReflection]:
        if not ranked:
            return []
        overlap_hits = [item for item in ranked if item.lexical_overlap > 0.0][:2]
        if overlap_hits:
            return overlap_hits
        return ranked[:1]

    @staticmethod
    def _select_agenda(ranked: list[_RankedAgendaItem]) -> list[_RankedAgendaItem]:
        if not ranked:
            return []
        overlap_hits = [item for item in ranked if item.lexical_overlap > 0.0][:3]
        if overlap_hits:
            return overlap_hits
        return ranked[:2]

    @staticmethod
    def _format_reflection(row: dict[str, Any]) -> str:
        importance = float(row.get("importance") or 0.0)
        actionability = float(row.get("actionability") or 0.0)
        summary = str(row.get("summary") or "").strip()
        tags = [str(tag).strip() for tag in list(row.get("suggested_drive_tags") or []) if str(tag).strip()]
        line = f"- (importance={importance:.2f}; actionability={actionability:.2f}) {summary}"
        if tags:
            line += f" [tags: {', '.join(tags[:4])}]"
        return line

    @staticmethod
    def _format_agenda_item(row: dict[str, Any]) -> str:
        priority = float(row.get("priority") or 0.0)
        urgency = float(row.get("urgency") or 0.0)
        channel = str(row.get("recommended_channel") or "hold").strip() or "hold"
        title = str(row.get("title") or "").strip()
        summary = str(row.get("summary") or "").strip()
        line = f"- (priority={priority:.2f}; urgency={urgency:.2f}; channel={channel}) {title}"
        if summary:
            line += f" — {summary}"
        return line
