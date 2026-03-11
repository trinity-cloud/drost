from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from drost.channels.telegram import TelegramChannel
from drost.gateway import Gateway


class _DummyStore:
    def __init__(self) -> None:
        self.active_session_id = "s_prev"
        self.created: list[tuple[int, str]] = []

    def get_active_session_id(self, chat_id: int) -> str | None:
        _ = chat_id
        return self.active_session_id

    def create_session(self, chat_id: int, title: str = "") -> str:
        self.created.append((chat_id, title))
        self.active_session_id = "s_next"
        return "s_next"


class _DummySession:
    async def close(self) -> None:
        return None


class _FakeBot:
    def __init__(self, token: str) -> None:
        self.token = token
        self.sent: list[dict[str, object]] = []
        self.edited: list[dict[str, object]] = []
        self.deleted: list[dict[str, object]] = []
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

    async def delete_message(
        self,
        *,
        chat_id: int,
        message_id: int,
        **kwargs: object,
    ) -> bool:
        self.deleted.append(
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "kwargs": kwargs,
            }
        )
        return True


class _FakeTelegramMessage:
    def __init__(self, chat_id: int) -> None:
        self.chat = SimpleNamespace(id=chat_id)
        self.answers: list[dict[str, object]] = []

    async def answer(self, text: str, *, parse_mode: str | None = None) -> None:
        self.answers.append({"text": text, "parse_mode": parse_mode})


class _FakeInboundTelegramMessage:
    def __init__(self, chat_id: int, text: str, *, message_id: int = 77) -> None:
        self.chat = SimpleNamespace(id=chat_id, type="private")
        self.from_user = SimpleNamespace(id=999, is_bot=False, username="migel", first_name="Migel")
        self.text = text
        self.message_id = message_id
        self.caption = None
        self.photo = None
        self.document = None


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


@pytest.mark.asyncio
async def test_new_session_calls_continuity_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    bot = _FakeBot(token="test-token")
    store = _DummyStore()
    monkeypatch.setattr("drost.channels.telegram.Bot", lambda token: bot)
    channel = TelegramChannel(
        token="test-token",
        store=store,  # type: ignore[arg-type]
        webhook_url=None,
        webhook_path="/webhook/telegram",
        webhook_secret=None,
        allowed_users=None,
    )

    calls: list[dict[str, object]] = []

    async def _new_session_handler(payload: dict[str, object]) -> dict[str, object]:
        calls.append(payload)
        return {"queued": True, "message": "Continuity queued from s_prev to s_next."}

    channel.set_new_session_handler(_new_session_handler)
    message = _FakeTelegramMessage(chat_id=123)

    await channel._handle_new_session(message, "Project branch")

    assert store.created == [(123, "Project branch")]
    assert len(calls) == 1
    assert calls[0]["from_session_id"] == "s_prev"
    assert calls[0]["to_session_id"] == "s_next"
    assert message.answers
    assert "New session active: s_next" in str(message.answers[0]["text"])
    assert "Continuity queued from s_prev to s_next." in str(message.answers[0]["text"])


@pytest.mark.asyncio
async def test_route_context_streams_working_message_before_final_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)
    message = _FakeInboundTelegramMessage(chat_id=123, text="hello")

    async def _handler(context: dict[str, object]) -> str:
        status_callback = context["status_callback"]
        answer_stream_callback = context["answer_stream_callback"]
        assert callable(status_callback)
        assert callable(answer_stream_callback)
        await status_callback("Thinking...")
        await answer_stream_callback("Partial")
        await asyncio.sleep(0.4)
        await answer_stream_callback("Partial answer")
        await asyncio.sleep(0.4)
        return "Final **answer**"

    channel.set_message_handler(_handler)

    await channel._route_context(message, text="hello", media=None)

    plain_text_edits = [edit for edit in bot.edited if edit["parse_mode"] is None]
    html_edits = [edit for edit in bot.edited if edit["parse_mode"] == "HTML"]

    assert bot.sent[0]["text"] == "Working..."
    assert any(edit["text"] == "Thinking..." for edit in plain_text_edits)
    assert any(edit["text"] == "Partial" for edit in plain_text_edits)
    assert any(edit["text"] == "Partial answer" for edit in plain_text_edits)
    assert html_edits
    assert "<b>answer</b>" in str(html_edits[-1]["text"])


@pytest.mark.asyncio
async def test_route_context_preserves_streamed_text_when_tool_phase_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)
    message = _FakeInboundTelegramMessage(chat_id=123, text="hello")

    async def _handler(context: dict[str, object]) -> str:
        status_callback = context["status_callback"]
        answer_stream_callback = context["answer_stream_callback"]
        assert callable(status_callback)
        assert callable(answer_stream_callback)
        await answer_stream_callback("Brain surgery on yourself.")
        await asyncio.sleep(0.4)
        await answer_stream_callback(None)
        await status_callback("Using tools: file_write")
        await asyncio.sleep(0.1)
        return "Noted. Source code = handle with extreme care."

    channel.set_message_handler(_handler)

    await channel._route_context(message, text="hello", media=None)

    assert len(bot.sent) == 1
    assert bot.sent[0]["text"] == "Working..."

    html_edits = [edit for edit in bot.edited if edit["parse_mode"] == "HTML"]

    assert any("Brain surgery on yourself." in str(edit["text"]) for edit in html_edits)
    assert any(
        edit["message_id"] == 1
        and "Brain surgery on yourself." in str(edit["text"])
        and "Noted. Source code = handle with extreme care." in str(edit["text"])
        for edit in html_edits
    )


@pytest.mark.asyncio
async def test_route_context_suppresses_duplicate_final_after_preserved_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)
    message = _FakeInboundTelegramMessage(chat_id=123, text="hello")

    final_text = "Okay, I've got a solid picture now."

    async def _handler(context: dict[str, object]) -> str:
        answer_stream_callback = context["answer_stream_callback"]
        assert callable(answer_stream_callback)
        await answer_stream_callback(final_text)
        await asyncio.sleep(0.4)
        await answer_stream_callback(None)
        return final_text

    channel.set_message_handler(_handler)

    await channel._route_context(message, text="hello", media=None)

    assert len(bot.sent) == 1
    assert any(edit["message_id"] == 1 and final_text in str(edit["text"]) for edit in bot.edited)
    assert not bot.deleted


@pytest.mark.asyncio
async def test_route_context_coalesces_near_duplicate_final_after_preserved_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bot = _FakeBot(token="test-token")
    channel = _build_channel(monkeypatch, bot)
    message = _FakeInboundTelegramMessage(chat_id=123, text="hello")

    preserved_text = (
        "Okay, here's the deal.\n\n"
        "**Is 191 pmol/L high?**\n\n"
        "Normal male estradiol reference range is roughly **40-160 pmol/L**. "
        "Some labs stretch the upper end to 200 pmol/L for men on TRT. "
        "So you're at 191 - at the top of or slightly above the normal range. "
        "It's elevated, but not crisis territory.\n\n"
        "High E2 symptoms you'd normally watch for are water retention, nipple sensitivity, "
        "mood swings, libido changes, weaker erections, and fatigue."
    )
    final_text = (
        "Okay, here's the deal.\n\n"
        "**Is 191 pmol/L high?**\n\n"
        "Normal male estradiol reference range is roughly **40-160 pmol/L**. "
        "Some labs stretch the upper end to ~200 pmol/L for men on TRT. "
        "You're at 191 - top of or slightly above the normal range. "
        "Elevated, but not crisis territory.\n\n"
        "High E2 symptoms you'd normally watch for are water retention, nipple sensitivity, "
        "mood swings, libido changes, weaker erections, and fatigue."
    )

    async def _handler(context: dict[str, object]) -> str:
        answer_stream_callback = context["answer_stream_callback"]
        status_callback = context["status_callback"]
        assert callable(answer_stream_callback)
        assert callable(status_callback)
        await answer_stream_callback(preserved_text)
        await asyncio.sleep(0.4)
        await answer_stream_callback(None)
        await status_callback("Using tools: memory_search")
        return final_text

    channel.set_message_handler(_handler)

    await channel._route_context(message, text="hello", media=None)

    assert len(bot.sent) == 1
    assert not bot.deleted
    html_edits = [edit for edit in bot.edited if edit["parse_mode"] == "HTML"]
    assert any(
        edit["message_id"] == 1
        and "~200 pmol/L" in str(edit["text"])
        and "Elevated, but not crisis territory." in str(edit["text"])
        for edit in html_edits
    )
