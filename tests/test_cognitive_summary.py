from __future__ import annotations

from pathlib import Path

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.cognitive_summary import CognitiveSummaryBuilder
from drost.config import Settings


def test_cognitive_summary_builder_includes_relevant_reflections_and_agenda(tmp_path: Path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    artifacts.append_reflection(
        {
            "reflection_id": "refl_docs",
            "timestamp": "2026-03-11T01:00:00Z",
            "kind": "pattern",
            "summary": "Documentation and runtime topology keep drifting apart.",
            "importance": 0.9,
            "actionability": 0.8,
            "novelty": 0.5,
            "suggested_drive_tags": ["docs", "runtime"],
        }
    )
    artifacts.append_reflection(
        {
            "reflection_id": "refl_health",
            "timestamp": "2026-03-11T01:05:00Z",
            "kind": "pattern",
            "summary": "A separate health thread needs a later follow-up.",
            "importance": 0.6,
            "actionability": 0.4,
            "novelty": 0.3,
            "suggested_drive_tags": ["health"],
        }
    )
    artifacts.replace_drive_state(
        {
            "active_items": [
                {
                    "drive_id": "drv_docs",
                    "title": "Tighten operator docs",
                    "summary": "Bring runtime docs back in line with managed loops.",
                    "kind": "open_thread",
                    "priority": 0.95,
                    "urgency": 0.7,
                    "confidence": 0.85,
                    "recommended_channel": "conversation_only",
                },
                {
                    "drive_id": "drv_health",
                    "title": "Health follow-up",
                    "summary": "Check back on the health thread later.",
                    "kind": "open_thread",
                    "priority": 0.4,
                    "urgency": 0.3,
                    "confidence": 0.5,
                    "recommended_channel": "hold",
                },
            ]
        }
    )
    artifacts.replace_attention_state(
        {
            "current_focus_kind": "drive",
            "current_focus_summary": "Docs are the current top thread.",
            "top_priority_tags": ["docs", "runtime"],
        }
    )

    builder = CognitiveSummaryBuilder(
        Settings(workspace_dir=tmp_path, context_budget_memory_tokens=2000),
        artifact_store=artifacts,
    )
    summary = builder.build(query_text="Can you update the runtime docs and loop architecture notes?")

    assert "[Recent Reflections]" in summary
    assert "Documentation and runtime topology keep drifting apart." in summary
    assert "[Current Internal Agenda]" in summary
    assert "Tighten operator docs" in summary
    assert "[Attention Tags]" in summary
    assert "docs, runtime" in summary
    assert "Health follow-up" not in summary


def test_cognitive_summary_builder_returns_empty_without_cognition(tmp_path: Path) -> None:
    builder = CognitiveSummaryBuilder(Settings(workspace_dir=tmp_path))

    assert builder.build(query_text="hello") == ""
