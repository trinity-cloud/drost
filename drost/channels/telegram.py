from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import mimetypes
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ChatType
from aiogram.filters import Command
from aiogram.types import Message as TgMessage
from aiogram.types import Update
from fastapi import FastAPI, Request, Response

from drost.channels.base import BaseChannel
from drost.channels.telegram_renderer import markdown_to_telegram_html, split_for_telegram
from drost.storage import SQLiteStore, session_key_for_telegram_chat

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class PendingMediaGroup:
    anchor_message: TgMessage
    caption: str = ""
    attachment_hints: list[str] = field(default_factory=list)
    media: list[dict[str, Any]] = field(default_factory=list)
    flush_task: asyncio.Task[None] | None = None


class TelegramChannel(BaseChannel):
    MEDIA_GROUP_DEBOUNCE_SECONDS = 0.8

    def __init__(
        self,
        *,
        token: str,
        store: SQLiteStore,
        webhook_url: str | None,
        webhook_path: str,
        webhook_secret: str | None,
        allowed_users: list[int] | None = None,
        attachments_dir: Path | None = None,
        max_inline_image_bytes: int = 5 * 1024 * 1024,
    ) -> None:
        self.token = token
        self.store = store
        self.webhook_url = (webhook_url or "").strip() or None
        self.webhook_path = (webhook_path or "/webhook/telegram").strip() or "/webhook/telegram"
        self.webhook_secret = (webhook_secret or "").strip() or None
        self.allowed_users = set(allowed_users or [])
        self.attachments_dir = Path(attachments_dir).expanduser() if attachments_dir is not None else None
        self.max_inline_image_bytes = max(256_000, int(max_inline_image_bytes))

        self.bot = Bot(token=token)
        self.dp = Dispatcher()
        self.router = Router()
        self.dp.include_router(self.router)

        self._message_handler: Callable[[dict[str, Any]], Awaitable[str | None]] | None = None
        self._new_session_handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]] | None = None
        self._polling_task: asyncio.Task[None] | None = None
        self._polling_active = False
        self._pending_media_groups: dict[tuple[int, str], PendingMediaGroup] = {}
        self._media_groups_lock = asyncio.Lock()

        self._setup_handlers()

    @staticmethod
    def _parse_command(text: str) -> tuple[str, str] | None:
        raw = (text or "").strip()
        if not raw.startswith("/"):
            return None
        first, sep, rest = raw.partition(" ")
        command = first[1:].strip().lower()
        if "@" in command:
            command = command.split("@", 1)[0].strip()
        if not command:
            return None
        return command, rest.strip() if sep else ""

    def _is_authorized(self, message: TgMessage) -> bool:
        if message.from_user and message.from_user.is_bot:
            return False
        if message.chat and message.chat.type != ChatType.PRIVATE:
            return False
        if self.allowed_users:
            uid = int(message.from_user.id if message.from_user else 0)
            if uid not in self.allowed_users:
                logger.warning("Unauthorized Telegram user %s attempted access", uid)
                return False
        return True

    def set_new_session_handler(
        self,
        handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]] | None,
    ) -> None:
        self._new_session_handler = handler

    async def _send_long(self, chat_id: int, text: str, reply_to: int | None = None) -> None:
        body = str(text or "").strip()
        if not body:
            return

        chunks = split_for_telegram(body, max_chars=4000)
        for idx, chunk in enumerate(chunks):
            await self._send_rendered_message(
                chat_id=chat_id,
                text=chunk,
                reply_to=reply_to if idx == 0 else None,
            )

    async def _edit_message(self, chat_id: int, message_id: int, text: str) -> None:
        body = str(text or "").strip()
        if not body:
            body = "Working..."
        try:
            await self.bot.edit_message_text(
                body[:4000],
                chat_id=chat_id,
                message_id=message_id,
                parse_mode=None,
            )
        except Exception:
            # Ignore edit races / "message is not modified" errors.
            logger.debug("Telegram message edit failed", exc_info=True)

    async def _send_rendered_message(
        self,
        *,
        chat_id: int,
        text: str,
        reply_to: int | None = None,
    ) -> None:
        body = str(text or "")
        if not body:
            return
        rendered = markdown_to_telegram_html(body)
        try:
            await self.bot.send_message(
                chat_id,
                rendered,
                parse_mode="HTML",
                reply_to_message_id=reply_to,
            )
            return
        except Exception:
            logger.debug("Telegram HTML send rejected; falling back to plain text", exc_info=True)
        await self.bot.send_message(
            chat_id,
            body,
            parse_mode=None,
            reply_to_message_id=reply_to,
        )

    async def _edit_rendered_message(self, *, chat_id: int, message_id: int, text: str) -> None:
        body = str(text or "").strip()
        if not body:
            body = "I don't have a response for that yet."
        rendered = markdown_to_telegram_html(body)
        try:
            await self.bot.edit_message_text(
                rendered,
                chat_id=chat_id,
                message_id=message_id,
                parse_mode="HTML",
            )
            return
        except Exception:
            logger.debug("Telegram HTML edit rejected; falling back to plain text", exc_info=True)
        await self._edit_message(chat_id, message_id, body)

    async def _finalize_working_message(
        self,
        *,
        chat_id: int,
        message_id: int,
        text: str,
        reply_to: int | None = None,
    ) -> None:
        body = str(text or "").strip()
        if not body:
            body = "I don't have a response for that yet."

        chunks = split_for_telegram(body, max_chars=4000)
        if not chunks:
            await self._edit_message(chat_id, message_id, "I don't have a response for that yet.")
            return

        await self._edit_rendered_message(chat_id=chat_id, message_id=message_id, text=chunks[0])
        for idx, chunk in enumerate(chunks[1:], start=1):
            await self._send_rendered_message(
                chat_id=chat_id,
                text=chunk,
                reply_to=reply_to if idx == 1 else None,
            )

    async def _handle_start(self, message: TgMessage) -> None:
        await message.answer(
            "Drost is online. Send a message to chat.\n\n"
            "Commands:\n"
            "/help\n"
            "/new [title]\n"
            "/sessions\n"
            "/use <id|index>\n"
            "/current\n"
            "/reset"
        )

    async def _handle_help(self, message: TgMessage) -> None:
        await message.answer(
            "Commands:\n"
            "/start - status\n"
            "/help - command list\n"
            "/new [title] - create and switch session\n"
            "/sessions - list sessions\n"
            "/use <id|index> - switch session\n"
            "/current - show active session\n"
            "/reset - clear active session transcript"
        )

    async def _handle_commands(self, message: TgMessage) -> None:
        await self._handle_help(message)

    def _current_session_id(self, chat_id: int) -> str:
        return self.store.get_active_session_id(chat_id) or "legacy-main"

    async def _handle_new_session(self, message: TgMessage, args: str) -> None:
        chat_id = int(message.chat.id)
        title = (args or "").strip()
        from_session_id = self._current_session_id(chat_id)
        from_session_key = session_key_for_telegram_chat(
            chat_id,
            None if from_session_id == "legacy-main" else from_session_id,
        )
        sid = self.store.create_session(chat_id, title=title)
        to_session_key = session_key_for_telegram_chat(chat_id, None if sid == "legacy-main" else sid)
        continuity_line = ""
        if self._new_session_handler is not None:
            try:
                continuity_result = await self._new_session_handler(
                    {
                        "chat_id": chat_id,
                        "from_session_id": from_session_id,
                        "from_session_key": from_session_key,
                        "to_session_id": sid,
                        "to_session_key": to_session_key,
                    }
                )
                if isinstance(continuity_result, dict):
                    continuity_line = str(continuity_result.get("message") or "").strip()
            except Exception:
                logger.warning("Session continuity callback failed", exc_info=True)
        summary = f"New session active: {sid}"
        if continuity_line:
            summary = f"{summary}\n{continuity_line}"
        await message.answer(summary, parse_mode=None)

    async def _handle_list_sessions(self, message: TgMessage) -> None:
        chat_id = int(message.chat.id)
        rows = self.store.list_chat_sessions(chat_id)
        active = self._current_session_id(chat_id)

        lines = ["Sessions:"]
        for idx, row in enumerate(rows, start=1):
            sid = str(row.get("session_id") or "legacy-main")
            title = str(row.get("title") or "").strip()
            label = title if title else sid
            marker = "-> " if sid == active else "   "
            lines.append(
                f"{marker}{idx}. {label} | id={sid} | msgs={int(row.get('message_count') or 0)}"
            )

        lines.append("Use /use <index|session_id> to switch.")
        await message.answer("\n".join(lines), parse_mode=None)

    async def _handle_use_session(self, message: TgMessage, args: str) -> None:
        chat_id = int(message.chat.id)
        token = (args or "").strip()
        if not token:
            await message.answer("Usage: /use <index|session_id>", parse_mode=None)
            return

        rows = self.store.list_chat_sessions(chat_id)
        selected: dict[str, Any] | None = None
        if token.isdigit():
            idx = int(token)
            if 1 <= idx <= len(rows):
                selected = rows[idx - 1]
        else:
            lookup = token.lower()
            if lookup in {"main", "legacy", "legacy-main"}:
                lookup = "legacy-main"
            for row in rows:
                sid = str(row.get("session_id") or "")
                if sid == lookup:
                    selected = row
                    break

        if selected is None:
            await message.answer("Session not found. Use /sessions to list available sessions.", parse_mode=None)
            return

        sid = str(selected.get("session_id") or "legacy-main")
        self.store.set_active_session_id(chat_id, None if sid == "legacy-main" else sid)
        await message.answer(f"Active session switched to {sid}", parse_mode=None)

    async def _handle_current(self, message: TgMessage) -> None:
        chat_id = int(message.chat.id)
        sid = self._current_session_id(chat_id)
        session_key = session_key_for_telegram_chat(chat_id, None if sid == "legacy-main" else sid)
        count = self.store.message_count(session_key)
        await message.answer(
            f"Current session: {sid}\n"
            f"Session key: {session_key}\n"
            f"Messages: {count}",
            parse_mode=None,
        )

    async def _handle_reset(self, message: TgMessage) -> None:
        chat_id = int(message.chat.id)
        sid = self._current_session_id(chat_id)
        session_key = session_key_for_telegram_chat(chat_id, None if sid == "legacy-main" else sid)
        deleted = self.store.reset_session(session_key)
        await message.answer(f"Session reset complete. Deleted {deleted} message(s).", parse_mode=None)

    async def _handle_text(self, message: TgMessage) -> None:
        if not self._is_authorized(message):
            return
        if not message.text:
            return

        await self._route_context(
            message,
            text=message.text,
            media=None,
        )

    @staticmethod
    def _compose_media_text(*, caption: str, attachment_hints: list[str]) -> str:
        cleaned_caption = str(caption or "").strip()
        hints = list(dict.fromkeys([str(h or "").strip() for h in attachment_hints if str(h or "").strip()]))
        if cleaned_caption and hints:
            return f"{cleaned_caption}\n\n" + "\n".join(hints)
        if cleaned_caption:
            return cleaned_caption
        if hints:
            return "<media:image>\n\n" + "\n".join(hints)
        return "<media:image>\n\nI received an image. What should I do with it?"

    def _attachment_path(self, *, message_id: int, unique_id: str, suffix: str) -> Path | None:
        if self.attachments_dir is None:
            return None
        dest_dir = self.attachments_dir / "telegram"
        dest_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{int(time.time())}-{message_id}-{unique_id}{suffix}"
        return dest_dir / filename

    async def _build_photo_payload(self, message: TgMessage) -> tuple[str, str, list[dict[str, Any]]]:
        caption = str(message.caption or "").strip()
        if not message.photo:
            return caption, "", []
        photo = message.photo[-1]
        for candidate in reversed(message.photo):
            size = getattr(candidate, "file_size", None)
            if isinstance(size, int) and size <= self.max_inline_image_bytes:
                photo = candidate
                break
        file = await self.bot.get_file(photo.file_id)
        suffix = Path(file.file_path or "").suffix or ".jpg"
        dest = self._attachment_path(
            message_id=int(message.message_id),
            unique_id=str(getattr(photo, "file_unique_id", "") or photo.file_id),
            suffix=suffix,
        )
        if dest is None or not file.file_path:
            return caption, "", []
        await self.bot.download_file(file.file_path, destination=dest)
        data = dest.read_bytes()
        mime_type, _ = mimetypes.guess_type(str(dest))
        mime_type = mime_type if mime_type and mime_type.startswith("image/") else "image/jpeg"
        attachment_hint = f"[Image attached: {dest}]"
        if len(data) > self.max_inline_image_bytes:
            return caption, attachment_hint, []
        return caption, attachment_hint, [
            {
                "type": "image",
                "mime_type": mime_type,
                "data": base64.b64encode(data).decode("utf-8"),
                "path": str(dest),
            }
        ]

    async def _build_document_payload(self, message: TgMessage) -> tuple[str, str, list[dict[str, Any]]]:
        caption = str(message.caption or "").strip()
        doc = message.document
        if doc is None:
            return caption, "", []
        mime_type = str(getattr(doc, "mime_type", "") or "").strip()
        if not mime_type and getattr(doc, "file_name", None):
            guessed, _ = mimetypes.guess_type(str(doc.file_name))
            if guessed:
                mime_type = guessed
        if not mime_type.startswith("image/"):
            return "", "", []
        file = await self.bot.get_file(doc.file_id)
        suffix = Path(str(getattr(doc, "file_name", "") or file.file_path or "")).suffix
        if not suffix:
            ext = mime_type.split("/", 1)[1].strip().lower()
            suffix = f".{ext}" if ext else ".bin"
        dest = self._attachment_path(
            message_id=int(message.message_id),
            unique_id=str(getattr(doc, "file_unique_id", "") or doc.file_id),
            suffix=suffix,
        )
        if dest is None or not file.file_path:
            return caption, "", []
        await self.bot.download_file(file.file_path, destination=dest)
        data = dest.read_bytes()
        attachment_hint = f"[Image attached: {dest}]"
        if len(data) > self.max_inline_image_bytes:
            return caption, attachment_hint, []
        return caption, attachment_hint, [
            {
                "type": "image",
                "mime_type": mime_type or "image/jpeg",
                "data": base64.b64encode(data).decode("utf-8"),
                "path": str(dest),
            }
        ]

    async def _enqueue_media_group_message(
        self,
        message: TgMessage,
        *,
        caption: str,
        attachment_hint: str,
        media: list[dict[str, Any]],
    ) -> bool:
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if not media_group_id:
            return False
        key = (int(message.chat.id), media_group_id)
        async with self._media_groups_lock:
            pending = self._pending_media_groups.get(key)
            if pending is None:
                pending = PendingMediaGroup(
                    anchor_message=message,
                    caption=caption,
                    attachment_hints=[attachment_hint] if attachment_hint else [],
                    media=list(media),
                )
                self._pending_media_groups[key] = pending
            else:
                if caption and not pending.caption:
                    pending.caption = caption
                if attachment_hint:
                    pending.attachment_hints.append(attachment_hint)
                if media:
                    pending.media.extend(media)
                if pending.flush_task is not None:
                    pending.flush_task.cancel()
            pending.flush_task = asyncio.create_task(self._flush_media_group_after_delay(key))
        return True

    async def _flush_media_group_after_delay(self, key: tuple[int, str]) -> None:
        try:
            if self.MEDIA_GROUP_DEBOUNCE_SECONDS > 0:
                await asyncio.sleep(self.MEDIA_GROUP_DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return

        async with self._media_groups_lock:
            pending = self._pending_media_groups.pop(key, None)
        if pending is None:
            return
        text = self._compose_media_text(
            caption=pending.caption,
            attachment_hints=pending.attachment_hints,
        )
        try:
            await self._route_context(
                pending.anchor_message,
                text=text,
                media=pending.media,
            )
        except Exception:
            logger.exception("Failed to route Telegram media group")

    async def _cancel_pending_media_groups(self) -> None:
        async with self._media_groups_lock:
            pending = list(self._pending_media_groups.values())
            self._pending_media_groups.clear()
        for entry in pending:
            if entry.flush_task is not None:
                entry.flush_task.cancel()
        for entry in pending:
            if entry.flush_task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await entry.flush_task

    async def _handle_photo(self, message: TgMessage) -> None:
        if not self._is_authorized(message):
            return
        if self._message_handler is None:
            await message.answer("No runtime message handler configured.", parse_mode=None)
            return
        try:
            caption, attachment_hint, media = await self._build_photo_payload(message)
        except Exception:
            logger.exception("Failed to process inbound Telegram photo")
            await message.answer("Failed to process image.", parse_mode=None)
            return
        queued = await self._enqueue_media_group_message(
            message,
            caption=caption,
            attachment_hint=attachment_hint,
            media=media,
        )
        if queued:
            return
        text = self._compose_media_text(
            caption=caption,
            attachment_hints=[attachment_hint] if attachment_hint else [],
        )
        await self._route_context(message, text=text, media=media)

    async def _handle_document(self, message: TgMessage) -> None:
        if not self._is_authorized(message):
            return
        if self._message_handler is None:
            await message.answer("No runtime message handler configured.", parse_mode=None)
            return
        try:
            caption, attachment_hint, media = await self._build_document_payload(message)
        except Exception:
            logger.exception("Failed to process inbound Telegram document")
            await message.answer("Failed to process file.", parse_mode=None)
            return
        if not media:
            await message.answer("Only image documents are supported right now.", parse_mode=None)
            return
        queued = await self._enqueue_media_group_message(
            message,
            caption=caption,
            attachment_hint=attachment_hint,
            media=media,
        )
        if queued:
            return
        text = self._compose_media_text(
            caption=caption,
            attachment_hints=[attachment_hint] if attachment_hint else [],
        )
        await self._route_context(message, text=text, media=media)

    async def _route_context(
        self,
        message: TgMessage,
        *,
        text: str,
        media: list[dict[str, Any]] | None,
    ) -> None:
        if not self._is_authorized(message):
            return

        parsed = self._parse_command(text) if not media else None
        if parsed:
            command, args = parsed
            if command == "new":
                await self._handle_new_session(message, args)
                return
            if command in {"sessions", "list-sessions", "list_sessions"}:
                await self._handle_list_sessions(message)
                return
            if command == "use":
                await self._handle_use_session(message, args)
                return
            if command == "current":
                await self._handle_current(message)
                return
            if command == "reset":
                await self._handle_reset(message)
                return

        if self._message_handler is None:
            await message.answer("No runtime message handler configured.", parse_mode=None)
            return

        chat_id = int(message.chat.id)
        session_id = self.store.get_active_session_id(chat_id)
        context = {
            "channel": "telegram",
            "chat_id": chat_id,
            "user_id": int(message.from_user.id if message.from_user else 0),
            "username": message.from_user.username if message.from_user else None,
            "first_name": message.from_user.first_name if message.from_user else None,
            "text": text,
            "message_id": int(message.message_id),
            "session_id": session_id,
        }
        if media:
            context["media"] = media

        working = await self.bot.send_message(
            chat_id,
            "Working...",
            parse_mode=None,
            reply_to_message_id=message.message_id,
        )
        working_id = int(working.message_id)
        status_lock = asyncio.Lock()
        status_cache = {"text": "Working..."}

        async def _status_callback(status_text: str) -> None:
            cleaned = str(status_text or "").strip()
            if not cleaned:
                return
            async with status_lock:
                if cleaned == status_cache["text"]:
                    return
                status_cache["text"] = cleaned
                await self._edit_message(chat_id, working_id, cleaned)

        context["status_callback"] = _status_callback

        try:
            reply = await self._message_handler(context)
        except Exception:
            logger.exception("Error handling inbound Telegram message")
            await self._edit_message(chat_id, working_id, "Internal error while processing message.")
            return

        if reply:
            await self._finalize_working_message(
                chat_id=chat_id,
                message_id=working_id,
                text=reply,
                reply_to=message.message_id,
            )
            return

        await self._edit_message(chat_id, working_id, "No response generated.")

    def _setup_handlers(self) -> None:
        self.router.message.register(self._handle_start, Command("start"))
        self.router.message.register(self._handle_help, Command("help"))
        self.router.message.register(self._handle_commands, Command("commands"))
        self.router.message.register(self._handle_document, F.document)
        self.router.message.register(self._handle_photo, F.photo)
        self.router.message.register(self._handle_text, F.text)

    async def _handle_webhook(self, request: Request) -> Response:
        if self.webhook_secret:
            header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
            if header_secret != self.webhook_secret:
                return Response(status_code=403)

        try:
            payload = await request.json()
            update = Update.model_validate(payload)
            await self.dp.feed_update(self.bot, update)
        except Exception:
            logger.exception("Failed to process Telegram webhook update")

        return Response(status_code=200)

    async def start(self, app: FastAPI) -> None:
        if self.webhook_url:
            await self.bot.set_webhook(
                url=f"{self.webhook_url.rstrip('/')}{self.webhook_path}",
                secret_token=self.webhook_secret,
                allowed_updates=["message", "edited_message"],
            )
            app.add_api_route(self.webhook_path, self._handle_webhook, methods=["POST"])
            logger.info("Telegram webhook enabled at %s", self.webhook_path)
            return

        if self._polling_task is None or self._polling_task.done():
            self._polling_task = asyncio.create_task(self._run_polling())
            logger.info("Telegram polling started")

    async def _run_polling(self) -> None:
        self._polling_active = True
        try:
            await self.dp.start_polling(self.bot, handle_signals=False, close_bot_session=False)
        except Exception:
            logger.exception("Telegram polling task failed")
        finally:
            self._polling_active = False

    async def stop(self) -> None:
        try:
            await self._cancel_pending_media_groups()
            if self.webhook_url:
                await self.bot.delete_webhook(drop_pending_updates=False)
            if self._polling_active:
                with contextlib.suppress(RuntimeError):
                    await self.dp.stop_polling()
            if self._polling_task is not None:
                if not self._polling_task.done():
                    self._polling_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self._polling_task
                self._polling_task = None
        finally:
            await self.bot.session.close()

    async def send(self, target: str | int, message: str, **kwargs: Any) -> Any:
        chat_id = int(target)
        parse_mode = kwargs.pop("parse_mode", "HTML")
        normalized = str(getattr(parse_mode, "value", parse_mode) or "").strip().upper()
        if normalized == "HTML":
            rendered = markdown_to_telegram_html(str(message or ""))
            try:
                return await self.bot.send_message(chat_id, rendered, parse_mode="HTML", **kwargs)
            except Exception:
                logger.debug("Telegram HTML send rejected; falling back to plain text", exc_info=True)
        return await self.bot.send_message(chat_id, str(message), parse_mode=None, **kwargs)

    def set_message_handler(self, handler: Callable[[dict[str, Any]], Awaitable[str | None]]) -> None:
        self._message_handler = handler
