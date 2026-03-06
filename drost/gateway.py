from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from drost.agent import AgentRuntime
from drost.channels import TelegramChannel
from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.providers import build_provider_registry
from drost.storage import SQLiteStore

logger = logging.getLogger(__name__)


class ProviderSelectRequest(BaseModel):
    provider: str


class ChatRequest(BaseModel):
    chat_id: int
    text: str = ""
    media: list[dict[str, Any]] | None = None
    session_id: str | None = None


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
        self.agent = AgentRuntime(
            settings=settings,
            providers=self.providers,
            store=self.store,
            embeddings=self.embeddings,
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

        self.app = FastAPI(title="Drost Gateway", version="0.1.0")
        self._mount_routes()
        self._mount_lifecycle()

    async def _handle_telegram_message(self, context: dict[str, Any]) -> str | None:
        text = str(context.get("text") or "").strip()
        media = context.get("media") if isinstance(context.get("media"), list) else None
        if not text and not media:
            return None

        chat_id = int(context.get("chat_id") or 0)
        session_id = context.get("session_id")
        status_callback = context.get("status_callback")
        return await self.agent.respond(
            chat_id=chat_id,
            text=text,
            session_id=(str(session_id).strip() if session_id is not None else None),
            media=media,
            status_callback=status_callback if callable(status_callback) else None,
        )

    def _mount_lifecycle(self) -> None:
        @self.app.on_event("startup")
        async def startup() -> None:
            await self.telegram.start(self.app)
            logger.info(
                "Drost gateway started (provider=%s db=%s)",
                self.agent.active_provider,
                self.settings.sqlite_path,
            )

        @self.app.on_event("shutdown")
        async def shutdown() -> None:
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

        @self.app.get("/v1/memory/search")
        async def memory_search(query: str, limit: int = 6) -> dict[str, Any]:
            trimmed = (query or "").strip()
            if not trimmed:
                raise HTTPException(status_code=400, detail="query is required")
            embedding = await self.embeddings.embed_one(trimmed)
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
            response = await self.agent.respond(
                chat_id=int(payload.chat_id),
                text=str(payload.text or ""),
                media=payload.media,
                session_id=payload.session_id,
            )
            return {"reply": response, "provider": self.agent.active_provider}



def create_app(settings: Settings) -> FastAPI:
    gateway = Gateway(settings)
    return gateway.app
