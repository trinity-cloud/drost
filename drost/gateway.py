from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from drost.agent import AgentRuntime
from drost.channels import TelegramChannel
from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.config import Settings
from drost.conversation_loop import ConversationLoop
from drost.drive_loop import DriveLoop
from drost.embeddings import EmbeddingService
from drost.followups import FollowUpStore
from drost.idle_heartbeat import IdleHeartbeatRunner
from drost.idle_state import IdleStateStore
from drost.loop_events import LoopEventBus
from drost.loop_manager import LoopManager
from drost.managed_loop import LoopPriority, LoopVisibility, ManagedRunnerLoop
from drost.memory_maintenance import MemoryMaintenanceRunner
from drost.providers import build_provider_registry
from drost.quality_gates import QualityGateEvaluator
from drost.reflection_loop import ReflectionLoop
from drost.session_continuity import ContinuityJobRequest, SessionContinuityManager
from drost.shared_mind_state import SharedMindState
from drost.storage import SQLiteStore
from drost.worker_supervision import WorkerSupervisor

logger = logging.getLogger(__name__)

_TRIVIAL_HEARTBEAT_REASONS = {"active_mode", "interval_not_elapsed", "no_due_followups"}


class ProviderSelectRequest(BaseModel):
    provider: str


class ChatRequest(BaseModel):
    chat_id: int
    text: str = ""
    media: list[dict[str, Any]] | None = None
    session_id: str | None = None


class PromotionReviewRequest(BaseModel):
    approved: bool
    note: str = ""
    sample_size: int = 0


class WorkerLaunchRequest(BaseModel):
    worker_kind: str
    prompt: str
    repo_root: str | None = None
    requested_mode: str = "implement"
    write_scope: str = "repo"
    requested_outputs: list[str] = Field(default_factory=list)
    requested_tests: list[str] = Field(default_factory=list)
    requested_by: str = "operator"


class WorkerReviewRequest(BaseModel):
    decision: str
    reviewer: str = "operator"
    notes: str = ""


class WorkerRetryRequest(BaseModel):
    requested_by: str = "operator"
    reason: str = ""


class WorkerStopRequest(BaseModel):
    reason: str = ""


class Gateway:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

        self.store = SQLiteStore(
            db_path=settings.sqlite_path,
            vector_extension_path=settings.sqvector_extension_path,
            vector_dimensions=settings.memory_embedding_dimensions,
        )
        self.providers = build_provider_registry(settings)
        self.embeddings = EmbeddingService(settings)
        self.followups = FollowUpStore(settings.workspace_dir)
        self.workers = WorkerSupervisor(settings)
        self.cognitive_artifacts = CognitiveArtifactStore(settings.workspace_dir)
        self.loop_events = LoopEventBus()
        self.shared_mind_state = SharedMindState(
            settings.workspace_dir,
            cognitive_artifacts=self.cognitive_artifacts,
        )
        self.quality_gates = QualityGateEvaluator(
            settings.workspace_dir,
            reflection_min_samples=settings.quality_reflection_min_samples,
            reflection_skip_ratio_threshold=settings.quality_reflection_skip_ratio_threshold,
            heartbeat_min_samples=settings.quality_heartbeat_min_samples,
            heartbeat_meaningful_ratio_threshold=settings.quality_heartbeat_meaningful_ratio_threshold,
            deploy_canary_recent_window=settings.quality_deploy_canary_recent_window,
            deploy_canary_min_samples=settings.quality_deploy_canary_min_samples,
            deploy_canary_pass_rate_threshold=settings.quality_deploy_canary_pass_rate_threshold,
            deploy_canary_consecutive_ok_threshold=settings.quality_deploy_canary_consecutive_ok_threshold,
        )
        self.loop_manager = LoopManager(
            shared_mind_state=self.shared_mind_state,
            active_window_seconds=settings.idle_active_window_seconds,
        )
        self.idle_state = IdleStateStore(shared_mind_state=self.shared_mind_state)
        self.agent = AgentRuntime(
            settings=settings,
            providers=self.providers,
            store=self.store,
            embeddings=self.embeddings,
            event_bus=self.loop_events,
        )
        self.memory_maintenance = MemoryMaintenanceRunner(
            workspace_dir=settings.workspace_dir,
            sessions_dir=settings.workspace_dir / "sessions",
            provider_getter=self.providers.get,
            sync_memory_index=self.agent.sync_memory_index,
            enabled=settings.memory_enabled and settings.memory_maintenance_enabled,
            event_bus=self.loop_events,
            policy_gate=self.loop_manager.background_policy,
            interval_seconds=settings.memory_maintenance_interval_seconds,
            max_events_per_run=settings.memory_maintenance_max_events_per_run,
            entity_synthesis_enabled=settings.memory_entity_synthesis_enabled,
            memory_promotion_enabled=settings.memory_promotion_enabled,
            memory_promotion_interval_seconds=settings.memory_promotion_interval_seconds,
            memory_promotion_confidence_threshold=settings.memory_promotion_confidence_threshold,
            memory_promotion_stability_threshold=settings.memory_promotion_stability_threshold,
            followups=self.followups,
            followups_enabled=settings.followups_enabled,
            followup_confidence_threshold=settings.followup_confidence_threshold,
        )
        self.session_continuity = SessionContinuityManager(
            store=self.store,
            sessions_dir=settings.workspace_dir / "sessions",
            provider_getter=self.providers.get,
            embed_document=self.embeddings.embed_document,
            event_bus=self.loop_events,
            enabled=settings.memory_continuity_enabled,
            auto_on_new=settings.memory_continuity_auto_on_new,
            source_max_messages=settings.memory_continuity_source_max_messages,
            source_max_chars=settings.memory_continuity_source_max_chars,
            summary_max_tokens=settings.memory_continuity_summary_max_tokens,
            summary_max_chars=settings.memory_continuity_summary_max_chars,
        )

        if not settings.telegram_bot_token:
            raise ValueError("DROST_TELEGRAM_BOT_TOKEN is required")

        self.telegram = TelegramChannel(
            token=settings.telegram_bot_token,
            store=self.store,
            webhook_url=settings.telegram_webhook_url or None,
            webhook_path=settings.telegram_webhook_path,
            webhook_secret=settings.telegram_webhook_secret or None,
            allowed_users=settings.telegram_allowed_user_ids,
            attachments_dir=settings.attachments_dir,
            max_inline_image_bytes=settings.vision_max_inline_image_bytes,
        )
        self.telegram.set_message_handler(self._handle_telegram_message)
        self.telegram.set_new_session_handler(self._handle_new_session_transition)
        self.idle_heartbeat = IdleHeartbeatRunner(
            workspace_dir=settings.workspace_dir,
            followups=self.followups,
            idle_state=self.idle_state,
            send_message=lambda chat_id, message: self.telegram.send(chat_id, message),
            event_bus=self.loop_events,
            background_policy=self.loop_manager.background_policy,
            begin_proactive_action=self.loop_manager.begin_proactive_action,
            finish_proactive_action=self.loop_manager.finish_proactive_action,
            provider_getter=self.providers.get,
            artifact_store=self.cognitive_artifacts,
            enabled=settings.idle_mode_enabled and settings.idle_heartbeat_enabled,
            proactive_enabled=settings.proactive_surfacing_enabled,
            interval_seconds=settings.idle_heartbeat_interval_seconds,
            active_window_seconds=settings.idle_active_window_seconds,
            proactive_cooldown_seconds=settings.proactive_followup_cooldown_seconds,
        )
        self.reflection_loop = ReflectionLoop(
            workspace_dir=settings.workspace_dir,
            sessions_dir=settings.workspace_dir / "sessions",
            provider_getter=self.providers.get,
            shared_mind_state=self.shared_mind_state,
            event_bus=self.loop_events,
            policy_gate=self.loop_manager.background_policy,
            artifact_store=self.cognitive_artifacts,
        )
        self.drive_loop = DriveLoop(
            workspace_dir=settings.workspace_dir,
            provider_getter=self.providers.get,
            shared_mind_state=self.shared_mind_state,
            followups=self.followups,
            artifact_store=self.cognitive_artifacts,
            event_bus=self.loop_events,
            policy_gate=self.loop_manager.background_policy,
        )
        self.conversation_loop = ConversationLoop(event_bus=self.loop_events)
        self.loop_manager.register(self.conversation_loop)
        self.loop_manager.register(
            ManagedRunnerLoop(
                name="continuity_worker",
                priority=LoopPriority.LOW,
                visibility=LoopVisibility.BACKGROUND,
                start_fn=self._noop_start,
                stop_fn=self.session_continuity.shutdown,
                status_fn=self.session_continuity.status,
            )
        )
        self.loop_manager.register(
            ManagedRunnerLoop(
                name="maintenance_loop",
                priority=LoopPriority.LOW,
                visibility=LoopVisibility.BACKGROUND,
                start_fn=self.memory_maintenance.start,
                stop_fn=self.memory_maintenance.stop,
                status_fn=self.memory_maintenance.status,
            )
        )
        self.loop_manager.register(self.reflection_loop)
        self.loop_manager.register(self.drive_loop)
        self.loop_manager.register(
            ManagedRunnerLoop(
                name="heartbeat_loop",
                priority=LoopPriority.NORMAL,
                visibility=LoopVisibility.BACKGROUND,
                start_fn=self.idle_heartbeat.start,
                stop_fn=self.idle_heartbeat.stop,
                status_fn=self.idle_heartbeat.status,
            )
        )

        self.app = FastAPI(title="Drost Gateway", version="0.1.0")
        self.app.state.gateway = self
        self._mount_routes()
        self._mount_lifecycle()

    def _sync_shared_mind_state(self) -> None:
        try:
            self.shared_mind_state.set_loop_states(self.loop_manager.status().get("loops", {}))
        except Exception:
            logger.debug("Failed to sync loop state into shared mind state", exc_info=True)

    async def _noop_start(self) -> None:
        return None

    def _runtime_status_payload(self) -> dict[str, Any]:
        loops = self.loop_manager.status()
        mind = self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
        events = self.loop_events.status()
        cognition = self._cognition_status_payload(mind=mind, loops=loops)
        quality = self._quality_status_payload(mind=mind, loops=loops)
        return {
            **loops,
            "mode": str(mind.get("mode") or "active"),
            "focus": dict(mind.get("focus") or {}),
            "activity": dict(mind.get("activity") or {}),
            "health": dict(mind.get("health") or {}),
            "reflection": dict(mind.get("reflection") or {}),
            "agenda": dict(mind.get("agenda") or {}),
            "attention": dict(mind.get("attention") or {}),
            "heartbeat": dict(mind.get("heartbeat") or {}),
            "cognition": cognition,
            "quality": quality,
            "event_counts": dict(events.get("event_counts") or {}),
            "recent_events": list(events.get("recent_events") or []),
            "subscriber_count": int(events.get("subscriber_count") or 0),
            "subscriptions": dict(events.get("subscriptions") or {}),
            "total_events_emitted": int(events.get("total_emitted") or 0),
        }

    def _cognition_status_payload(
        self,
        *,
        mind: dict[str, Any] | None = None,
        loops: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        mind_state = (
            dict(mind)
            if isinstance(mind, dict)
            else self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
        )
        loop_status = dict(loops) if isinstance(loops, dict) else self.loop_manager.status()
        recent_reflections: list[dict[str, Any]] = []
        active_agenda_items: list[dict[str, Any]] = []
        heartbeat_decisions: list[dict[str, Any]] = []

        artifacts = getattr(self, "cognitive_artifacts", None)
        if artifacts is not None:
            try:
                recent_reflections = list(artifacts.list_reflections(limit=5))
            except Exception:
                recent_reflections = []
            try:
                drive_state = artifacts.load_drive_state()
                active_agenda_items = [
                    dict(item)
                    for item in list(drive_state.get("active_items") or [])[:5]
                    if isinstance(item, dict)
                ]
            except Exception:
                active_agenda_items = []

        heartbeat_runner = getattr(self, "idle_heartbeat", None)
        audit_path = getattr(heartbeat_runner, "audit_path", None)
        if audit_path is not None:
            heartbeat_decisions = self._read_recent_heartbeat_decisions(audit_path, limit=5)

        loop_map = loop_status.get("loops") if isinstance(loop_status.get("loops"), dict) else {}
        cognitive_loops = {
            name: dict(loop_map.get(name) or {})
            for name in ("reflection_loop", "drive_loop", "heartbeat_loop")
            if dict(loop_map.get(name) or {})
        }

        return {
            "summary": {
                "reflection": dict(mind_state.get("reflection") or {}),
                "agenda": dict(mind_state.get("agenda") or {}),
                "attention": dict(mind_state.get("attention") or {}),
                "initiatives": dict(mind_state.get("initiatives") or {}),
                "heartbeat": dict(mind_state.get("heartbeat") or {}),
            },
            "recent_reflections": recent_reflections,
            "active_agenda_items": active_agenda_items,
            "recent_heartbeat_decisions": heartbeat_decisions,
            "loops": cognitive_loops,
        }

    def _quality_status_payload(
        self,
        *,
        mind: dict[str, Any] | None = None,
        loops: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        mind_state = (
            dict(mind)
            if isinstance(mind, dict)
            else self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
        )
        loop_status = dict(loops) if isinstance(loops, dict) else self.loop_manager.status()
        loop_map = loop_status.get("loops") if isinstance(loop_status.get("loops"), dict) else {}
        reflection_status = dict(loop_map.get("reflection_loop") or {})
        heartbeat_status = dict(mind_state.get("heartbeat") or {})
        return self.quality_gates.status(
            reflection_status=reflection_status,
            heartbeat_status=heartbeat_status,
        )

    @staticmethod
    def _read_recent_jsonl_dicts(path: Any, *, limit: int) -> list[dict[str, Any]]:
        try:
            from pathlib import Path

            rows = Path(path).expanduser().read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
        out: list[dict[str, Any]] = []
        for line in rows[-max(1, int(limit)) :]:
            cleaned = str(line or "").strip()
            if not cleaned:
                continue
            try:
                payload = json.loads(cleaned)
            except Exception:
                continue
            if isinstance(payload, dict):
                out.append(payload)
        return out

    @classmethod
    def _read_recent_heartbeat_decisions(cls, path: Any, *, limit: int) -> list[dict[str, Any]]:
        rows = cls._read_recent_jsonl_dicts(path, limit=max(10, int(limit) * 10))
        meaningful: list[dict[str, Any]] = []
        for payload in reversed(rows):
            if cls._is_meaningful_heartbeat_payload(payload):
                meaningful.append(payload)
            if len(meaningful) >= max(1, int(limit)):
                break
        meaningful.reverse()
        return meaningful

    @staticmethod
    def _is_meaningful_heartbeat_payload(payload: dict[str, Any]) -> bool:
        if not isinstance(payload, dict):
            return False
        importance = str(payload.get("importance") or "").strip().lower()
        if importance == "low":
            return False
        decision = str(payload.get("decision") or "").strip().lower()
        reason = str(
            payload.get("suppression_reason") or payload.get("why") or payload.get("reason") or ""
        ).strip().lower()
        return not (decision == "noop" and reason in _TRIVIAL_HEARTBEAT_REASONS)

    async def _handle_telegram_message(self, context: dict[str, Any]) -> str | None:
        text = str(context.get("text") or "").strip()
        media = context.get("media") if isinstance(context.get("media"), list) else None
        if not text and not media:
            return None

        chat_id = int(context.get("chat_id") or 0)
        settings = getattr(self, "settings", None)
        idle_mode_enabled = bool(getattr(settings, "idle_mode_enabled", False))
        idle_state = getattr(self, "idle_state", None)
        loop_events = getattr(self, "loop_events", None)
        session_key_before = ""
        if chat_id > 0 and hasattr(self, "store"):
            try:
                session_key_before = str(self.store.current_session_key(chat_id) or "").strip()
            except Exception:
                session_key_before = ""
        if chat_id > 0 and idle_mode_enabled and idle_state is not None:
            idle_state.mark_user_message(chat_id=chat_id, session_key=session_key_before or None)
        if chat_id > 0 and loop_events is not None:
            loop_events.emit(
                "user_message_received",
                scope={
                    "chat_id": int(chat_id),
                    "session_key": session_key_before,
                },
                payload={
                    "channel": "telegram",
                    "has_media": bool(media),
                    "text_chars": len(text),
                },
            )
        session_id = context.get("session_id")
        status_callback = context.get("status_callback")
        answer_stream_callback = context.get("answer_stream_callback")
        reply = await self.agent.respond(
            chat_id=chat_id,
            text=text,
            session_id=(str(session_id).strip() if session_id is not None else None),
            media=media,
            status_callback=status_callback if callable(status_callback) else None,
            answer_stream_callback=answer_stream_callback if callable(answer_stream_callback) else None,
        )
        session_key_after = session_key_before
        if chat_id > 0 and hasattr(self, "store"):
            try:
                session_key_after = str(self.store.current_session_key(chat_id) or "").strip()
            except Exception:
                session_key_after = session_key_before
        if chat_id > 0 and idle_mode_enabled and idle_state is not None:
            idle_state.mark_assistant_message(chat_id=chat_id, session_key=session_key_after or None)
        return reply

    async def _handle_new_session_transition(self, payload: dict[str, Any]) -> dict[str, Any]:
        from_session_key = str(payload.get("from_session_key") or "").strip()
        to_session_key = str(payload.get("to_session_key") or "").strip()
        from_session_id = str(payload.get("from_session_id") or "").strip() or "legacy-main"
        to_session_id = str(payload.get("to_session_id") or "").strip() or "legacy-main"
        chat_id = int(payload.get("chat_id") or 0)
        if not from_session_key or not to_session_key:
            return {"queued": False, "message": "Continuity skipped (invalid session transition)."}
        result = await self.session_continuity.schedule(
            ContinuityJobRequest(
                chat_id=chat_id,
                from_session_id=from_session_id,
                from_session_key=from_session_key,
                to_session_id=to_session_id,
                to_session_key=to_session_key,
            )
        )
        loop_events = getattr(self, "loop_events", None)
        if loop_events is not None:
            loop_events.emit(
                "session_switched",
                scope={
                    "chat_id": int(chat_id),
                    "session_key": to_session_key,
                },
                payload={
                    "from_session_key": from_session_key,
                    "to_session_key": to_session_key,
                    "queued": bool(result.get("queued")),
                },
            )
        return result

    def _mount_lifecycle(self) -> None:
        @self.app.on_event("startup")
        async def startup() -> None:
            if self.settings.memory_enabled:
                await self.agent.sync_memory_index()
            await self.telegram.start(self.app)
            await self.loop_manager.start()
            self._sync_shared_mind_state()
            logger.info(
                "Drost gateway started (provider=%s db=%s loops=%s)",
                self.agent.active_provider,
                self.settings.sqlite_path,
                ",".join(self.loop_manager.names()),
            )

        @self.app.on_event("shutdown")
        async def shutdown() -> None:
            try:
                await self.loop_manager.stop()
            except Exception:
                logger.warning("Loop manager shutdown reported errors", exc_info=True)
            self._sync_shared_mind_state()
            await self.telegram.stop()
            await self.agent.close()
            self.store.close()
            logger.info("Drost gateway stopped")

    def _mount_routes(self) -> None:
        @self.app.get("/health")
        async def health() -> dict[str, str]:
            return {"status": "ok"}

        @self.app.get("/v1/providers")
        async def providers() -> dict[str, Any]:
            return {
                "active": self.agent.active_provider,
                "available": self.agent.provider_names(),
            }

        @self.app.post("/v1/providers/select")
        async def select_provider(payload: ProviderSelectRequest) -> dict[str, Any]:
            try:
                self.agent.set_provider(payload.provider)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            return {
                "active": self.agent.active_provider,
                "available": self.agent.provider_names(),
            }

        @self.app.get("/v1/sessions/{chat_id}")
        async def list_sessions(chat_id: int) -> dict[str, Any]:
            rows = self.store.list_chat_sessions(chat_id)
            active = self.store.get_active_session_id(chat_id) or "legacy-main"
            return {"chat_id": chat_id, "active_session_id": active, "sessions": rows}

        @self.app.get("/v1/memory/status")
        async def memory_status() -> dict[str, Any]:
            return self.store.memory_status()

        @self.app.get("/v1/memory/maintenance/status")
        async def memory_maintenance_status() -> dict[str, Any]:
            return self.memory_maintenance.status()

        @self.app.get("/v1/loops/status")
        async def loops_status() -> dict[str, Any]:
            self._sync_shared_mind_state()
            return self._runtime_status_payload()

        @self.app.get("/v1/events/status")
        async def events_status() -> dict[str, Any]:
            return self.loop_events.status()

        @self.app.get("/v1/followups")
        async def followups(chat_id: int | None = None) -> dict[str, Any]:
            return {
                "count": len(self.followups.list_followups(chat_id=chat_id)),
                "items": self.followups.list_followups(chat_id=chat_id),
            }

        @self.app.get("/v1/workers/status")
        async def workers_status() -> dict[str, Any]:
            return self.workers.status()

        @self.app.get("/v1/workers/jobs/{job_id}")
        async def worker_job_detail(job_id: str) -> dict[str, Any]:
            payload = self.workers.get_job(job_id, refresh=True)
            if payload is None:
                raise HTTPException(status_code=404, detail=f"worker job not found: {job_id}")
            return payload

        @self.app.post("/v1/workers/launch")
        async def workers_launch(payload: WorkerLaunchRequest) -> dict[str, Any]:
            try:
                job = self.workers.launch_job(
                    worker_kind=str(payload.worker_kind).strip().lower(),
                    prompt=str(payload.prompt or ""),
                    repo_root=payload.repo_root,
                    requested_mode=str(payload.requested_mode or "implement").strip().lower(),
                    write_scope=str(payload.write_scope or "repo").strip(),
                    requested_outputs=list(payload.requested_outputs or []),
                    requested_tests=list(payload.requested_tests or []),
                    requested_by=str(payload.requested_by or "operator").strip() or "operator",
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            return {"ok": True, **job}

        @self.app.post("/v1/workers/jobs/{job_id}/review")
        async def worker_job_review(job_id: str, payload: WorkerReviewRequest) -> dict[str, Any]:
            try:
                job = self.workers.review_job(
                    job_id,
                    decision=payload.decision,
                    reviewer=payload.reviewer,
                    notes=payload.notes,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"worker job not found: {job_id}") from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            return {"ok": True, **job}

        @self.app.post("/v1/workers/jobs/{job_id}/retry")
        async def worker_job_retry(job_id: str, payload: WorkerRetryRequest) -> dict[str, Any]:
            try:
                job = self.workers.retry_job(
                    job_id,
                    requested_by=payload.requested_by,
                    reason=payload.reason,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"worker job not found: {job_id}") from exc
            return {"ok": True, **job}

        @self.app.post("/v1/workers/jobs/{job_id}/stop")
        async def worker_job_stop(job_id: str, payload: WorkerStopRequest) -> dict[str, Any]:
            try:
                job = self.workers.stop_job(job_id, reason=payload.reason)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"worker job not found: {job_id}") from exc
            return {"ok": True, **job}

        @self.app.get("/v1/idle/status")
        async def idle_status() -> dict[str, Any]:
            return self.idle_state.status(active_window_seconds=self.settings.idle_active_window_seconds)

        @self.app.get("/v1/mind/status")
        async def mind_status() -> dict[str, Any]:
            self._sync_shared_mind_state()
            loops = self.loop_manager.status()
            mind = self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
            return {
                **mind,
                "cognition": self._cognition_status_payload(mind=mind, loops=loops),
                "quality": self._quality_status_payload(mind=mind, loops=loops),
            }

        @self.app.get("/v1/cognition/status")
        async def cognition_status() -> dict[str, Any]:
            self._sync_shared_mind_state()
            loops = self.loop_manager.status()
            mind = self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
            return {
                **self._cognition_status_payload(mind=mind, loops=loops),
                "quality": self._quality_status_payload(mind=mind, loops=loops),
            }

        @self.app.get("/v1/quality/status")
        async def quality_status() -> dict[str, Any]:
            self._sync_shared_mind_state()
            loops = self.loop_manager.status()
            mind = self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
            return self._quality_status_payload(mind=mind, loops=loops)

        @self.app.post("/v1/quality/promotion-review")
        async def quality_promotion_review(payload: PromotionReviewRequest) -> dict[str, Any]:
            self._sync_shared_mind_state()
            review = self.quality_gates.record_promotion_review(
                approved=payload.approved,
                note=payload.note,
                sample_size=payload.sample_size,
            )
            loops = self.loop_manager.status()
            mind = self.shared_mind_state.status(active_window_seconds=self.settings.idle_active_window_seconds)
            return {
                "ok": True,
                "review": review,
                "quality": self._quality_status_payload(mind=mind, loops=loops),
            }

        @self.app.post("/v1/canary/deploy")
        async def deploy_canary() -> dict[str, Any]:
            result = await self.agent.run_deploy_canary()
            if not bool(result.get("ok")):
                raise HTTPException(status_code=503, detail=result)
            return result

        @self.app.get("/v1/heartbeat/status")
        async def heartbeat_status() -> dict[str, Any]:
            return self.idle_heartbeat.status()

        @self.app.post("/v1/heartbeat/run-once")
        async def heartbeat_run_once() -> dict[str, Any]:
            return {"ok": True, "result": await self.idle_heartbeat.run_once(reason="manual")}

        @self.app.get("/v1/memory/continuity/status")
        async def memory_continuity_status() -> dict[str, Any]:
            return self.session_continuity.status()

        @self.app.post("/v1/memory/maintenance/run-once")
        async def memory_maintenance_run_once() -> dict[str, Any]:
            result = await self.memory_maintenance.run_once(reason="manual")
            return {"ok": True, "result": result}

        @self.app.get("/v1/memory/search")
        async def memory_search(query: str, limit: int = 6) -> dict[str, Any]:
            trimmed = (query or "").strip()
            if not trimmed:
                raise HTTPException(status_code=400, detail="query is required")
            await self.agent.sync_memory_index()
            embedding = await self.embeddings.embed_query(trimmed)
            rows = self.store.search_memory(
                query_text=trimmed,
                query_embedding=embedding,
                limit=max(1, min(int(limit), 25)),
            )
            return {
                "query": trimmed,
                "results": rows,
                "count": len(rows),
            }

        @self.app.get("/v1/runs/last")
        async def runs_last() -> dict[str, Any]:
            run = self.agent.last_run_metadata()
            return {"run": run}

        @self.app.post("/v1/chat")
        async def chat(payload: ChatRequest) -> dict[str, Any]:
            chat_id = int(payload.chat_id)
            session_key_before = ""
            loop_events = getattr(self, "loop_events", None)
            if chat_id > 0:
                try:
                    session_key_before = str(self.store.current_session_key(chat_id) or "").strip()
                except Exception:
                    session_key_before = ""
                if self.settings.idle_mode_enabled:
                    self.idle_state.mark_user_message(chat_id=chat_id, session_key=session_key_before or None)
                if loop_events is not None:
                    loop_events.emit(
                        "user_message_received",
                        scope={
                            "chat_id": int(chat_id),
                            "session_key": session_key_before,
                        },
                        payload={
                            "channel": "api",
                            "has_media": bool(payload.media),
                            "text_chars": len(str(payload.text or "")),
                        },
                    )
            response = await self.agent.respond(
                chat_id=chat_id,
                text=str(payload.text or ""),
                media=payload.media,
                session_id=payload.session_id,
            )
            if chat_id > 0 and self.settings.idle_mode_enabled:
                try:
                    session_key_after = str(self.store.current_session_key(chat_id) or "").strip()
                except Exception:
                    session_key_after = session_key_before
                self.idle_state.mark_assistant_message(chat_id=chat_id, session_key=session_key_after or None)
            return {"reply": response, "provider": self.agent.active_provider}



def create_app(settings: Settings) -> FastAPI:
    gateway = Gateway(settings)
    return gateway.app
