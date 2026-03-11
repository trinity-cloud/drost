from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.followups import FollowUpStore
from drost.idle_heartbeat import IdleHeartbeatRunner
from drost.idle_state import IdleStateStore
from drost.loop_events import LoopEventBus
from drost.providers import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta


class HeartbeatProvider(BaseProvider):
    def __init__(self, *, content: str) -> None:
        self._content = content
        self.system_prompt = ""
        self.messages: list[Message] = []

    @property
    def name(self) -> str:
        return "heartbeat-test"

    @property
    def model(self) -> str:
        return "heartbeat-model"

    async def chat(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = tools, max_tokens, temperature, stop_sequences
        self.system_prompt = str(system or "")
        self.messages = list(messages)
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=self._content),
            finish_reason="stop",
        )

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ):
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        if False:
            yield StreamDelta(content="")


async def _wait_until(predicate, *, timeout: float = 1.5) -> None:
    import asyncio

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    assert predicate()


@pytest.mark.asyncio
async def test_idle_heartbeat_surfaces_due_followup_when_idle(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="CPAP fitting appointment",
        entity_refs=["people/migel"],
        source_excerpt="CPAP fitting appointment tomorrow at 11am",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.95,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "surface_follow_up"
    assert sent == [(8271705169, "How did the CPAP fitting go?")]
    item = followups.list_followups(chat_id=8271705169)[0]
    assert item["status"] == "surfaced"


@pytest.mark.asyncio
async def test_idle_heartbeat_suppresses_proactive_send_while_active(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Deploy stability review",
        entity_refs=["projects/drost"],
        source_excerpt="check stability later",
        follow_up_prompt="Has the deployer-default startup path been stable?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.88,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now)

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "noop"
    assert result["why"] == "active_mode"
    assert sent == []


@pytest.mark.asyncio
async def test_idle_heartbeat_respects_provider_noop_decision(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []
    provider = HeartbeatProvider(content='{"decision":"noop","reason":"not worth interrupting","confidence":0.91}')
    (tmp_path / "HEARTBEAT.md").write_text("Prefer restraint.", encoding="utf-8")

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Low-signal check-in",
        entity_refs=["people/migel"],
        source_excerpt="Maybe check later",
        follow_up_prompt="Any update?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="low",
        confidence=0.86,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        provider_getter=lambda: provider,
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "noop"
    assert result["reason"] == "not worth interrupting"
    assert sent == []
    assert "[Workspace: HEARTBEAT.md]" in provider.system_prompt


@pytest.mark.asyncio
async def test_idle_heartbeat_respects_provider_surface_decision(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    artifacts = CognitiveArtifactStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    first, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Lower-priority item",
        entity_refs=["projects/drost"],
        source_excerpt="Less important",
        follow_up_prompt="Has the deployer been stable?",
        due_at=(now - timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.9,
    )
    second, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Higher-signal health follow-up",
        entity_refs=["people/migel"],
        source_excerpt="CPAP fitting yesterday",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.98,
    )
    provider = HeartbeatProvider(
        content=(
            '{'
            f'"decision":"surface_follow_up","follow_up_id":"{second["id"]}",'
            '"message":"How did the CPAP fitting go?","reason":"High-priority health milestone","confidence":0.97'
            '}'
        )
    )
    artifacts.append_reflection(
        {
            "reflection_id": "refl_health",
            "timestamp": "2026-03-09T11:30:00Z",
            "kind": "pattern",
            "summary": "The health thread is the most time-sensitive open thread.",
            "importance": 0.9,
            "actionability": 0.8,
            "suggested_drive_tags": ["health"],
        }
    )
    artifacts.replace_drive_state(
        {
            "active_items": [
                {
                    "drive_id": "drv_health",
                    "title": "Follow up on CPAP fitting",
                    "summary": "This is due and should be surfaced while idle.",
                    "priority": 0.95,
                    "kind": "open_thread",
                    "recommended_channel": "heartbeat",
                    "source_refs": [str(second["id"])],
                }
            ]
        }
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=3))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        provider_getter=lambda: provider,
        artifact_store=artifacts,
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "surface_follow_up"
    assert result["follow_up_id"] == second["id"]
    assert sent == [(8271705169, "How did the CPAP fitting go?")]
    payload = json.loads(str(provider.messages[0].content or ""))
    assert payload["current_internal_agenda"][0]["drive_id"] == "drv_health"
    assert payload["recent_reflections"][0]["reflection_id"] == "refl_health"
    items = {row["id"]: row for row in followups.list_followups(chat_id=8271705169)}
    assert items[first["id"]]["status"] == "pending"
    assert items[second["id"]]["status"] == "surfaced"


@pytest.mark.asyncio
async def test_idle_heartbeat_deterministic_fallback_prefers_heartbeat_channel(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    artifacts = CognitiveArtifactStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    first, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="General deploy check",
        entity_refs=["projects/drost"],
        source_excerpt="General deploy health check",
        follow_up_prompt="Has the deploy path been stable?",
        due_at=(now - timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.95,
    )
    second, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Health follow-up",
        entity_refs=["people/migel"],
        source_excerpt="CPAP fitting yesterday",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.8,
    )
    artifacts.replace_drive_state(
        {
            "active_items": [
                {
                    "drive_id": "drv_health",
                    "title": "Follow up on CPAP fitting",
                    "summary": "Prefer proactive heartbeat for the health thread.",
                    "priority": 0.95,
                    "kind": "open_thread",
                    "recommended_channel": "heartbeat",
                    "source_refs": [str(second["id"])],
                },
                {
                    "drive_id": "drv_deploy",
                    "title": "Review deploy stability in normal conversation",
                    "summary": "Do not proactively interrupt for this.",
                    "priority": 0.8,
                    "kind": "open_thread",
                    "recommended_channel": "conversation_only",
                    "source_refs": [str(first["id"])],
                },
            ]
        }
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=3))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        artifact_store=artifacts,
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "surface_follow_up"
    assert result["follow_up_id"] == second["id"]
    assert sent == [(8271705169, "How did the CPAP fitting go?")]


@pytest.mark.asyncio
async def test_idle_heartbeat_writes_audit_and_shared_state_on_noop(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    artifacts = CognitiveArtifactStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []
    provider = HeartbeatProvider(content='{"decision":"noop","reason":"drive says wait","confidence":0.8}')

    item, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Wait on docs",
        entity_refs=["projects/drost"],
        source_excerpt="Later, not now",
        follow_up_prompt="Any docs update?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.85,
    )
    artifacts.replace_drive_state(
        {
            "active_items": [
                {
                    "drive_id": "drv_docs",
                    "title": "Hold docs follow-up",
                    "summary": "Wait until the next normal conversation.",
                    "priority": 0.8,
                    "kind": "open_thread",
                    "recommended_channel": "hold",
                    "source_refs": [str(item["id"])],
                }
            ]
        }
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        provider_getter=lambda: provider,
        artifact_store=artifacts,
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "noop"
    assert sent == []
    audit_lines = runner.audit_path.read_text(encoding="utf-8").splitlines()
    assert audit_lines
    audit = json.loads(audit_lines[-1])
    assert audit["decision"] == "noop"
    assert audit["reason"] == "drive says wait"
    shared = idle_state.shared_mind_state.snapshot()
    assert shared["heartbeat"]["last_decision"] == "noop"
    assert shared["heartbeat"]["last_follow_up_id"] == ""
    assert shared["heartbeat"]["last_audit_id"] == audit["audit_id"]


@pytest.mark.asyncio
async def test_idle_heartbeat_wakes_on_followup_created_event(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    bus = LoopEventBus()
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))
    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        event_bus=bus,
        enabled=True,
        proactive_enabled=True,
        interval_seconds=3600,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    await runner.start()
    try:
        item, _ = followups.upsert_extracted_followup(
            chat_id=8271705169,
            source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
            kind="check_in",
            subject="CPAP fitting appointment",
            entity_refs=["people/migel"],
            source_excerpt="CPAP fitting appointment tomorrow at 11am",
            follow_up_prompt="How did the CPAP fitting go?",
            due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            priority="high",
            confidence=0.95,
        )
        bus.emit(
            "followup_created",
            scope={"chat_id": 8271705169, "session_key": str(item.get("source_session_key") or "")},
            payload={"follow_up_id": str(item.get("id") or "")},
        )
        await _wait_until(lambda: len(sent) == 1)
    finally:
        await runner.stop()

    assert sent == [(8271705169, "How did the CPAP fitting go?")]
    status = bus.status()
    assert status["event_counts"]["followup_created"] == 1
    assert status["event_counts"]["heartbeat_decision_made"] >= 1
    assert status["event_counts"]["proactive_surface_sent"] == 1


@pytest.mark.asyncio
async def test_idle_heartbeat_respects_central_background_policy(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Policy-gated item",
        entity_refs=["projects/drost"],
        source_excerpt="Check after deploy",
        follow_up_prompt="Has the deploy path been stable?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.9,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        background_policy=lambda loop_name: {"allowed": False, "reason": "degraded_mode"},
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "noop"
    assert result["why"] == "degraded_mode"
    assert sent == []


async def _record_send(log: list[tuple[int, str]], chat_id: int, message: str) -> Any:
    log.append((chat_id, message))
    return {"ok": True}
