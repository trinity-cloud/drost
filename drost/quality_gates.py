from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.memory_promotion import (
    ALLOWED_PROMOTION_TARGETS,
    AUTO_PROMOTION_TARGETS,
    is_manual_review_only_target,
    normalize_promotion_target,
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _parse_time(value: str | None) -> datetime | None:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    try:
        if cleaned.endswith("Z"):
            return datetime.fromisoformat(cleaned.replace("Z", "+00:00")).astimezone(UTC)
        parsed = datetime.fromisoformat(cleaned)
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    except Exception:
        return None


class QualityGateStore:
    def __init__(self, workspace_dir: str | Path) -> None:
        self.workspace_dir = Path(workspace_dir).expanduser()

    @property
    def path(self) -> Path:
        return self.workspace_dir / "state" / "quality-gates.json"

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return self.default_state()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
        return self._normalize(payload)

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return normalized

    def record_promotion_review(
        self,
        *,
        approved: bool,
        note: str,
        sample_size: int,
        accepted_count: int,
        reviewed_through_timestamp: str,
        target_file: str = "",
    ) -> dict[str, Any]:
        state = self.load()
        review_payload = {
            "approved": bool(approved),
            "note": str(note or "").strip(),
            "sample_size": max(0, int(sample_size)),
            "accepted_count_at_review": max(0, int(accepted_count)),
            "reviewed_through_timestamp": str(reviewed_through_timestamp or "").strip(),
            "reviewed_at": _utc_now(),
        }
        normalized_target = normalize_promotion_target(target_file)
        if normalized_target:
            promotion_reviews = dict(state.get("promotion_reviews") or {})
            promotion_reviews[normalized_target] = review_payload
            state["promotion_reviews"] = promotion_reviews
        else:
            state["promotion_review"] = review_payload
        return self.save(state)

    @staticmethod
    def default_state() -> dict[str, Any]:
        return {
            "promotion_review": {
                "approved": None,
                "note": "",
                "sample_size": 0,
                "accepted_count_at_review": 0,
                "reviewed_through_timestamp": "",
                "reviewed_at": "",
            },
            "promotion_reviews": {},
        }

    @staticmethod
    def _normalize(payload: Any) -> dict[str, Any]:
        raw = payload if isinstance(payload, dict) else {}
        review = raw.get("promotion_review") if isinstance(raw.get("promotion_review"), dict) else {}
        promotion_reviews_raw = raw.get("promotion_reviews") if isinstance(raw.get("promotion_reviews"), dict) else {}
        approved_raw = review.get("approved")
        approved: bool | None = approved_raw if isinstance(approved_raw, bool) else None
        normalized_reviews: dict[str, dict[str, Any]] = {}
        for target_file, target_review_raw in promotion_reviews_raw.items():
            if not isinstance(target_review_raw, dict):
                continue
            normalized_target = normalize_promotion_target(str(target_file or ""))
            if not normalized_target:
                continue
            target_approved_raw = target_review_raw.get("approved")
            target_approved = target_approved_raw if isinstance(target_approved_raw, bool) else None
            normalized_reviews[normalized_target] = {
                "approved": target_approved,
                "note": str(target_review_raw.get("note") or ""),
                "sample_size": max(0, int(target_review_raw.get("sample_size") or 0)),
                "accepted_count_at_review": max(0, int(target_review_raw.get("accepted_count_at_review") or 0)),
                "reviewed_through_timestamp": str(target_review_raw.get("reviewed_through_timestamp") or ""),
                "reviewed_at": str(target_review_raw.get("reviewed_at") or ""),
            }
        return {
            "promotion_review": {
                "approved": approved,
                "note": str(review.get("note") or ""),
                "sample_size": max(0, int(review.get("sample_size") or 0)),
                "accepted_count_at_review": max(0, int(review.get("accepted_count_at_review") or 0)),
                "reviewed_through_timestamp": str(review.get("reviewed_through_timestamp") or ""),
                "reviewed_at": str(review.get("reviewed_at") or ""),
            },
            "promotion_reviews": normalized_reviews,
        }


class QualityGateEvaluator:
    def __init__(
        self,
        workspace_dir: str | Path,
        *,
        reflection_min_samples: int = 5,
        reflection_skip_ratio_threshold: float = 0.60,
        heartbeat_min_samples: int = 3,
        heartbeat_meaningful_ratio_threshold: float = 0.20,
        deploy_canary_recent_window: int = 3,
        deploy_canary_min_samples: int = 3,
        deploy_canary_pass_rate_threshold: float = 0.66,
        deploy_canary_consecutive_ok_threshold: int = 2,
    ) -> None:
        self.workspace_dir = Path(workspace_dir).expanduser()
        self.state_dir = self.workspace_dir / "state"
        self.deployer_state_dir = self.workspace_dir / "deployer"
        self.reflection_min_samples = max(1, int(reflection_min_samples))
        self.reflection_skip_ratio_threshold = max(0.0, min(1.0, float(reflection_skip_ratio_threshold)))
        self.heartbeat_min_samples = max(1, int(heartbeat_min_samples))
        self.heartbeat_meaningful_ratio_threshold = max(0.0, min(1.0, float(heartbeat_meaningful_ratio_threshold)))
        self.deploy_canary_recent_window = max(1, int(deploy_canary_recent_window))
        self.deploy_canary_min_samples = max(1, int(deploy_canary_min_samples))
        self.deploy_canary_pass_rate_threshold = max(0.0, min(1.0, float(deploy_canary_pass_rate_threshold)))
        self.deploy_canary_consecutive_ok_threshold = max(1, int(deploy_canary_consecutive_ok_threshold))
        self.store = QualityGateStore(self.workspace_dir)

    @property
    def promotion_journal_path(self) -> Path:
        return self.state_dir / "promotion-decisions.jsonl"

    @property
    def deployer_status_path(self) -> Path:
        return self.deployer_state_dir / "status.json"

    @property
    def deployer_events_path(self) -> Path:
        return self.deployer_state_dir / "events.jsonl"

    def status(
        self,
        *,
        reflection_status: dict[str, Any],
        heartbeat_status: dict[str, Any],
    ) -> dict[str, Any]:
        review_state = self.store.load()
        reflection_gate = self._reflection_gate(reflection_status)
        heartbeat_gate = self._heartbeat_gate(heartbeat_status)
        promotion_gate = self._promotion_gate(review_state)
        deploy_canary_gate = self._deploy_canary_gate()
        gates = {
            "reflection_hygiene": reflection_gate,
            "heartbeat_hygiene": heartbeat_gate,
            "promotion_precision": promotion_gate,
            "deploy_canary": deploy_canary_gate,
        }
        states = [str(gate.get("state") or "pending") for gate in gates.values()]
        if all(state == "pass" for state in states):
            overall_state = "pass"
            ready = True
        elif any(state == "fail" for state in states):
            overall_state = "fail"
            ready = False
        else:
            overall_state = "pending"
            ready = False
        return {
            "ready_for_next_cognition_package": ready,
            "overall_state": overall_state,
            "gates": gates,
            "thresholds": {
                "reflection_min_samples": self.reflection_min_samples,
                "reflection_skip_ratio_threshold": self.reflection_skip_ratio_threshold,
                "heartbeat_min_samples": self.heartbeat_min_samples,
                "heartbeat_meaningful_ratio_threshold": self.heartbeat_meaningful_ratio_threshold,
                "deploy_canary_recent_window": self.deploy_canary_recent_window,
                "deploy_canary_min_samples": self.deploy_canary_min_samples,
                "deploy_canary_pass_rate_threshold": self.deploy_canary_pass_rate_threshold,
                "deploy_canary_consecutive_ok_threshold": self.deploy_canary_consecutive_ok_threshold,
            },
            "review": review_state,
            "updated_at": _utc_now(),
        }

    def record_promotion_review(
        self,
        *,
        approved: bool,
        note: str,
        sample_size: int,
        target_file: str = "",
    ) -> dict[str, Any]:
        decisions = self._load_promotion_decisions()
        normalized_target = normalize_promotion_target(target_file)
        accepted = [item for item in decisions if bool(item.get("accepted"))]
        if normalized_target:
            accepted = [
                item
                for item in accepted
                if normalize_promotion_target(str(item.get("target_file") or "")) == normalized_target
            ]
        reviewed_through = str(accepted[-1].get("timestamp") or "") if accepted else ""
        return self.store.record_promotion_review(
            approved=approved,
            note=note,
            sample_size=sample_size,
            accepted_count=len(accepted),
            reviewed_through_timestamp=reviewed_through,
            target_file=normalized_target,
        )

    def _reflection_gate(self, reflection_status: dict[str, Any]) -> dict[str, Any]:
        writes = int(reflection_status.get("reflection_write_count") or 0)
        skips = int(reflection_status.get("reflection_skip_count") or 0)
        total = writes + skips
        skip_ratio = (skips / total) if total > 0 else None
        metrics = {
            "writes": writes,
            "skips": skips,
            "total_decisions": total,
            "skip_ratio": skip_ratio,
            "consecutive_skip_count": int(reflection_status.get("consecutive_skip_count") or 0),
            "last_skip_reason": str(reflection_status.get("last_skip_reason") or ""),
            "last_result": dict(reflection_status.get("last_result") or {}),
        }
        if total < self.reflection_min_samples:
            return self._gate(
                state="pending",
                reason="insufficient_samples",
                summary="Not enough reflection decisions yet.",
                metrics=metrics,
            )
        if skip_ratio is not None and skip_ratio >= self.reflection_skip_ratio_threshold:
            return self._gate(
                state="pass",
                reason="skip_ratio_healthy",
                summary="Reflection loop is mostly skipping low-value writes.",
                metrics=metrics,
            )
        return self._gate(
            state="fail",
            reason="skip_ratio_too_low",
            summary="Reflection loop is still writing too often.",
            metrics=metrics,
        )

    def _heartbeat_gate(self, heartbeat_status: dict[str, Any]) -> dict[str, Any]:
        surface = int(heartbeat_status.get("surface_count") or 0)
        suppress = int(heartbeat_status.get("suppress_count") or 0)
        ignore = int(heartbeat_status.get("ignore_count") or 0)
        noop_active = int(heartbeat_status.get("noop_active_mode_count") or 0)
        noop_interval = int(heartbeat_status.get("noop_interval_count") or 0)
        noop_no_due = int(heartbeat_status.get("noop_no_due_count") or 0)
        meaningful = surface + suppress
        effective_total = max(0, surface + suppress + ignore - noop_active - noop_interval)
        meaningful_ratio = (meaningful / effective_total) if effective_total > 0 else None
        metrics = {
            "surface_count": surface,
            "suppress_count": suppress,
            "ignore_count": ignore,
            "noop_active_mode_count": noop_active,
            "noop_interval_count": noop_interval,
            "noop_no_due_count": noop_no_due,
            "meaningful_count": meaningful,
            "effective_total": effective_total,
            "meaningful_ratio": meaningful_ratio,
            "last_decision": str(heartbeat_status.get("last_decision") or ""),
            "last_decision_class": str(heartbeat_status.get("last_decision_class") or ""),
            "last_meaningful_decision": str(heartbeat_status.get("last_meaningful_decision") or ""),
        }
        if meaningful == 0 and effective_total > 0 and effective_total == noop_no_due:
            return self._gate(
                state="pending",
                reason="no_due_followup_signal",
                summary="Heartbeat has not had meaningful follow-up opportunities yet.",
                metrics=metrics,
            )
        if effective_total < self.heartbeat_min_samples:
            pending_reason = "no_due_followup_signal" if noop_no_due > 0 and meaningful == 0 else "insufficient_samples"
            return self._gate(
                state="pending",
                reason=pending_reason,
                summary="Not enough meaningful heartbeat opportunities yet.",
                metrics=metrics,
            )
        if meaningful_ratio is not None and meaningful_ratio >= self.heartbeat_meaningful_ratio_threshold:
            return self._gate(
                state="pass",
                reason="meaningful_ratio_healthy",
                summary="Heartbeat decisions are meaningfully selective.",
                metrics=metrics,
            )
        return self._gate(
            state="fail",
            reason="meaningful_ratio_too_low",
            summary="Heartbeat still has too much low-value churn.",
            metrics=metrics,
        )

    def _promotion_gate(self, review_state: dict[str, Any]) -> dict[str, Any]:
        decisions = self._load_promotion_decisions()
        accepted = [item for item in decisions if bool(item.get("accepted"))]
        global_review = dict(review_state.get("promotion_review") or {})
        target_reviews = {
            normalize_promotion_target(str(key or "")): dict(value or {})
            for key, value in dict(review_state.get("promotion_reviews") or {}).items()
        }
        latest_accepted_at = str(accepted[-1].get("timestamp") or "") if accepted else ""
        reviewed_through = str(global_review.get("reviewed_through_timestamp") or "")
        review_approved = global_review.get("approved")
        target_gates: dict[str, Any] = {}
        accepted_auto_targets: list[str] = []
        for target_file in ALLOWED_PROMOTION_TARGETS:
            target_decisions = [
                item
                for item in decisions
                if normalize_promotion_target(str(item.get("target_file") or "")) == target_file
            ]
            target_accepted = [item for item in target_decisions if bool(item.get("accepted"))]
            latest_target_accepted_at = str(target_accepted[-1].get("timestamp") or "") if target_accepted else ""
            review = dict(target_reviews.get(target_file) or global_review)
            target_reviewed_through = str(review.get("reviewed_through_timestamp") or "")
            target_review_approved = review.get("approved")
            target_review_stale = bool(latest_target_accepted_at) and latest_target_accepted_at != target_reviewed_through
            metrics = {
                "decision_count": len(target_decisions),
                "accepted_count": len(target_accepted),
                "rejected_count": max(0, len(target_decisions) - len(target_accepted)),
                "latest_accepted_at": latest_target_accepted_at,
                "reviewed_through_timestamp": target_reviewed_through,
                "review_approved": target_review_approved,
                "reviewed_at": str(review.get("reviewed_at") or ""),
                "sample_size": int(review.get("sample_size") or 0),
                "manual_review_only": is_manual_review_only_target(target_file),
            }
            if is_manual_review_only_target(target_file):
                target_gates[target_file] = self._gate(
                    state="manual_only",
                    reason="manual_review_only",
                    summary="This target is manual-review-only and is not auto-promoted.",
                    metrics=metrics,
                )
                continue
            if target_accepted:
                accepted_auto_targets.append(target_file)
            if not target_accepted:
                target_gates[target_file] = self._gate(
                    state="pending",
                    reason="no_promotions_for_target",
                    summary="No accepted promotions for this target yet.",
                    metrics=metrics,
                )
            elif target_review_approved is None or target_review_stale:
                target_gates[target_file] = self._gate(
                    state="pending",
                    reason="promotion_review_required",
                    summary="Accepted promotions for this target require operator review.",
                    metrics=metrics,
                )
            elif bool(target_review_approved):
                target_gates[target_file] = self._gate(
                    state="pass",
                    reason="promotion_review_approved",
                    summary="Recent accepted promotions for this target were approved.",
                    metrics=metrics,
                )
            else:
                target_gates[target_file] = self._gate(
                    state="fail",
                    reason="promotion_review_rejected",
                    summary="Recent accepted promotions for this target were rejected.",
                    metrics=metrics,
                )
        metrics = {
            "decision_count": len(decisions),
            "accepted_count": len(accepted),
            "rejected_count": max(0, len(decisions) - len(accepted)),
            "latest_accepted_at": latest_accepted_at,
            "reviewed_through_timestamp": reviewed_through,
            "review_approved": review_approved,
            "reviewed_at": str(global_review.get("reviewed_at") or ""),
            "sample_size": int(global_review.get("sample_size") or 0),
            "auto_targets_with_accepts": accepted_auto_targets,
        }
        if not accepted_auto_targets:
            gate = self._gate(
                state="pending",
                reason="no_promotions_yet",
                summary="No accepted promotions have been reviewed yet.",
                metrics=metrics,
            )
            gate["targets"] = target_gates
            return gate
        relevant_states = [target_gates[target]["state"] for target in AUTO_PROMOTION_TARGETS if target in accepted_auto_targets]
        if any(state == "fail" for state in relevant_states):
            gate = self._gate(
                state="fail",
                reason="promotion_review_rejected",
                summary="At least one promotion target failed live review.",
                metrics=metrics,
            )
            gate["targets"] = target_gates
            return gate
        if any(state == "pending" for state in relevant_states):
            gate = self._gate(
                state="pending",
                reason="promotion_review_required",
                summary="Accepted promotions require live operator review.",
                metrics=metrics,
            )
            gate["targets"] = target_gates
            return gate
        gate = self._gate(
            state="pass",
            reason="promotion_review_approved",
            summary="Promotion precision has been approved on recent live samples.",
            metrics=metrics,
        )
        gate["targets"] = target_gates
        return gate

    def _deploy_canary_gate(self) -> dict[str, Any]:
        status = self._load_json(self.deployer_status_path, fallback={})
        events = self._load_recent_canary_events(limit=self.deploy_canary_recent_window)
        sample_count = len(events)
        ok_count = sum(1 for item in events if bool(item.get("ok")))
        pass_rate = (ok_count / sample_count) if sample_count > 0 else None
        consecutive_ok = 0
        for item in reversed(events):
            if bool(item.get("ok")):
                consecutive_ok += 1
            else:
                break
        metrics = {
            "sample_count": sample_count,
            "ok_count": ok_count,
            "pass_rate": pass_rate,
            "consecutive_ok": consecutive_ok,
            "last_canary_label": str(status.get("last_canary_label") or ""),
            "last_canary_phase": str(status.get("last_canary_phase") or ""),
            "last_canary_ok_at": str(status.get("last_canary_ok_at") or ""),
        }
        if sample_count < self.deploy_canary_min_samples:
            return self._gate(
                state="pending",
                reason="insufficient_samples",
                summary="Not enough recent deploy canary runs yet.",
                metrics=metrics,
            )
        if (
            str(status.get("last_canary_label") or "") == "ok"
            and pass_rate is not None
            and pass_rate >= self.deploy_canary_pass_rate_threshold
            and consecutive_ok >= self.deploy_canary_consecutive_ok_threshold
        ):
            return self._gate(
                state="pass",
                reason="recent_canaries_healthy",
                summary="Recent deploy canaries are healthy.",
                metrics=metrics,
            )
        return self._gate(
            state="fail",
            reason="recent_canaries_unhealthy",
            summary="Recent deploy canaries are not stable enough yet.",
            metrics=metrics,
        )

    def _load_promotion_decisions(self) -> list[dict[str, Any]]:
        return self._load_jsonl(self.promotion_journal_path)

    def list_promotion_decisions(
        self,
        *,
        limit: int = 25,
        target_file: str = "",
        accepted_only: bool = False,
    ) -> list[dict[str, Any]]:
        normalized_target = normalize_promotion_target(target_file)
        rows = self._load_promotion_decisions()
        filtered = []
        for row in rows:
            row_target = normalize_promotion_target(str(row.get("target_file") or ""))
            if normalized_target and row_target != normalized_target:
                continue
            if accepted_only and not bool(row.get("accepted")):
                continue
            filtered.append(row)
        filtered.reverse()
        return filtered[: max(1, int(limit))]

    def _load_recent_canary_events(self, *, limit: int) -> list[dict[str, Any]]:
        events = [
            item
            for item in self._load_jsonl(self.deployer_events_path)
            if str(item.get("event_type") or "") == "health_check_completed" and str(item.get("canary_phase") or "").strip()
        ]
        return events[-max(1, int(limit)) :]

    @staticmethod
    def _load_json(path: Path, *, fallback: dict[str, Any]) -> dict[str, Any]:
        if not path.exists():
            return dict(fallback)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return dict(fallback)
        return payload if isinstance(payload, dict) else dict(fallback)

    @staticmethod
    def _load_jsonl(path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            try:
                payload = json.loads(cleaned)
            except Exception:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
        return rows

    @staticmethod
    def _gate(*, state: str, reason: str, summary: str, metrics: dict[str, Any]) -> dict[str, Any]:
        normalized_state = str(state or "pending")
        return {
            "state": normalized_state,
            "passed": normalized_state == "pass",
            "reason": str(reason or ""),
            "summary": str(summary or ""),
            "metrics": metrics,
        }
