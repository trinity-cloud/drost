from __future__ import annotations

from pathlib import Path

from drost.cognitive_artifacts import CognitiveArtifactStore


def test_cognitive_artifact_store_writes_and_summarizes_reflections(tmp_path: Path) -> None:
    store = CognitiveArtifactStore(tmp_path)

    store.append_reflection(
        {
            "reflection_id": "refl_a",
            "timestamp": "2026-03-10T20:00:00Z",
            "kind": "pattern",
            "summary": "Migel prefers mechanistic explanations over generic advice.",
            "importance": 0.9,
            "suggested_drive_tags": ["health", "communication"],
        }
    )
    store.append_reflection(
        {
            "reflection_id": "refl_b",
            "timestamp": "2026-03-10T21:00:00Z",
            "kind": "insight",
            "summary": "README polish is currently a product-level priority.",
            "importance": 0.6,
            "suggested_drive_tags": ["product", "docs"],
        }
    )

    summary = store.summary()

    assert summary["reflection"]["count"] == 2
    assert summary["reflection"]["last_reflection_at"] == "2026-03-10T21:00:00Z"
    assert summary["reflection"]["last_high_importance_reflection_id"] == "refl_a"
    assert summary["reflection"]["recent_themes"] == ["product", "docs", "health", "communication"]


def test_cognitive_artifact_store_replaces_drive_and_attention_state(tmp_path: Path) -> None:
    store = CognitiveArtifactStore(tmp_path)

    store.replace_drive_state(
        {
            "updated_at": "2026-03-10T21:30:00Z",
            "generated_at": "2026-03-10T21:29:30Z",
            "active_items": [
                {
                    "drive_id": "drv_a",
                    "title": "Tighten deploy validation",
                    "summary": "Health alone is too weak.",
                    "kind": "concern",
                    "priority": 0.88,
                    "recommended_channel": "conversation_only",
                },
                {
                    "drive_id": "drv_b",
                    "title": "Improve proactive follow-up quality",
                    "summary": "Heartbeat quality needs tuning.",
                    "kind": "goal",
                    "priority": 0.65,
                    "recommended_channel": "heartbeat",
                },
            ],
        }
    )
    store.replace_attention_state(
        {
            "updated_at": "2026-03-10T21:31:00Z",
            "current_focus_kind": "drive",
            "current_focus_summary": "Evaluating current internal priorities.",
            "top_priority_tags": ["self_mod", "memory_quality"],
            "reflection_stale": False,
            "drive_stale": False,
        }
    )

    summary = store.summary()

    assert summary["agenda"]["active_count"] == 2
    assert summary["agenda"]["last_drive_update_at"] == "2026-03-10T21:30:00Z"
    assert summary["agenda"]["top_items"][0]["drive_id"] == "drv_a"
    assert summary["attention"]["current_focus_kind"] == "drive"
    assert summary["attention"]["top_priority_tags"] == ["self_mod", "memory_quality"]
