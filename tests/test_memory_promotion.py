from __future__ import annotations

import json
from pathlib import Path

from drost.memory_promotion import MemoryPromotionStore


def test_memory_promotion_store_writes_managed_section_and_dedupes(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    user_path = workspace / "USER.md"
    user_path.write_text("# USER\n\nHuman-edited context lives here.\n", encoding="utf-8")

    store = MemoryPromotionStore(workspace)

    first = store.promote(
        target_file="USER.md",
        candidate_text="Prefers direct, factual communication with no fluff.",
        kind="communication_style",
    )
    second = store.promote(
        target_file="USER.md",
        candidate_text="Prefers direct, factual communication with no fluff.",
        kind="communication_style",
    )

    content = user_path.read_text(encoding="utf-8")
    assert first.created is True
    assert second.created is False
    assert second.reason == "duplicate_candidate"
    assert "Human-edited context lives here." in content
    assert "## Machine-Promoted" in content
    assert "<!-- drost:machine-promoted:start -->" in content
    assert "- [communication_style] Prefers direct, factual communication with no fluff." in content


def test_memory_promotion_store_records_decisions(tmp_path: Path) -> None:
    store = MemoryPromotionStore(tmp_path)
    path = store.record_decision(
        target_file="MEMORY.md",
        candidate_text="Main repo root is /Users/migel/drost.",
        kind="operational_context",
        confidence=0.97,
        stability=0.95,
        evidence_refs=["sessions/a.jsonl:12"],
        why_promotable="Directly affects future response quality.",
        accepted=True,
        reason="accepted",
    )

    row = json.loads(path.read_text(encoding="utf-8").strip())
    assert row["target_file"] == "MEMORY.md"
    assert row["accepted"] is True
    assert row["reason"] == "accepted"
    assert row["kind"] == "operational_context"


def test_memory_promotion_store_supports_tools_md_target(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    tools_path = workspace / "TOOLS.md"
    tools_path.write_text("# TOOLS\n\nManual discipline.\n", encoding="utf-8")

    store = MemoryPromotionStore(workspace)
    result = store.promote(
        target_file="TOOLS.md",
        candidate_text="Verify worker state through worker_status before claiming completion.",
        kind="operational_truth",
    )

    content = tools_path.read_text(encoding="utf-8")
    assert result.created is True
    assert result.reason == "accepted"
    assert "Manual discipline." in content
    assert "Verify worker state through worker_status before claiming completion." in content
