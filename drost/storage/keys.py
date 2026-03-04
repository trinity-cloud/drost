from __future__ import annotations

from dataclasses import dataclass
import re


@dataclass
class SessionKey:
    agent: str
    channel: str
    identifier: str

    def __str__(self) -> str:
        return f"{self.agent}:{self.channel}:{self.identifier}"



def build_session_key(
    agent: str = "main",
    channel: str = "telegram",
    identifier: str | int = "unknown",
) -> str:
    return f"{agent}:{channel}:{identifier}"



def parse_session_key(session_key: str) -> SessionKey:
    parts = session_key.split(":", 2)
    if len(parts) != 3:
        raise ValueError(
            f"Invalid session key format: {session_key}. Expected format: agent:channel:identifier"
        )
    return SessionKey(agent=parts[0], channel=parts[1], identifier=parts[2])



def session_key_for_telegram_chat(chat_id: int, session_id: str | None) -> str:
    sid = (session_id or "").strip()
    identifier = f"{chat_id}__{sid}" if sid else str(chat_id)
    return build_session_key(agent="main", channel="telegram", identifier=identifier)


def session_key_to_filename(session_key: str) -> str:
    filename = str(session_key or "").replace(":", "_")
    filename = re.sub(r"[^\w\-.]", "_", filename)
    return filename
