from __future__ import annotations

from drost.config import Settings
from drost.tools.base import BaseTool
from drost.worker_supervision import WorkerSupervisor


def _clean(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


class WorkerRequestTool(BaseTool):
    def __init__(self, *, settings: Settings) -> None:
        self._workers = WorkerSupervisor(settings)

    @property
    def name(self) -> str:
        return "worker_request"

    @property
    def description(self) -> str:
        return (
            "Launch and manage supervised Codex/Claude worker jobs through durable job state. "
            "Use this instead of shell_execute for Codex/Claude/tmux-driven implementation or review passes."
        )

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["launch", "review_accept", "review_reject", "retry", "stop"],
                    "description": "Worker supervision action to perform.",
                },
                "job_id": {
                    "type": "string",
                    "description": "Required for review_accept, review_reject, retry, and stop.",
                },
                "worker_kind": {
                    "type": "string",
                    "enum": ["codex", "claude"],
                    "description": "Required for launch.",
                },
                "prompt": {
                    "type": "string",
                    "description": "Canonical task spec for a launch action.",
                },
                "repo_root": {
                    "type": "string",
                    "description": "Optional repo root override for launch.",
                },
                "requested_mode": {
                    "type": "string",
                    "enum": ["inspect", "implement", "review"],
                    "description": "Requested launch mode.",
                },
                "write_scope": {
                    "type": "string",
                    "description": "Write scope for launch, such as repo or none.",
                },
                "requested_outputs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Expected outputs to review after launch.",
                },
                "requested_tests": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Test commands the worker should help satisfy.",
                },
                "requested_by": {
                    "type": "string",
                    "description": "Requester identity. Defaults to drost-agent.",
                },
                "reviewer": {
                    "type": "string",
                    "description": "Reviewer identity for review actions.",
                },
                "notes": {
                    "type": "string",
                    "description": "Review notes or stop context.",
                },
                "reason": {
                    "type": "string",
                    "description": "Retry or stop reason.",
                },
            },
            "required": ["action"],
        }

    async def execute(
        self,
        *,
        action: str,
        job_id: str | None = None,
        worker_kind: str | None = None,
        prompt: str | None = None,
        repo_root: str | None = None,
        requested_mode: str | None = None,
        write_scope: str | None = None,
        requested_outputs: list[str] | None = None,
        requested_tests: list[str] | None = None,
        requested_by: str | None = None,
        reviewer: str | None = None,
        notes: str | None = None,
        reason: str | None = None,
    ) -> str:
        normalized_action = _clean(action).lower()
        requested_by_value = _clean(requested_by) or "drost-agent"
        reviewer_value = _clean(reviewer) or "operator"

        if normalized_action == "launch":
            if not _clean(worker_kind):
                return "Error: worker_kind is required for launch"
            if not _clean(prompt):
                return "Error: prompt is required for launch"
            try:
                payload = self._workers.launch_job(
                    worker_kind=_clean(worker_kind).lower(),  # type: ignore[arg-type]
                    prompt=str(prompt or ""),
                    repo_root=repo_root,
                    requested_mode=_clean(requested_mode).lower() or "implement",  # type: ignore[arg-type]
                    write_scope=_clean(write_scope) or "repo",
                    requested_outputs=list(requested_outputs or []),
                    requested_tests=list(requested_tests or []),
                    requested_by=requested_by_value,
                )
            except ValueError as exc:
                return f"Error: {exc}"
            return self._render_result("launch", payload)

        normalized_job_id = _clean(job_id)
        if not normalized_job_id:
            return f"Error: job_id is required for {normalized_action or 'this action'}"

        try:
            if normalized_action == "review_accept":
                payload = self._workers.review_job(
                    normalized_job_id,
                    decision="accept",
                    reviewer=reviewer_value,
                    notes=str(notes or ""),
                )
                return self._render_result("review_accept", payload)
            if normalized_action == "review_reject":
                payload = self._workers.review_job(
                    normalized_job_id,
                    decision="reject",
                    reviewer=reviewer_value,
                    notes=str(notes or ""),
                )
                return self._render_result("review_reject", payload)
            if normalized_action == "retry":
                payload = self._workers.retry_job(
                    normalized_job_id,
                    requested_by=requested_by_value,
                    reason=str(reason or ""),
                )
                return self._render_result("retry", payload)
            if normalized_action == "stop":
                payload = self._workers.stop_job(normalized_job_id, reason=str(reason or notes or ""))
                return self._render_result("stop", payload)
        except KeyError:
            return f"Error: worker job not found: {normalized_job_id}"
        except ValueError as exc:
            return f"Error: {exc}"

        return f"Error: unsupported action '{normalized_action or '<empty>'}'"

    @staticmethod
    def _render_result(action: str, payload: dict[str, object]) -> str:
        job = dict(payload.get("job") or {})
        summary = dict(payload.get("summary") or {})
        review = payload.get("review")
        lines = [
            "reporting_contract=verified_state_only",
            f"request_type=worker_{action}",
            "request_recorded=true",
            f"job_id={job.get('job_id') or ''}",
            f"worker_kind={job.get('worker_kind') or ''}",
            f"job_status={job.get('status') or ''}",
            f"requested_mode={job.get('requested_mode') or ''}",
            f"write_scope={job.get('write_scope') or ''}",
            f"repo_root={job.get('repo_root') or ''}",
            f"session_name={job.get('session_name') or ''}",
            f"blocked_reason={_clean(job.get('blocked_reason') or '')}",
            f"awaiting_operator_decision={summary.get('awaiting_operator_decision')}",
            f"next_recommended_action={summary.get('next_recommended_action') or 'none'}",
            f"review_decision={_clean((review or {}).get('decision') if isinstance(review, dict) else '')}",
            "next_check=use_worker_status",
        ]
        return "\n".join(lines)
