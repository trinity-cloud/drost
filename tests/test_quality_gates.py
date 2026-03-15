from __future__ import annotations

import json
from pathlib import Path

from drost.quality_gates import QualityGateEvaluator


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def test_quality_gates_report_pending_and_pass_states(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "deployer" / "status.json",
        {
            "last_canary_label": "ok",
            "last_canary_phase": "provider_and_tool",
            "last_canary_ok_at": "2026-03-11T22:28:16Z",
        },
    )
    _write_jsonl(
        tmp_path / "deployer" / "events.jsonl",
        [
            {
                "event_type": "health_check_completed",
                "canary_phase": "runtime_surface",
                "canary_label": "runtime_surface_failed",
                "ok": False,
            },
            {
                "event_type": "health_check_completed",
                "canary_phase": "provider_and_tool",
                "canary_label": "ok",
                "ok": True,
            },
            {
                "event_type": "health_check_completed",
                "canary_phase": "provider_and_tool",
                "canary_label": "ok",
                "ok": True,
            },
        ],
    )

    evaluator = QualityGateEvaluator(tmp_path)
    payload = evaluator.status(
        reflection_status={
            "reflection_write_count": 1,
            "reflection_skip_count": 5,
            "consecutive_skip_count": 5,
            "last_skip_reason": "interval_not_elapsed",
            "last_result": {"why": "interval_not_elapsed"},
        },
        heartbeat_status={
            "surface_count": 0,
            "suppress_count": 0,
            "ignore_count": 4,
            "noop_active_mode_count": 0,
            "noop_interval_count": 0,
            "noop_no_due_count": 4,
        },
    )

    assert payload["gates"]["reflection_hygiene"]["state"] == "pass"
    assert payload["gates"]["deploy_canary"]["state"] == "pass"
    assert payload["gates"]["heartbeat_hygiene"]["state"] == "pending"
    assert payload["gates"]["promotion_precision"]["state"] == "pending"
    assert payload["gates"]["promotion_precision"]["targets"]["IDENTITY.md"]["state"] == "manual_only"
    assert payload["ready_for_next_cognition_package"] is False


def test_quality_gates_require_review_for_promotions_then_pass_after_target_review(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "deployer" / "status.json",
        {
            "last_canary_label": "ok",
            "last_canary_phase": "provider_and_tool",
            "last_canary_ok_at": "2026-03-11T22:28:16Z",
        },
    )
    _write_jsonl(
        tmp_path / "deployer" / "events.jsonl",
        [
            {
                "event_type": "health_check_completed",
                "canary_phase": "provider_and_tool",
                "canary_label": "ok",
                "ok": True,
            },
            {
                "event_type": "health_check_completed",
                "canary_phase": "provider_and_tool",
                "canary_label": "ok",
                "ok": True,
            },
            {
                "event_type": "health_check_completed",
                "canary_phase": "provider_and_tool",
                "canary_label": "ok",
                "ok": True,
            },
        ],
    )
    _write_jsonl(
        tmp_path / "state" / "promotion-decisions.jsonl",
        [
            {
                "timestamp": "2026-03-11T20:00:00Z",
                "target_file": "USER.md",
                "candidate_text": "Migel prefers direct, technical answers.",
                "kind": "preference",
                "accepted": True,
                "reason": "accepted",
            }
        ],
    )

    evaluator = QualityGateEvaluator(tmp_path)
    before = evaluator.status(
        reflection_status={"reflection_write_count": 1, "reflection_skip_count": 5},
        heartbeat_status={
            "surface_count": 1,
            "suppress_count": 1,
            "ignore_count": 1,
            "noop_active_mode_count": 0,
            "noop_interval_count": 0,
            "noop_no_due_count": 0,
        },
    )
    assert before["gates"]["promotion_precision"]["state"] == "pending"

    evaluator.record_promotion_review(
        approved=True,
        note="Sample looked clean.",
        sample_size=1,
        target_file="USER.md",
    )

    after = evaluator.status(
        reflection_status={"reflection_write_count": 1, "reflection_skip_count": 5},
        heartbeat_status={
            "surface_count": 1,
            "suppress_count": 1,
            "ignore_count": 1,
            "noop_active_mode_count": 0,
            "noop_interval_count": 0,
            "noop_no_due_count": 0,
        },
    )
    assert after["gates"]["promotion_precision"]["state"] == "pass"
    assert after["review"]["promotion_reviews"]["USER.md"]["approved"] is True
    assert after["ready_for_next_cognition_package"] is True
    assert after["gates"]["promotion_precision"]["targets"]["USER.md"]["state"] == "pass"


def test_quality_gates_report_target_specific_promotion_review_failure(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "deployer" / "status.json",
        {
            "last_canary_label": "ok",
            "last_canary_phase": "provider_and_tool",
            "last_canary_ok_at": "2026-03-11T22:28:16Z",
        },
    )
    _write_jsonl(
        tmp_path / "deployer" / "events.jsonl",
        [
            {"event_type": "health_check_completed", "canary_phase": "provider_and_tool", "canary_label": "ok", "ok": True},
            {"event_type": "health_check_completed", "canary_phase": "provider_and_tool", "canary_label": "ok", "ok": True},
            {"event_type": "health_check_completed", "canary_phase": "provider_and_tool", "canary_label": "ok", "ok": True},
        ],
    )
    _write_jsonl(
        tmp_path / "state" / "promotion-decisions.jsonl",
        [
            {
                "timestamp": "2026-03-11T20:00:00Z",
                "target_file": "TOOLS.md",
                "candidate_text": "Use worker_status before reporting worker completion.",
                "kind": "operational_truth",
                "accepted": True,
                "reason": "accepted",
            }
        ],
    )

    evaluator = QualityGateEvaluator(tmp_path)
    evaluator.record_promotion_review(
        approved=False,
        note="Wording was too broad.",
        sample_size=1,
        target_file="TOOLS.md",
    )

    payload = evaluator.status(
        reflection_status={"reflection_write_count": 1, "reflection_skip_count": 5},
        heartbeat_status={
            "surface_count": 1,
            "suppress_count": 1,
            "ignore_count": 1,
            "noop_active_mode_count": 0,
            "noop_interval_count": 0,
            "noop_no_due_count": 0,
        },
    )

    assert payload["gates"]["promotion_precision"]["state"] == "fail"
    assert payload["gates"]["promotion_precision"]["targets"]["TOOLS.md"]["state"] == "fail"
