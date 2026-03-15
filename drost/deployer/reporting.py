from __future__ import annotations

from typing import Any


def derive_reporting_fields(payload: dict[str, Any]) -> dict[str, str]:
    state = str(payload.get("state") or "").strip()
    active_commit = str(payload.get("active_commit") or "").strip()
    known_good_commit = str(payload.get("known_good_commit") or "").strip()
    active_request_id = str(payload.get("active_request_id") or "").strip()
    pending_request_ids = payload.get("pending_request_ids") or []
    child_pid = payload.get("child_pid")
    last_noop_reason = str(payload.get("last_noop_reason") or "").strip()

    if active_request_id:
        request_state = "active"
    elif isinstance(pending_request_ids, list) and pending_request_ids:
        request_state = "accepted"
    else:
        request_state = "idle"

    if state == "healthy" and isinstance(child_pid, int) and child_pid > 0:
        runtime_state = "healthy/live"
    elif state in {"deploying", "rolling_back", "processing_request", "starting_child", "reclaiming_child", "running"}:
        runtime_state = "active"
    elif state == "degraded":
        runtime_state = "failed"
    elif state == "idle":
        runtime_state = "idle"
    else:
        runtime_state = state or "unknown"

    if active_commit and known_good_commit and active_commit == known_good_commit:
        promotion_state = "promoted"
    else:
        promotion_state = "unpromoted"

    if last_noop_reason:
        last_outcome = "noop"
    elif state == "degraded":
        last_outcome = "failed"
    else:
        last_outcome = "none"

    return {
        "request_state": request_state,
        "runtime_state": runtime_state,
        "promotion_state": promotion_state,
        "last_outcome": last_outcome,
    }
