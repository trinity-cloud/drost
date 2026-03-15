from __future__ import annotations

from drost.config import Settings
from drost.deployer.client import DeployerClient
from drost.deployer.reporting import derive_reporting_fields
from drost.tools.base import BaseTool


class DeployerRequestTool(BaseTool):
    def __init__(self, *, settings: Settings) -> None:
        self._client = DeployerClient.from_runtime(
            repo_root=str(settings.repo_root),
            workspace_dir=str(settings.workspace_dir),
        )

    @property
    def name(self) -> str:
        return "deployer_request"

    @property
    def description(self) -> str:
        return (
            "Queue deployer lifecycle actions. Use this instead of shell_execute for restart, "
            "candidate deploy, or rollback. Promote is immediate and only for marking the "
            "current healthy runtime as known-good. Queued actions are requests, not proof that "
            "the runtime is already live on the target commit."
        )

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["restart", "deploy", "rollback", "promote"],
                    "description": "Lifecycle action to request.",
                },
                "candidate_ref": {
                    "type": "string",
                    "description": "Required for deploy. Git ref or commit to deploy.",
                },
                "rollback_ref": {
                    "type": "string",
                    "description": "Optional rollback target ref or commit. Defaults to known-good.",
                },
                "reason": {
                    "type": "string",
                    "description": "Short reason for the action.",
                },
                "requested_by": {
                    "type": "string",
                    "description": "Who requested it. Defaults to drost-agent.",
                },
            },
            "required": ["action"],
        }

    async def execute(
        self,
        *,
        action: str,
        candidate_ref: str | None = None,
        rollback_ref: str | None = None,
        reason: str | None = None,
        requested_by: str | None = None,
    ) -> str:
        normalized_action = str(action or "").strip().lower()
        requested_by_value = str(requested_by or "").strip() or "drost-agent"
        reason_value = str(reason or "").strip()

        if normalized_action == "deploy":
            if not str(candidate_ref or "").strip():
                return "Error: candidate_ref is required for deploy"
            request = self._client.queue_request(
                action="deploy",
                requested_by=requested_by_value,
                reason=reason_value,
                candidate_ref=str(candidate_ref or "").strip(),
                metadata={"source": "drost-tool"},
            )
            status = self._client.status()
            reporting = derive_reporting_fields(status)
            return "\n".join(
                [
                    "reporting_contract=verified_state_only",
                    "request_queued=true",
                    "request_state=requested",
                    f"request_persisted={'true' if request.request_id in list(status.get('pending_request_ids') or []) else 'false'}",
                    "runtime_transition_verified=false",
                    f"runtime_state={reporting['runtime_state']}",
                    f"active_commit={status.get('active_commit') or ''}",
                    f"repo_head_commit={status.get('repo_head_commit') or ''}",
                    f"known_good_commit={status.get('known_good_commit') or ''}",
                    f"request_id={request.request_id}",
                    "type=deploy_candidate",
                    f"candidate_ref={request.candidate_ref}",
                    f"reason={request.reason}",
                    "next_check=use_deployer_status",
                ]
            )

        if normalized_action == "restart":
            request = self._client.queue_request(
                action="restart",
                requested_by=requested_by_value,
                reason=reason_value,
                metadata={"source": "drost-tool"},
            )
            status = self._client.status()
            reporting = derive_reporting_fields(status)
            return "\n".join(
                [
                    "reporting_contract=verified_state_only",
                    "request_queued=true",
                    "request_state=requested",
                    f"request_persisted={'true' if request.request_id in list(status.get('pending_request_ids') or []) else 'false'}",
                    "runtime_transition_verified=false",
                    f"runtime_state={reporting['runtime_state']}",
                    f"active_commit={status.get('active_commit') or ''}",
                    f"repo_head_commit={status.get('repo_head_commit') or ''}",
                    f"known_good_commit={status.get('known_good_commit') or ''}",
                    f"request_id={request.request_id}",
                    "type=restart",
                    f"reason={request.reason}",
                    "next_check=use_deployer_status",
                ]
            )

        if normalized_action == "rollback":
            request = self._client.queue_request(
                action="rollback",
                requested_by=requested_by_value,
                reason=reason_value,
                rollback_ref=str(rollback_ref or "").strip(),
                metadata={"source": "drost-tool"},
            )
            status = self._client.status()
            reporting = derive_reporting_fields(status)
            return "\n".join(
                [
                    "reporting_contract=verified_state_only",
                    "request_queued=true",
                    "request_state=requested",
                    f"request_persisted={'true' if request.request_id in list(status.get('pending_request_ids') or []) else 'false'}",
                    "runtime_transition_verified=false",
                    f"runtime_state={reporting['runtime_state']}",
                    f"active_commit={status.get('active_commit') or ''}",
                    f"repo_head_commit={status.get('repo_head_commit') or ''}",
                    f"known_good_commit={status.get('known_good_commit') or ''}",
                    f"request_id={request.request_id}",
                    "type=rollback",
                    f"rollback_ref={request.rollback_ref or '(known-good)'}",
                    f"reason={request.reason}",
                    "next_check=use_deployer_status",
                ]
            )

        if normalized_action == "promote":
            payload = self._client.promote_current()
            reporting = derive_reporting_fields(payload)
            outcome = "promoted" if reporting["promotion_state"] == "promoted" and not str(payload.get("last_error") or "").strip() else "failed"
            return "\n".join(
                [
                    "reporting_contract=verified_state_only",
                    "request_queued=false",
                    f"request_state={outcome}",
                    "runtime_transition_verified=true",
                    f"runtime_state={reporting['runtime_state']}",
                    f"promotion_state={reporting['promotion_state']}",
                    f"last_outcome={reporting['last_outcome']}",
                    "type=promote",
                    f"state={payload.get('state') or ''}",
                    f"repo_head_commit={payload.get('repo_head_commit') or ''}",
                    f"active_commit={payload.get('active_commit') or ''}",
                    f"known_good_commit={payload.get('known_good_commit') or ''}",
                    f"last_error={payload.get('last_error') or ''}",
                ]
            )

        return f"Error: unsupported action '{normalized_action or '<empty>'}'"
