from __future__ import annotations

import os
import signal
import time
from typing import Any

from drost.deployer.request_queue import DeployerRequest, DeployerRequestQueue
from drost.deployer.rollout import DeployerRolloutManager
from drost.deployer.state import DeployerStateStore
from drost.deployer.supervisor import DeployerSupervisor


class DeployerService:
    def __init__(
        self,
        *,
        store: DeployerStateStore,
        supervisor: DeployerSupervisor,
        rollout: DeployerRolloutManager,
        queue: DeployerRequestQueue,
    ) -> None:
        self._store = store
        self._supervisor = supervisor
        self._rollout = rollout
        self._queue = queue

    def _write_status(self, **fields: Any) -> dict[str, Any]:
        status = self._store.read_status()
        status.update(fields)
        return self._store.write_status(status)

    def _refresh_pending_ids(self) -> dict[str, Any]:
        status = self._store.read_status()
        status["pending_request_ids"] = self._queue.pending_request_ids()
        return self._store.write_status(status)

    def ensure_runtime(self) -> dict[str, Any]:
        status = self._supervisor.refresh_status()
        if isinstance(status.get("child_pid"), int) and int(status["child_pid"]) > 0:
            supervisor_pid = status.get("supervisor_pid")
            if not isinstance(supervisor_pid, int) or supervisor_pid != os.getpid():
                self._store.append_event(
                    "child_reclaim_started",
                    previous_supervisor_pid=supervisor_pid,
                    child_pid=status.get("child_pid"),
                )
                self._write_status(state="reclaiming_child", last_error="")
                self._supervisor.restart_child()
                status = self._rollout.healthcheck()
                if status.get("state") == "healthy":
                    self._store.append_event(
                        "child_reclaim_succeeded",
                        supervisor_pid=os.getpid(),
                        child_pid=status.get("child_pid"),
                    )
                    return self._refresh_pending_ids()
                self._store.append_event(
                    "child_reclaim_failed",
                    supervisor_pid=os.getpid(),
                    child_pid=status.get("child_pid"),
                    last_error=status.get("last_error"),
                )
                return status
            if status.get("state") != "healthy":
                return self._rollout.healthcheck()
            return self._refresh_pending_ids()

        self._write_status(state="starting_child", last_error="")
        self._supervisor.start_child()
        status = self._rollout.healthcheck()
        if status.get("state") == "healthy":
            return self._refresh_pending_ids()

        known_good_commit = str(self._store.read_known_good().get("commit") or "").strip()
        if known_good_commit:
            return self._rollout.rollback(
                to_ref=known_good_commit,
                reason="initial boot health check failed; rolled back to known-good",
            )

        status = self._store.read_status()
        status["state"] = "degraded"
        if not status.get("last_error"):
            status["last_error"] = "initial boot health check failed with no rollback target"
        self._store.write_status(status)
        self._store.append_event(
            "manual_intervention_required",
            reason=status["last_error"],
        )
        return self._refresh_pending_ids()

    def process_next_request(self) -> dict[str, Any] | None:
        status = self._supervisor.refresh_status()
        if status.get("state") == "degraded":
            return self._refresh_pending_ids()

        request = self._queue.claim_next()
        if request is None:
            return self._refresh_pending_ids()

        self._store.append_event(
            "request_started",
            request_id=request.request_id,
            type=request.type,
            candidate_ref=request.candidate_ref,
            rollback_ref=request.rollback_ref,
        )
        self._write_status(
            state="processing_request",
            active_request_id=request.request_id,
            active_request_type=request.type,
            last_request_id=request.request_id,
            pending_request_ids=self._queue.pending_request_ids(),
            last_error="",
        )
        try:
            result = self._execute_request(request)
            self._queue.mark_processed(request)
            self._store.append_event(
                "request_completed",
                request_id=request.request_id,
                type=request.type,
                final_state=result.get("state"),
                active_commit=result.get("active_commit"),
            )
        except Exception as exc:
            self._queue.mark_failed(request)
            status = self._store.read_status()
            status["last_error"] = str(exc)
            self._store.write_status(status)
            self._store.append_event(
                "request_failed",
                request_id=request.request_id,
                type=request.type,
                error=str(exc),
            )
        finally:
            status = self._store.read_status()
            status["active_request_id"] = ""
            status["active_request_type"] = ""
            status["pending_request_ids"] = self._queue.pending_request_ids()
            self._store.write_status(status)
        return self._store.read_status()

    def _execute_request(self, request: DeployerRequest) -> dict[str, Any]:
        if request.type == "restart":
            return self._rollout.restart_current(reason=request.reason)
        if request.type == "deploy_candidate":
            return self._rollout.deploy_candidate(request.candidate_ref)
        if request.type == "rollback":
            return self._rollout.rollback(to_ref=request.rollback_ref or None, reason=request.reason)
        raise ValueError(f"unsupported request type: {request.type}")

    def run_forever(self) -> int:
        self.ensure_runtime()
        stop_requested = False

        def _handle_signal(signum: int, _frame: Any) -> None:
            nonlocal stop_requested
            stop_requested = True
            self._store.append_event("deployer_signal_received", signal=signum)

        previous_sigint = signal.getsignal(signal.SIGINT)
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)
        try:
            while True:
                if stop_requested:
                    self._supervisor.stop_child()
                    self._refresh_pending_ids()
                    return 0

                status = self._supervisor.refresh_status()
                if not status.get("child_pid") and status.get("state") != "degraded":
                    self._store.append_event("child_missing_from_service_loop")
                    self.ensure_runtime()

                if self._store.read_status().get("state") != "degraded":
                    self.process_next_request()
                else:
                    self._refresh_pending_ids()

                time.sleep(self._store.config.request_poll_interval_seconds)
        finally:
            signal.signal(signal.SIGINT, previous_sigint)
            signal.signal(signal.SIGTERM, previous_sigterm)
