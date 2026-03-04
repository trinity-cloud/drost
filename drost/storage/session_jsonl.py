from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from drost.providers import Message, ToolCall, ToolResult
from drost.storage.keys import session_key_to_filename

SESSION_FILE_MODE = 0o600


class SessionJSONLStore:
    """Append-only JSONL transcripts per session.

    Files per session:
    - <session>.jsonl: user/assistant messages only
    - <session>.full.jsonl: full stream with tool calls/results
    """

    def __init__(self, *, store_path: Path) -> None:
        self.store_path = Path(store_path).expanduser()
        self.store_path.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._seq_cache: dict[str, int] = {}

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _safe_message_id() -> str:
        return f"msg_{uuid.uuid4().hex}"

    def _session_path(self, session_key: str) -> Path:
        return self.store_path / f"{session_key_to_filename(session_key)}.jsonl"

    def _full_path(self, session_key: str) -> Path:
        return self.store_path / f"{session_key_to_filename(session_key)}.full.jsonl"

    def paths_for_session(self, session_key: str) -> tuple[Path, Path]:
        return self._session_path(session_key), self._full_path(session_key)

    def _enforce_mode(self, path: Path) -> None:
        try:
            os.chmod(path, SESSION_FILE_MODE)
        except OSError:
            pass

    def _get_last_seq(self, path: Path) -> int:
        key = str(path)
        if key in self._seq_cache:
            return int(self._seq_cache[key])
        if not path.exists():
            self._seq_cache[key] = 0
            return 0

        seq = 0
        line_count = 0
        try:
            with path.open(encoding="utf-8") as f:
                for line in f:
                    raw = line.strip()
                    if not raw:
                        continue
                    line_count += 1
                    try:
                        parsed = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    message = parsed.get("message")
                    if not isinstance(message, dict):
                        continue
                    value = message.get("seq")
                    if isinstance(value, int):
                        seq = max(seq, value)
        except OSError:
            self._seq_cache[key] = 0
            return 0

        resolved = max(seq, line_count)
        self._seq_cache[key] = resolved
        return resolved

    def _next_seq(self, path: Path) -> int:
        key = str(path)
        next_seq = self._get_last_seq(path) + 1
        self._seq_cache[key] = next_seq
        return next_seq

    @staticmethod
    def _serialize_tool_call(tool_call: ToolCall) -> dict[str, Any]:
        return {
            "id": str(tool_call.id),
            "name": str(tool_call.name),
            "arguments": dict(tool_call.arguments or {}),
        }

    @staticmethod
    def _serialize_tool_result(tool_result: ToolResult) -> dict[str, Any]:
        return {
            "tool_call_id": str(tool_result.tool_call_id),
            "content": str(tool_result.content or ""),
            "is_error": bool(tool_result.is_error),
        }

    def _append_message(self, *, path: Path, message: dict[str, Any]) -> None:
        entry = {
            "timestamp": self._utc_now(),
            "message": message,
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._enforce_mode(path)

    def append_user_assistant(self, *, session_key: str, user_text: str, assistant_text: str) -> None:
        path = self._session_path(session_key)
        with self._lock:
            user_seq = self._next_seq(path)
            self._append_message(
                path=path,
                message={
                    "role": "user",
                    "content": str(user_text or ""),
                    "message_id": self._safe_message_id(),
                    "seq": int(user_seq),
                },
            )
            assistant_seq = self._next_seq(path)
            self._append_message(
                path=path,
                message={
                    "role": "assistant",
                    "content": str(assistant_text or ""),
                    "message_id": self._safe_message_id(),
                    "seq": int(assistant_seq),
                },
            )

    def append_full_messages(self, *, session_key: str, messages: list[Message]) -> None:
        path = self._full_path(session_key)
        with self._lock:
            for msg in messages:
                seq = self._next_seq(path)
                payload: dict[str, Any] = {
                    "role": str(msg.role.value),
                    "message_id": self._safe_message_id(),
                    "seq": int(seq),
                }
                if msg.content is not None:
                    payload["content"] = msg.content
                if msg.tool_calls:
                    payload["tool_calls"] = [self._serialize_tool_call(tc) for tc in msg.tool_calls]
                if msg.tool_results:
                    payload["tool_results"] = [self._serialize_tool_result(tr) for tr in msg.tool_results]
                if msg.name:
                    payload["name"] = str(msg.name)
                self._append_message(path=path, message=payload)

