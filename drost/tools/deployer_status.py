from __future__ import annotations

from drost.config import Settings
from drost.deployer.client import DeployerClient
from drost.tools.base import BaseTool


class DeployerStatusTool(BaseTool):
    def __init__(self, *, settings: Settings) -> None:
        self._client = DeployerClient.from_runtime(
            repo_root=str(settings.repo_root),
            workspace_dir=str(settings.workspace_dir),
        )

    @property
    def name(self) -> str:
        return "deployer_status"

    @property
    def description(self) -> str:
        return "Inspect deployer status, known-good commit, and queued deploy requests."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }

    async def execute(self) -> str:
        payload = self._client.status()
        known_good = payload.get("known_good")
        requests = payload.get("requests")
        lines = [
            f"state={payload.get('state') or ''}",
            f"repo_head_commit={payload.get('repo_head_commit') or ''}",
            f"active_commit={payload.get('active_commit') or ''}",
            f"known_good_commit={payload.get('known_good_commit') or ''}",
            f"requested_candidate_commit={payload.get('requested_candidate_commit') or ''}",
            f"child_pid={payload.get('child_pid')}",
            f"last_health_ok_at={payload.get('last_health_ok_at') or ''}",
            f"last_noop_reason={payload.get('last_noop_reason') or ''}",
            f"last_error={payload.get('last_error') or ''}",
            f"active_request_id={payload.get('active_request_id') or ''}",
            f"active_request_type={payload.get('active_request_type') or ''}",
            f"pending_request_ids={payload.get('pending_request_ids') or []}",
        ]
        if isinstance(known_good, dict):
            lines.extend(
                [
                    "known_good_record:",
                    f"ref_name={known_good.get('ref_name') or ''}",
                    f"commit={known_good.get('commit') or ''}",
                    f"promoted_at={known_good.get('promoted_at') or ''}",
                ]
            )
        if isinstance(requests, dict):
            lines.extend(
                [
                    f"request_counts=pending:{len(requests.get('pending', []))} "
                    f"inflight:{len(requests.get('inflight', []))} "
                    f"processed:{len(requests.get('processed', []))} "
                    f"failed:{len(requests.get('failed', []))}",
                ]
            )
        return "\n".join(lines)
