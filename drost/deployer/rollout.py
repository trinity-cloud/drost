from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from drost.deployer.git_ops import (
    GitOperationError,
    checkout_ref,
    is_worktree_clean,
    resolve_head_commit,
    resolve_ref,
    update_ref,
)
from drost.deployer.health import HealthCheckResult, wait_for_health
from drost.deployer.state import DeployerStateStore
from drost.deployer.supervisor import DeployerSupervisor


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class DeployerRolloutManager:
    store: DeployerStateStore
    supervisor: DeployerSupervisor

    def _update_health_fields(
        self,
        status: dict[str, Any],
        result: HealthCheckResult,
        *,
        clear_error_on_success: bool,
    ) -> dict[str, Any]:
        status.update(
            {
                "last_health_checked_at": result.checked_at,
                "last_health_status_code": result.status_code,
                "last_health_body": result.body_excerpt,
            }
        )
        if result.ok:
            status["last_health_ok_at"] = result.checked_at
            if clear_error_on_success:
                status["last_error"] = ""
        return status

    def _write_known_good(self, *, commit: str, notes: str, duration_ms: int | None) -> None:
        ref_name = update_ref(self.store.config.repo_root, self.store.config.known_good_ref_name, commit)
        self.store.write_known_good(
            {
                "ref_name": ref_name,
                "commit": commit,
                "promoted_at": _utc_now(),
                "startup_duration_ms": duration_ms,
                "health_url": self.store.config.health_url,
                "notes": notes,
            }
        )

    def _require_clean_worktree(self) -> None:
        if not is_worktree_clean(self.store.config.repo_root):
            raise GitOperationError("repo worktree must be clean for deployer rollout operations")

    def _transition_state(self, state: str, **fields: Any) -> dict[str, Any]:
        status = self.store.read_status()
        status["state"] = state
        status.update(fields)
        return self.store.write_status(status)

    def healthcheck(self, *, startup_grace_seconds: float | None = None) -> dict[str, Any]:
        result = wait_for_health(
            self.store.config.health_url,
            startup_grace_seconds=self.store.config.startup_grace_seconds
            if startup_grace_seconds is None
            else max(0.0, float(startup_grace_seconds)),
            timeout_seconds=self.store.config.health_timeout_seconds,
            poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
        )
        status = self.store.read_status()
        self._update_health_fields(status, result, clear_error_on_success=True)
        if result.ok and status.get("child_pid"):
            status["state"] = "healthy"
        elif not result.ok and not status.get("last_error"):
            status["last_error"] = result.error or "health check failed"
        self.store.write_status(status)
        self.store.append_event(
            "health_check_completed",
            ok=result.ok,
            status_code=result.status_code,
            duration_ms=result.duration_ms,
            error=result.error,
        )
        return self.store.read_status()

    def promote_current(self) -> dict[str, Any]:
        self._require_clean_worktree()
        status = self.supervisor.refresh_status()
        pid = status.get("child_pid")
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError("cannot promote without a supervised child process")

        commit = resolve_head_commit(self.store.config.repo_root)
        result = wait_for_health(
            self.store.config.health_url,
            startup_grace_seconds=0.0,
            timeout_seconds=self.store.config.health_timeout_seconds,
            poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
        )
        status = self.store.read_status()
        self._update_health_fields(status, result, clear_error_on_success=True)
        if not result.ok:
            status["state"] = "running"
            status["last_error"] = f"promotion health check failed: {result.error or result.body_excerpt or 'unknown error'}"
            self.store.write_status(status)
            self.store.append_event(
                "promote_current_failed",
                active_commit=commit,
                status_code=result.status_code,
                error=result.error,
            )
            return self.store.read_status()

        self._write_known_good(
            commit=commit,
            notes="Promoted from active supervised runtime.",
            duration_ms=result.duration_ms,
        )
        status.update(
            {
                "state": "healthy",
                "active_commit": commit,
                "known_good_commit": commit,
                "last_error": "",
            }
        )
        self.store.write_status(status)
        self.store.append_event(
            "promote_current_succeeded",
            active_commit=commit,
            duration_ms=result.duration_ms,
            status_code=result.status_code,
        )
        return self.store.read_status()

    def restart_current(self, *, reason: str = "") -> dict[str, Any]:
        current_commit = resolve_head_commit(self.store.config.repo_root)
        self._transition_state("processing_request", active_commit=current_commit, last_error="")
        self.store.append_event(
            "restart_started",
            active_commit=current_commit,
            reason=reason,
        )
        self.supervisor.restart_child()
        result = wait_for_health(
            self.store.config.health_url,
            startup_grace_seconds=self.store.config.startup_grace_seconds,
            timeout_seconds=self.store.config.health_timeout_seconds,
            poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
        )
        status = self.store.read_status()
        self._update_health_fields(status, result, clear_error_on_success=False)
        status["active_commit"] = current_commit

        if result.ok:
            status["state"] = "healthy"
            status["last_error"] = ""
            self.store.write_status(status)
            self.store.append_event(
                "restart_succeeded",
                active_commit=current_commit,
                duration_ms=result.duration_ms,
                status_code=result.status_code,
            )
            return self.store.read_status()

        known_good = self.store.read_known_good()
        rollback_ref = str(known_good.get("commit") or "").strip()
        self.store.write_status(status)
        self.store.append_event(
            "restart_failed_validation",
            active_commit=current_commit,
            rollback_ref=rollback_ref,
            status_code=result.status_code,
            error=result.error,
        )
        if not rollback_ref:
            status["state"] = "degraded"
            status["last_error"] = (
                f"restart validation failed with no rollback target: "
                f"{result.error or result.body_excerpt or 'unknown error'}"
            )
            self.store.write_status(status)
            self.store.append_event(
                "manual_intervention_required",
                reason=status["last_error"],
            )
            return self.store.read_status()
        return self.rollback(
            to_ref=rollback_ref,
            reason=(
                f"restart validation failed on {current_commit}: "
                f"{result.error or result.body_excerpt or 'unknown error'};"
                f" rolled back to {rollback_ref}"
            ),
        )

    def rollback(self, *, to_ref: str | None = None, reason: str = "") -> dict[str, Any]:
        target_ref = str(to_ref or "").strip()
        known_good = self.store.read_known_good()
        if not target_ref:
            target_ref = str(known_good.get("commit") or "").strip()
        if not target_ref:
            raise RuntimeError("no rollback target is available")

        self._require_clean_worktree()
        target_commit = resolve_ref(self.store.config.repo_root, target_ref)
        current_commit = resolve_head_commit(self.store.config.repo_root)
        if target_commit == current_commit:
            result = wait_for_health(
                self.store.config.health_url,
                startup_grace_seconds=0.0,
                timeout_seconds=self.store.config.health_timeout_seconds,
                poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
            )
            status = self.store.read_status()
            self._update_health_fields(status, result, clear_error_on_success=False)
            if result.ok:
                status.update(
                    {
                        "state": "healthy",
                        "active_commit": target_commit,
                        "known_good_commit": str(known_good.get("commit") or target_commit),
                        "last_error": reason.strip(),
                    }
                )
                self.store.write_status(status)
                self.store.append_event(
                    "rollback_noop",
                    target_commit=target_commit,
                    reason=reason,
                )
                return self.store.read_status()

        status = self.store.read_status()
        status.update(
            {
                "state": "rolling_back",
                "last_error": "",
            }
        )
        self.store.write_status(status)
        self.store.append_event(
            "rollback_started",
            target_ref=target_ref,
            target_commit=target_commit,
            reason=reason,
        )

        checkout_ref(self.store.config.repo_root, target_commit)
        self.supervisor.restart_child()
        result = wait_for_health(
            self.store.config.health_url,
            startup_grace_seconds=self.store.config.startup_grace_seconds,
            timeout_seconds=self.store.config.health_timeout_seconds,
            poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
        )

        status = self.store.read_status()
        self._update_health_fields(status, result, clear_error_on_success=False)
        status["active_commit"] = target_commit
        status["known_good_commit"] = str(known_good.get("commit") or target_commit)

        if result.ok:
            status["state"] = "healthy"
            status["last_error"] = reason.strip()
            self.store.write_status(status)
            self.store.append_event(
                "rollback_succeeded",
                target_commit=target_commit,
                status_code=result.status_code,
                duration_ms=result.duration_ms,
            )
            return self.store.read_status()

        status["state"] = "degraded"
        status["last_error"] = (
            f"{reason.strip()} rollback validation failed: {result.error or result.body_excerpt or 'unknown error'}"
        ).strip()
        self.store.write_status(status)
        self.store.append_event(
            "rollback_failed",
            target_commit=target_commit,
            status_code=result.status_code,
            error=result.error,
        )
        return self.store.read_status()

    def deploy_candidate(self, candidate_ref: str) -> dict[str, Any]:
        self._require_clean_worktree()
        current_commit = resolve_head_commit(self.store.config.repo_root)
        candidate_commit = resolve_ref(self.store.config.repo_root, candidate_ref)
        if candidate_commit == current_commit:
            self.store.append_event(
                "deploy_candidate_noop",
                candidate_ref=candidate_ref,
                candidate_commit=candidate_commit,
            )
            return self.healthcheck(startup_grace_seconds=0.0)
        known_good = self.store.read_known_good()
        rollback_ref = str(known_good.get("commit") or current_commit).strip()

        status = self.store.read_status()
        status.update(
            {
                "state": "deploying",
                "active_commit": current_commit,
                "last_error": "",
            }
        )
        self.store.write_status(status)
        self.store.append_event(
            "deploy_candidate_started",
            candidate_ref=candidate_ref,
            candidate_commit=candidate_commit,
            rollback_ref=rollback_ref,
        )

        checkout_ref(self.store.config.repo_root, candidate_commit)
        self.supervisor.restart_child()
        result = wait_for_health(
            self.store.config.health_url,
            startup_grace_seconds=self.store.config.startup_grace_seconds,
            timeout_seconds=self.store.config.health_timeout_seconds,
            poll_interval_seconds=min(self.store.config.request_poll_interval_seconds, 0.5),
        )
        status = self.store.read_status()
        self._update_health_fields(status, result, clear_error_on_success=False)
        status["active_commit"] = candidate_commit

        if result.ok:
            self._write_known_good(
                commit=candidate_commit,
                notes=f"Candidate {candidate_ref} validated and promoted.",
                duration_ms=result.duration_ms,
            )
            status.update(
                {
                    "state": "healthy",
                    "active_commit": candidate_commit,
                    "known_good_commit": candidate_commit,
                    "last_error": "",
                }
            )
            self.store.write_status(status)
            self.store.append_event(
                "deploy_candidate_succeeded",
                candidate_ref=candidate_ref,
                candidate_commit=candidate_commit,
                status_code=result.status_code,
                duration_ms=result.duration_ms,
            )
            return self.store.read_status()

        self.store.write_status(status)
        self.store.append_event(
            "deploy_candidate_failed_validation",
            candidate_ref=candidate_ref,
            candidate_commit=candidate_commit,
            rollback_ref=rollback_ref,
            status_code=result.status_code,
            error=result.error,
        )
        reason = (
            f"candidate {candidate_ref} ({candidate_commit}) failed validation:"
            f" {result.error or result.body_excerpt or 'unknown error'};"
            f" rolled back to {rollback_ref}"
        )
        return self.rollback(to_ref=rollback_ref, reason=reason)
