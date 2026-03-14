from __future__ import annotations

from pathlib import Path

from drost.cognitive_artifacts import (
    CognitiveArtifactStore,
    InitiativeRecord,
    InitiativeStateSnapshot,
)


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


def test_initiative_record_round_trip_from_dict() -> None:
    raw = {
        "initiative_id": "init_abc",
        "title": "Ship substrate layer",
        "summary": "Initiative persistence needs wiring.",
        "status": "active",
        "kind": "initiative",
        "priority": 0.85,
        "urgency": 0.6,
        "confidence": 0.9,
        "recommended_channel": "conversation_only",
        "source_refs": ["refl_a"],
        "drive_ids": ["drv_a"],
        "evidence": ["refl_a"],
        "last_reviewed_at": "2026-03-10T21:00:00Z",
        "updated_at": "2026-03-10T21:00:00Z",
    }
    record = InitiativeRecord.from_input(raw)
    assert record.initiative_id == "init_abc"
    assert record.priority == 0.85
    assert record.drive_ids == ["drv_a"]
    roundtripped = record.as_dict()
    assert roundtripped["title"] == "Ship substrate layer"
    assert roundtripped["evidence"] == ["refl_a"]
    # from_input on an already-constructed record is identity
    assert InitiativeRecord.from_input(record) is record


def test_initiative_record_from_input_generates_id_and_normalizes() -> None:
    record = InitiativeRecord.from_input({"title": "Untitled", "summary": "x"})
    assert record.initiative_id.startswith("init_")
    assert record.status == "active"
    assert record.recommended_channel == "hold"


def test_initiative_state_snapshot_round_trip() -> None:
    raw = {
        "updated_at": "2026-03-10T22:00:00Z",
        "generated_at": "2026-03-10T22:00:00Z",
        "active_items": [
            {"initiative_id": "init_1", "title": "A", "summary": "s", "priority": 0.9},
        ],
        "completed_items": [],
        "suppressed_items": [
            {"initiative_id": "init_2", "title": "B", "summary": "s2", "priority": 0.3},
        ],
    }
    snapshot = InitiativeStateSnapshot.from_input(raw)
    assert len(snapshot.active_items) == 1
    assert len(snapshot.suppressed_items) == 1
    payload = snapshot.as_dict()
    assert payload["version"] == 1
    assert payload["active_items"][0]["initiative_id"] == "init_1"
    # identity pass-through
    assert InitiativeStateSnapshot.from_input(snapshot) is snapshot


def test_replace_and_load_initiatives_persistence(tmp_path: Path) -> None:
    store = CognitiveArtifactStore(tmp_path)
    store.replace_initiatives(
        {
            "updated_at": "2026-03-10T22:00:00Z",
            "generated_at": "2026-03-10T22:00:00Z",
            "active_items": [
                {"initiative_id": "init_x", "title": "X", "summary": "persist me", "priority": 0.7},
            ],
        }
    )
    loaded = store.load_initiatives()
    assert loaded["active_items"][0]["initiative_id"] == "init_x"
    assert loaded["active_items"][0]["title"] == "X"

    # reload from fresh store to confirm disk persistence
    store2 = CognitiveArtifactStore(tmp_path)
    loaded2 = store2.load_initiatives()
    assert loaded2["active_items"][0]["initiative_id"] == "init_x"


def test_sync_initiatives_from_drive_state(tmp_path: Path) -> None:
    store = CognitiveArtifactStore(tmp_path)
    drive_state = {
        "updated_at": "2026-03-10T23:00:00Z",
        "generated_at": "2026-03-10T22:59:00Z",
        "active_items": [
            {
                "drive_id": "drv_alpha",
                "title": "Alpha concern",
                "summary": "Something important.",
                "kind": "concern",
                "status": "active",
                "priority": 0.92,
                "urgency": 0.7,
                "confidence": 0.85,
                "recommended_channel": "conversation_only",
                "source_refs": ["refl_1", "fu_1"],
            },
        ],
        "completed_items": [
            {
                "drive_id": "drv_done",
                "title": "Done item",
                "summary": "Finished.",
                "kind": "goal",
                "status": "completed",
                "priority": 0.5,
            },
        ],
        "suppressed_items": [],
    }
    result = store.sync_initiatives_from_drive_state(drive_state)
    assert len(result["active_items"]) == 1
    assert result["active_items"][0]["initiative_id"] == "drv_alpha"
    assert result["active_items"][0]["drive_ids"] == ["drv_alpha"]
    assert result["active_items"][0]["evidence"] == ["refl_1", "fu_1"]
    assert len(result["completed_items"]) == 1
    assert result["completed_items"][0]["initiative_id"] == "drv_done"

    # confirm persisted
    loaded = store.load_initiatives()
    assert loaded["active_items"][0]["title"] == "Alpha concern"


def test_summary_includes_initiatives(tmp_path: Path) -> None:
    store = CognitiveArtifactStore(tmp_path)
    store.replace_initiatives(
        {
            "updated_at": "2026-03-10T23:30:00Z",
            "generated_at": "2026-03-10T23:30:00Z",
            "active_items": [
                {"initiative_id": "init_hi", "title": "High priority", "summary": "hp", "priority": 0.95, "kind": "concern"},
                {"initiative_id": "init_lo", "title": "Low priority", "summary": "lp", "priority": 0.3, "kind": "goal"},
            ],
        }
    )

    summary = store.summary()

    assert "initiatives" in summary
    assert summary["initiatives"]["active_count"] == 2
    assert summary["initiatives"]["last_updated_at"] == "2026-03-10T23:30:00Z"
    assert len(summary["initiatives"]["top_items"]) == 2
    assert summary["initiatives"]["top_items"][0]["initiative_id"] == "init_hi"
    assert summary["initiatives"]["top_items"][0]["priority"] == 0.95
