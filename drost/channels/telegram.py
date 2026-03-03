from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Callable

from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ChatType
from aiogram.filters import Command
from aiogram.types import Message as TgMessage
from aiogram.types import Update
from fastapi import FastAPI, Request, Response

from drost.channels.base import BaseChannel
from drost.storage import SQLiteStore, session_key_for_telegram_chat

logger = logging.getLogger(__name__)


class TelegramChannel(BaseChannel):
    def __init__(
        self,
        *,
        token: str,
        store: SQLiteStore,
        webhook_url: str | None,
        webhook_path: str,
        webhook_secret: str | None,
        allowed_users: list[int] | None = None,
    ) -> None:
        self.token = token
        self.store = store
        self.webhook_url = (webhook_url or "").strip() or None
        self.webhook_path = (webhook_path or "/webhook/telegram").strip() or "/webhook/telegram"
        self.webhook_secret = (webhook_secret or "").strip() or None
        self.allowed_users = set(allowed_users or [])

        self.bot = Bot(token=token)
        self.dp = Dispatcher()
        self.router = Router()
        self.dp.include_router(self.router)

        self._message_handler: Callable[[dict[str, Any]], Awaitable[str | None]] | None = None
        self._polling_task: asyncio.Task[None] | None = None
        self._polling_active = False

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

    async def _send_long(self, chat_id: int, text: str, reply_to: int | None = None) -> None:
        body = str(text or "").strip()
        if not body:
            return

        max_len = 4000
        if len(body) <= max_len:
            await self.bot.send_message(chat_id, body, parse_mode=None, reply_to_message_id=reply_to)
            return

        cursor = 0
        first = True
        while cursor < len(body):
            chunk = body[cursor : cursor + max_len]
            cursor += len(chunk)
            await self.bot.send_message(
                chat_id,
                chunk,
                parse_mode=None,
                reply_to_message_id=reply_to if first else None,
            )
            first = False

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
        sid = self.store.create_session(chat_id, title=title)
        await message.answer(f"New session active: {sid}", parse_mode=None)

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
        if not message.text:
            return
        if not self._is_authorized(message):
            return

        parsed = self._parse_command(message.text)
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
            "text": message.text,
            "message_id": int(message.message_id),
            "session_id": session_id,
        }

        try:
            reply = await self._message_handler(context)
        except Exception:
            logger.exception("Error handling inbound Telegram message")
            await message.answer("Internal error while processing message.", parse_mode=None)
            return

        if reply:
            await self._send_long(chat_id, reply, reply_to=message.message_id)

    def _setup_handlers(self) -> None:
        self.router.message.register(self._handle_start, Command("start"))
        self.router.message.register(self._handle_help, Command("help"))
        self.router.message.register(self._handle_commands, Command("commands"))
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
            if self.webhook_url:
                await self.bot.delete_webhook(drop_pending_updates=False)
            if self._polling_active:
                try:
                    await self.dp.stop_polling()
                except RuntimeError:
                    pass
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
        return await self.bot.send_message(chat_id, str(message), parse_mode=None, **kwargs)

    def set_message_handler(self, handler: Callable[[dict[str, Any]], Awaitable[str | None]]) -> None:
        self._message_handler = handler
