from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_PROMOTION_HEADER = "## Machine-Promoted"
_PROMOTION_START = "<!-- drost:machine-promoted:start -->"
_PROMOTION_END = "<!-- drost:machine-promoted:end -->"
ALLOWED_PROMOTION_TARGETS = ("TOOLS.md", "MEMORY.md", "USER.md", "IDENTITY.md")
MANUAL_REVIEW_ONLY_PROMOTION_TARGETS = ("IDENTITY.md",)
AUTO_PROMOTION_TARGETS = tuple(
    target for target in ALLOWED_PROMOTION_TARGETS if target not in MANUAL_REVIEW_ONLY_PROMOTION_TARGETS
)
_ALLOWED_TARGETS = set(ALLOWED_PROMOTION_TARGETS)
_ENTRY_RE = re.compile(r"^- \[([a-z0-9_-]+)\] (.+)$", re.IGNORECASE)


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _normalize_kind(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9_-]+", "_", str(value or "").strip().casefold()).strip("_")
    return cleaned or "note"


def normalize_promotion_target(value: str) -> str:
    cleaned = str(value or "").strip()
    return cleaned if cleaned in _ALLOWED_TARGETS else cleaned


def is_manual_review_only_target(target_file: str) -> bool:
    return normalize_promotion_target(target_file) in MANUAL_REVIEW_ONLY_PROMOTION_TARGETS


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass(slots=True, frozen=True)
class PromotionWriteResult:
    path: Path
    target_file: str
    candidate_text: str
    created: bool
    reason: str


class MemoryPromotionStore:
    def __init__(self, workspace_dir: str | Path) -> None:
        self.workspace_dir = Path(workspace_dir).expanduser()

    @property
    def journal_path(self) -> Path:
        return self.workspace_dir / "state" / "promotion-decisions.jsonl"

    def ensure_layout(self) -> None:
        (self.workspace_dir / "state").mkdir(parents=True, exist_ok=True)

    def promote(
        self,
        *,
        target_file: str,
        candidate_text: str,
        kind: str,
    ) -> PromotionWriteResult:
        self.ensure_layout()
        normalized_target = normalize_promotion_target(target_file)
        if normalized_target not in _ALLOWED_TARGETS:
            return PromotionWriteResult(
                path=self.workspace_dir / normalized_target,
                target_file=normalized_target,
                candidate_text=str(candidate_text or "").strip(),
                created=False,
                reason="unsupported_target",
            )
        if is_manual_review_only_target(normalized_target):
            return PromotionWriteResult(
                path=self.workspace_dir / normalized_target,
                target_file=normalized_target,
                candidate_text=str(candidate_text or "").strip(),
                created=False,
                reason="manual_review_required",
            )

        text = str(candidate_text or "").strip()
        if not text:
            return PromotionWriteResult(
                path=self.workspace_dir / normalized_target,
                target_file=normalized_target,
                candidate_text="",
                created=False,
                reason="empty_candidate",
            )

        path = self.workspace_dir / normalized_target
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        entries = self._parse_entries(existing)
        normalized = _normalize_text(text)
        if any(_normalize_text(item["text"]) == normalized for item in entries):
            return PromotionWriteResult(
                path=path,
                target_file=normalized_target,
                candidate_text=text,
                created=False,
                reason="duplicate_candidate",
            )

        entries.append({"kind": _normalize_kind(kind), "text": text})
        entries.sort(key=lambda item: (_normalize_kind(item["kind"]), _normalize_text(item["text"])))
        rendered = self._render_entries(entries)
        updated = self._replace_section(existing, rendered)
        path.write_text(updated, encoding="utf-8")
        return PromotionWriteResult(
            path=path,
            target_file=normalized_target,
            candidate_text=text,
            created=True,
            reason="accepted",
        )

    def record_decision(
        self,
        *,
        target_file: str,
        candidate_text: str,
        kind: str,
        confidence: float | None,
        stability: float | None,
        evidence_refs: list[str],
        why_promotable: str,
        accepted: bool,
        reason: str,
        policy: dict[str, Any] | None = None,
    ) -> Path:
        self.ensure_layout()
        payload = {
            "timestamp": _utc_now(),
            "target_file": normalize_promotion_target(target_file),
            "candidate_text": str(candidate_text or "").strip(),
            "kind": _normalize_kind(kind),
            "confidence": None if confidence is None else float(confidence),
            "stability": None if stability is None else float(stability),
            "evidence_refs": [str(item).strip() for item in evidence_refs if str(item).strip()],
            "why_promotable": str(why_promotable or "").strip(),
            "accepted": bool(accepted),
            "reason": str(reason or "").strip(),
            "policy": dict(policy or {}),
        }
        with self.journal_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return self.journal_path

    def list_decisions(
        self,
        *,
        limit: int = 25,
        target_file: str = "",
        accepted_only: bool = False,
    ) -> list[dict[str, Any]]:
        if not self.journal_path.exists():
            return []
        target = normalize_promotion_target(target_file)
        rows: list[dict[str, Any]] = []
        for line in self.journal_path.read_text(encoding="utf-8").splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            try:
                payload = json.loads(cleaned)
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            if target and normalize_promotion_target(str(payload.get("target_file") or "")) != target:
                continue
            if accepted_only and not bool(payload.get("accepted")):
                continue
            rows.append(payload)
        rows.reverse()
        return rows[: max(1, int(limit))]

    @staticmethod
    def _parse_entries(content: str) -> list[dict[str, str]]:
        block = MemoryPromotionStore._extract_section(content)
        if not block:
            return []
        entries: list[dict[str, str]] = []
        for line in block.splitlines():
            match = _ENTRY_RE.match(line.strip())
            if not match:
                continue
            entries.append({"kind": _normalize_kind(match.group(1)), "text": match.group(2).strip()})
        return entries

    @staticmethod
    def _extract_section(content: str) -> str:
        start = content.find(_PROMOTION_START)
        end = content.find(_PROMOTION_END)
        if start == -1 or end == -1 or end < start:
            return ""
        return content[start + len(_PROMOTION_START) : end].strip("\n")

    @staticmethod
    def _render_entries(entries: list[dict[str, str]]) -> str:
        lines = [_PROMOTION_HEADER, _PROMOTION_START]
        for item in entries:
            lines.append(f"- [{_normalize_kind(item['kind'])}] {item['text'].strip()}")
        lines.append(_PROMOTION_END)
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _replace_section(existing: str, section: str) -> str:
        start = existing.find(_PROMOTION_HEADER)
        marker_start = existing.find(_PROMOTION_START)
        marker_end = existing.find(_PROMOTION_END)
        if start != -1 and marker_start != -1 and marker_end != -1 and start <= marker_start < marker_end:
            end = marker_end + len(_PROMOTION_END)
            suffix = existing[end:]
            if suffix.startswith("\n"):
                suffix = suffix[1:]
            prefix = existing[:start].rstrip()
            if prefix:
                return prefix + "\n\n" + section + (("\n" + suffix.lstrip("\n")) if suffix.strip() else "")
            return section + (("\n" + suffix.lstrip("\n")) if suffix.strip() else "")

        cleaned = existing.rstrip()
        if cleaned:
            return cleaned + "\n\n" + section
        return section
