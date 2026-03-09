from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from drost.deployer.config import DeployerConfig
from drost.deployer.request_queue import DeployerRequest, DeployerRequestQueue
from drost.deployer.rollout import DeployerRolloutManager
from drost.deployer.state import DeployerStateStore
from drost.deployer.supervisor import DeployerSupervisor


@dataclass(slots=True)
class DeployerClient:
    config: DeployerConfig
    store: DeployerStateStore
    queue: DeployerRequestQueue
    supervisor: DeployerSupervisor
    rollout: DeployerRolloutManager

    @classmethod
    def from_runtime(cls, *, repo_root: str, workspace_dir: str) -> DeployerClient:
        config = DeployerConfig.load(repo_root=repo_root, workspace_dir=workspace_dir)
        store = DeployerStateStore(config)
        store.bootstrap()
        queue = DeployerRequestQueue(store)
        supervisor = DeployerSupervisor(store)
        rollout = DeployerRolloutManager(store=store, supervisor=supervisor)
        return cls(
            config=config,
            store=store,
            queue=queue,
            supervisor=supervisor,
            rollout=rollout,
        )

    def status(self) -> dict[str, Any]:
        status = self.supervisor.refresh_status()
        status["pending_request_ids"] = self.queue.pending_request_ids()
        status["requests"] = self.queue.list_requests()
        status["known_good"] = self.store.read_known_good()
        return status

    def queue_request(
        self,
        *,
        action: str,
        requested_by: str = "",
        reason: str = "",
        candidate_ref: str = "",
        rollback_ref: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> DeployerRequest:
        normalized_action = str(action or "").strip()
        if normalized_action == "deploy":
            normalized_action = "deploy_candidate"
        return self.queue.enqueue(
            normalized_action,
            requested_by=requested_by,
            reason=reason,
            candidate_ref=candidate_ref,
            rollback_ref=rollback_ref,
            metadata=metadata,
        )

    def promote_current(self) -> dict[str, Any]:
        return self.rollout.promote_current()
