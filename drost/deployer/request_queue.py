from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.deployer.state import DeployerStateStore

VALID_REQUEST_TYPES = {"restart", "deploy_candidate", "rollback"}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _timestamp_slug() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")


@dataclass(slots=True)
class DeployerRequest:
    request_id: str
    type: str
    created_at: str
    requested_by: str
    reason: str
    candidate_ref: str
    rollback_ref: str
    metadata: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class DeployerRequestQueue:
    def __init__(self, store: DeployerStateStore) -> None:
        self._store = store
        self.bootstrap()

    def bootstrap(self) -> None:
        self._store.pending_requests_dir.mkdir(parents=True, exist_ok=True)
        self._store.inflight_requests_dir.mkdir(parents=True, exist_ok=True)
        self._store.processed_requests_dir.mkdir(parents=True, exist_ok=True)
        self._store.failed_requests_dir.mkdir(parents=True, exist_ok=True)

    def _request_path(self, directory: Path, request: DeployerRequest) -> Path:
        return directory / f"{_timestamp_slug()}_{request.request_id}.json"

    @staticmethod
    def _read_request(path: Path) -> DeployerRequest:
        payload = json.loads(path.read_text(encoding="utf-8"))
        metadata = payload.get("metadata")
        return DeployerRequest(
            request_id=str(payload.get("request_id") or "").strip(),
            type=str(payload.get("type") or "").strip(),
            created_at=str(payload.get("created_at") or "").strip(),
            requested_by=str(payload.get("requested_by") or "").strip(),
            reason=str(payload.get("reason") or "").strip(),
            candidate_ref=str(payload.get("candidate_ref") or "").strip(),
            rollback_ref=str(payload.get("rollback_ref") or "").strip(),
            metadata=dict(metadata) if isinstance(metadata, dict) else {},
        )

    @staticmethod
    def _write_request(path: Path, request: DeployerRequest) -> None:
        temp_path = path.with_suffix(path.suffix + ".tmp")
        temp_path.write_text(json.dumps(request.as_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temp_path, path)

    def _sorted_requests(self, directory: Path) -> list[tuple[Path, DeployerRequest]]:
        rows: list[tuple[Path, DeployerRequest]] = []
        for path in sorted(directory.glob("*.json")):
            rows.append((path, self._read_request(path)))
        return rows

    def _sync_status(self) -> None:
        status = self._store.read_status()
        status["pending_request_ids"] = self.pending_request_ids()
        self._store.write_status(status)

    def pending_request_ids(self) -> list[str]:
        request_ids: list[str] = []
        for directory in (self._store.inflight_requests_dir, self._store.pending_requests_dir):
            for _, request in self._sorted_requests(directory):
                if request.request_id:
                    request_ids.append(request.request_id)
        return request_ids

    def list_requests(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "inflight": [request.as_dict() for _, request in self._sorted_requests(self._store.inflight_requests_dir)],
            "pending": [request.as_dict() for _, request in self._sorted_requests(self._store.pending_requests_dir)],
            "processed": [request.as_dict() for _, request in self._sorted_requests(self._store.processed_requests_dir)],
            "failed": [request.as_dict() for _, request in self._sorted_requests(self._store.failed_requests_dir)],
        }

    def enqueue(
        self,
        request_type: str,
        *,
        requested_by: str = "",
        reason: str = "",
        candidate_ref: str = "",
        rollback_ref: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> DeployerRequest:
        normalized_type = str(request_type or "").strip()
        if normalized_type not in VALID_REQUEST_TYPES:
            raise ValueError(f"unsupported request type: {normalized_type or '<empty>'}")

        new_request = DeployerRequest(
            request_id=f"req_{uuid.uuid4().hex[:12]}",
            type=normalized_type,
            created_at=_utc_now(),
            requested_by=str(requested_by or "").strip(),
            reason=str(reason or "").strip(),
            candidate_ref=str(candidate_ref or "").strip(),
            rollback_ref=str(rollback_ref or "").strip(),
            metadata=dict(metadata or {}),
        )

        for directory in (self._store.inflight_requests_dir, self._store.pending_requests_dir):
            for _, existing in self._sorted_requests(directory):
                if (
                    existing.type == new_request.type
                    and existing.candidate_ref == new_request.candidate_ref
                    and existing.rollback_ref == new_request.rollback_ref
                ):
                    self._store.append_event(
                        "request_deduplicated",
                        request_id=existing.request_id,
                        type=existing.type,
                        candidate_ref=existing.candidate_ref,
                        rollback_ref=existing.rollback_ref,
                    )
                    self._sync_status()
                    return existing

        target = self._request_path(self._store.pending_requests_dir, new_request)
        self._write_request(target, new_request)
        self._store.append_event(
            "request_received",
            request_id=new_request.request_id,
            type=new_request.type,
            requested_by=new_request.requested_by,
            candidate_ref=new_request.candidate_ref,
            rollback_ref=new_request.rollback_ref,
            reason=new_request.reason,
        )
        self._sync_status()
        return new_request

    def claim_next(self) -> DeployerRequest | None:
        inflight = self._sorted_requests(self._store.inflight_requests_dir)
        if inflight:
            request = inflight[0][1]
            self._sync_status()
            return request

        pending = self._sorted_requests(self._store.pending_requests_dir)
        if not pending:
            self._sync_status()
            return None

        source_path, request = pending[0]
        target_path = self._store.inflight_requests_dir / source_path.name
        os.replace(source_path, target_path)
        self._sync_status()
        return request

    def mark_processed(self, request: DeployerRequest) -> None:
        self._move_from_inflight(request.request_id, self._store.processed_requests_dir)

    def mark_failed(self, request: DeployerRequest) -> None:
        self._move_from_inflight(request.request_id, self._store.failed_requests_dir)

    def _move_from_inflight(self, request_id: str, target_dir: Path) -> None:
        request_id = str(request_id or "").strip()
        for path, request in self._sorted_requests(self._store.inflight_requests_dir):
            if request.request_id == request_id:
                os.replace(path, target_dir / path.name)
                self._sync_status()
                return
        self._sync_status()
