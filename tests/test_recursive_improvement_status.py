from __future__ import annotations

from types import SimpleNamespace

from drost.deployer.client import DeployerClient
from drost.gateway import Gateway


class _FakeWorkers:
    def status(self) -> dict[str, object]:
        return {
            "count": 1,
            "counts": {"ready_for_review": 1},
            "active_write_jobs_by_repo": {},
            "jobs": [{"job_id": "w_codex_1", "status": "ready_for_review"}],
        }

    def list_jobs(self, *, refresh: bool = True, detailed: bool = False) -> list[dict[str, object]]:
        _ = refresh, detailed
        return [{"job_id": "w_codex_1", "status": "ready_for_review"}]


class _FakeSelfModel:
    def status(self) -> dict[str, object]:
        return {
            "runtime": {"repo_root": "/repo"},
            "deployer": {"active_commit": "abc123"},
            "workers": {"codex_available": True},
            "lessons": ["verify active_commit"],
        }


def test_recursive_improvement_status_payload_aggregates_deployer_workers_and_self_model(monkeypatch) -> None:
    fake_client = SimpleNamespace(
        status=lambda: {
            "state": "healthy",
            "repo_head_commit": "abc123",
            "active_commit": "abc123",
            "known_good_commit": "abc123",
            "child_pid": 1234,
            "requests": {"pending": [], "inflight": [], "processed": [], "failed": []},
        },
        store=SimpleNamespace(events_path="/tmp/missing.jsonl"),
    )
    monkeypatch.setattr(DeployerClient, "from_runtime", classmethod(lambda cls, *, repo_root, workspace_dir: fake_client))

    gateway = Gateway.__new__(Gateway)
    gateway.settings = SimpleNamespace(repo_root="/repo", workspace_dir="/workspace")
    gateway.workers = _FakeWorkers()
    gateway.operational_truths = _FakeSelfModel()

    payload = Gateway._recursive_improvement_status_payload(gateway)

    assert payload["deployer"]["reporting"]["runtime_state"] == "healthy/live"
    assert payload["workers"]["count"] == 1
    assert payload["self_model"]["runtime"]["repo_root"] == "/repo"


def test_recursive_improvement_history_payload_reads_deployer_events_and_worker_jobs(monkeypatch, tmp_path) -> None:
    events_path = tmp_path / "events.jsonl"
    events_path.write_text('{"event_type":"request_received","request_id":"req_1"}\n', encoding="utf-8")
    fake_client = SimpleNamespace(
        status=lambda: {},
        store=SimpleNamespace(events_path=events_path),
    )
    monkeypatch.setattr(DeployerClient, "from_runtime", classmethod(lambda cls, *, repo_root, workspace_dir: fake_client))

    gateway = Gateway.__new__(Gateway)
    gateway.settings = SimpleNamespace(repo_root="/repo", workspace_dir="/workspace")
    gateway.workers = _FakeWorkers()

    payload = Gateway._recursive_improvement_history_payload(gateway, limit=5)

    assert payload["deployer_events"][0]["event_type"] == "request_received"
    assert payload["worker_jobs"][0]["job_id"] == "w_codex_1"
