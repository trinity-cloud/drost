from __future__ import annotations

from types import SimpleNamespace

import pytest

from drost.channels.telegram import TelegramChannel


class _DummyStore:
    pass


class _DummySession:
    async def close(self) -> None:
        return None


class _FakeBot:
    def __init__(self, token: str) -> None:
        self.token = token
        self.sent: list[dict[str, object]] = []
        self.edited: list[dict[str, object]] = []
        self.session = _DummySession()
        self.fail_html_edit = False

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
        **kwargs: object,
    ) -> SimpleNamespace:
        self.sent.append(
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
                "reply_to_message_id": reply_to_message_id,
                "kwargs": kwargs,
            }
        )
        return SimpleNamespace(message_id=len(self.sent))

    async def edit_message_text(
        self,
        text: str,
        *,
        chat_id: int,
        message_id: int,
        parse_mode: str | None = None,
        **kwargs: object,
    ) -> SimpleNamespace:
        self.edited.append(
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "parse_mode": parse_mode,
                "kwargs": kwargs,
            }
        )
        if parse_mode == "HTML" and self.fail_html_edit:
            raise RuntimeError("invalid html")
        return SimpleNamespace(message_id=message_id)


def _build_channel(monkeypatch: pytest.MonkeyPatch, bot: _FakeBot) -> TelegramChannel:
    monkeypatch.setattr("drost.channels.telegram.Bot", lambda token: bot)
    return TelegramChannel(
        token="test-token",
        store=_DummyStore(),  # type: ignore[arg-type]
        webhook_url=None,
        webhook_path="/webhook/telegram",
        webhook_secret=None,
        allowed_users=None,
    )


@pytest.mark.asyncio
async def test_finalize_renders_markdown_as_html(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)

    await channel._finalize_working_message(
        chat_id=123,
        message_id=99,
        text="Hello **world**",
        reply_to=88,
    )

    assert bot.edited
    assert bot.edited[0]["parse_mode"] == "HTML"
    assert "<b>world</b>" in str(bot.edited[0]["text"])


@pytest.mark.asyncio
async def test_finalize_falls_back_to_plain_text_on_html_error(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot(token="test-token")
    bot.fail_html_edit = True
    channel = _build_channel(monkeypatch, bot)

    await channel._finalize_working_message(
        chat_id=123,
        message_id=99,
        text="Hello **world**",
        reply_to=88,
    )

    assert len(bot.edited) >= 2
    assert bot.edited[0]["parse_mode"] == "HTML"
    assert bot.edited[1]["parse_mode"] is None
    assert bot.edited[1]["text"] == "Hello **world**"
