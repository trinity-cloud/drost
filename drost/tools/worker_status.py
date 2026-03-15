from __future__ import annotations

from drost.config import Settings
from drost.tools.base import BaseTool
from drost.worker_supervision import WorkerSupervisor


def _clean(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


class WorkerStatusTool(BaseTool):
    def __init__(self, *, settings: Settings) -> None:
        self._workers = WorkerSupervisor(settings)

    @property
    def name(self) -> str:
        return "worker_status"

    @property
    def description(self) -> str:
        return (
            "Inspect supervised Codex/Claude worker jobs. Use this instead of shell/tmux polling "
            "to see whether a job is running, blocked, ready for review, accepted, rejected, or failed."
        )

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "Optional worker job id. Omit to list the current worker board.",
                },
                "include_task_spec": {
                    "type": "boolean",
                    "description": "Include the canonical task spec when inspecting one job.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum jobs to list when job_id is omitted. Defaults to 10.",
                },
            },
            "required": [],
        }

    async def execute(
        self,
        *,
        job_id: str | None = None,
        include_task_spec: bool | None = None,
        limit: int | None = None,
    ) -> str:
        normalized_job_id = _clean(job_id)
        if normalized_job_id:
            payload = self._workers.get_job(normalized_job_id, refresh=True)
            if payload is None:
                return f"Error: worker job not found: {normalized_job_id}"
            job = dict(payload.get("job") or {})
            summary = dict(payload.get("summary") or {})
            review = payload.get("review")
            artifacts = dict(payload.get("artifacts") or {})
            lines = [
                "reporting_contract=verified_state_only",
                "scope=job",
                f"job_id={job.get('job_id') or ''}",
                f"worker_kind={job.get('worker_kind') or ''}",
                f"job_status={job.get('status') or ''}",
                f"requested_mode={job.get('requested_mode') or ''}",
                f"write_scope={job.get('write_scope') or ''}",
                f"repo_root={job.get('repo_root') or ''}",
                f"session_name={job.get('session_name') or ''}",
                f"started_at={job.get('started_at') or ''}",
                f"completed_at={job.get('completed_at') or ''}",
                f"last_visible_output_at={job.get('last_visible_output_at') or ''}",
                f"session_exists={payload.get('session_exists')}",
                f"blocked_reason={_clean(job.get('blocked_reason') or '')}",
                f"has_diff={summary.get('has_diff')}",
                f"awaiting_operator_decision={summary.get('awaiting_operator_decision')}",
                f"next_recommended_action={summary.get('next_recommended_action') or 'none'}",
                f"tests_requested={summary.get('tests_requested')}",
                f"tests_passed={artifacts.get('tests_passed')}",
                f"requested_tests={','.join(job.get('requested_tests') or [])}",
                f"requested_outputs={','.join(job.get('requested_outputs') or [])}",
                f"review_decision={_clean((review or {}).get('decision') if isinstance(review, dict) else '')}",
                "last_message:",
                str(payload.get("last_message") or ""),
                "stdout_tail:",
                str(payload.get("stdout_tail") or ""),
                "stderr_tail:",
                str(payload.get("stderr_tail") or ""),
            ]
            if include_task_spec:
                lines.extend(["task_spec:", str(payload.get("task_spec") or "")])
            return "\n".join(lines)

        board = self._workers.status()
        rows = list(board.get("jobs") or [])[: max(1, int(limit or 10))]
        counts = dict(board.get("counts") or {})
        active = dict(board.get("active_write_jobs_by_repo") or {})
        lines = [
            "reporting_contract=verified_state_only",
            "scope=board",
            f"count={board.get('count') or 0}",
            "counts="
            + ",".join(f"{name}:{counts[name]}" for name in sorted(counts))
            if counts
            else "counts=",
            "active_write_jobs="
            + ",".join(f"{repo}={job}" for repo, job in sorted(active.items()))
            if active
            else "active_write_jobs=",
            "jobs:",
        ]
        if not rows:
            lines.append("- (none)")
            return "\n".join(lines)
        for row in rows:
            lines.append(
                " ".join(
                    [
                        f"- job_id={row.get('job_id') or ''}",
                        f"worker_kind={row.get('worker_kind') or ''}",
                        f"status={row.get('status') or ''}",
                        f"requested_mode={row.get('requested_mode') or ''}",
                        f"repo_root={row.get('repo_root') or ''}",
                        f"session_name={row.get('session_name') or ''}",
                        f"next_recommended_action={row.get('next_recommended_action') or 'none'}",
                        f"blocked_reason={_clean(row.get('blocked_reason') or '')}",
                    ]
                )
            )
        return "\n".join(lines)
