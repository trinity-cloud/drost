from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from drost.channels.telegram import TelegramChannel
from drost.gateway import Gateway


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


@pytest.mark.asyncio
async def test_media_group_bundles_into_single_routed_context(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)
    channel.MEDIA_GROUP_DEBOUNCE_SECONDS = 0.01

    routed: list[dict[str, object]] = []

    async def _fake_route(message: object, *, text: str, media: list[dict[str, object]] | None) -> None:
        routed.append({"message": message, "text": text, "media": media})

    monkeypatch.setattr(channel, "_route_context", _fake_route)

    message1 = SimpleNamespace(chat=SimpleNamespace(id=123), media_group_id="grp1", message_id=10)
    message2 = SimpleNamespace(chat=SimpleNamespace(id=123), media_group_id="grp1", message_id=11)

    queued1 = await channel._enqueue_media_group_message(
        message1,
        caption="Album caption",
        attachment_hint="[Image attached: /tmp/one.jpg]",
        media=[{"type": "image", "mime_type": "image/jpeg", "data": "aaa", "path": "/tmp/one.jpg"}],
    )
    queued2 = await channel._enqueue_media_group_message(
        message2,
        caption="",
        attachment_hint="[Image attached: /tmp/two.jpg]",
        media=[{"type": "image", "mime_type": "image/jpeg", "data": "bbb", "path": "/tmp/two.jpg"}],
    )

    assert queued1 is True
    assert queued2 is True

    await asyncio.sleep(0.05)

    assert len(routed) == 1
    assert routed[0]["text"] == "Album caption\n\n[Image attached: /tmp/one.jpg]\n[Image attached: /tmp/two.jpg]"
    media = routed[0]["media"]
    assert isinstance(media, list)
    assert len(media) == 2


class _FakeAgent:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def respond(self, **kwargs: object) -> str:
        self.calls.append(dict(kwargs))
        return "ok"


@pytest.mark.asyncio
async def test_gateway_accepts_media_only_telegram_turn() -> None:
    gateway = Gateway.__new__(Gateway)
    gateway.agent = _FakeAgent()

    context = {
        "chat_id": 123,
        "text": "",
        "media": [{"type": "image", "mime_type": "image/jpeg", "data": "aaa"}],
        "session_id": None,
    }
    reply = await Gateway._handle_telegram_message(gateway, context)

    assert reply == "ok"
    assert len(gateway.agent.calls) == 1
    assert gateway.agent.calls[0]["media"] == context["media"]
