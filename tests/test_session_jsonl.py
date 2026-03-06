from __future__ import annotations

import json
from pathlib import Path

from drost.providers import Message, MessageRole, ToolCall, ToolResult
from drost.storage import SessionJSONLStore


def _read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        rows.append(json.loads(stripped))
    return rows


def test_session_jsonl_writes_both_files(tmp_path: Path) -> None:
    store = SessionJSONLStore(store_path=tmp_path)
    session_key = "main:telegram:123__s_2026-03-04_10-00-00"

    store.append_user_assistant(
        session_key=session_key,
        user_text="hello",
        assistant_text="hi there",
    )
    store.append_full_messages(
        session_key=session_key,
        messages=[
            Message(role=MessageRole.USER, content="hello"),
            Message(
                role=MessageRole.ASSISTANT,
                content="I will call a tool",
                tool_calls=[ToolCall(id="call1", name="web_search", arguments={"query": "drost"})],
            ),
            Message(
                role=MessageRole.TOOL,
                tool_results=[ToolResult(tool_call_id="call1", content="result", is_error=False)],
            ),
            Message(role=MessageRole.ASSISTANT, content="final answer"),
        ],
    )

    main_path, full_path = store.paths_for_session(session_key)
    assert main_path.exists()
    assert full_path.exists()

    main_rows = _read_jsonl(main_path)
    full_rows = _read_jsonl(full_path)

    assert len(main_rows) == 2
    assert main_rows[0]["message"]["role"] == "user"
    assert main_rows[0]["message"]["content"] == "hello"
    assert main_rows[1]["message"]["role"] == "assistant"
    assert main_rows[1]["message"]["content"] == "hi there"

    assert len(full_rows) == 4
    assert full_rows[1]["message"]["tool_calls"][0]["name"] == "web_search"
    assert full_rows[2]["message"]["tool_results"][0]["tool_call_id"] == "call1"
    assert full_rows[3]["message"]["content"] == "final answer"


def test_session_jsonl_sanitizes_inline_image_content(tmp_path: Path) -> None:
    store = SessionJSONLStore(store_path=tmp_path)
    session_key = "main:telegram:123__s_2026-03-04_10-00-01"

    store.append_full_messages(
        session_key=session_key,
        messages=[
            Message(
                role=MessageRole.USER,
                content=[
                    {"type": "text", "text": "Look at this"},
                    {"type": "image", "mime_type": "image/png", "data": "YWJj", "path": "/tmp/image.png"},
                ],
            )
        ],
    )

    _, full_path = store.paths_for_session(session_key)
    rows = _read_jsonl(full_path)
    content = rows[0]["message"]["content"]
    assert content[0] == {"type": "text", "text": "Look at this"}
    assert content[1]["type"] == "image"
    assert content[1]["mime_type"] == "image/png"
    assert content[1]["data_omitted"] is True
    assert content[1]["size_bytes"] == 3
    assert content[1]["path"] == "/tmp/image.png"
