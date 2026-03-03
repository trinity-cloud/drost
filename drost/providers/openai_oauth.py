"""OAuth helpers for OpenAI Codex authentication.

Behavior mirrors Morpheus:
- If OpenAI API key is absent, read Codex tokens from ~/.codex/auth.json
- Refresh using refresh_token grant against auth.openai.com
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


def _default_codex_auth_path() -> Path:
    codex_home = (os.environ.get("CODEX_HOME") or "").strip()
    if codex_home:
        return Path(codex_home).expanduser() / "auth.json"
    return Path.home() / ".codex" / "auth.json"


CODEX_AUTH_PATH = _default_codex_auth_path()
OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
OPENAI_OAUTH_AUDIENCE = "https://api.openai.com/v1"


@dataclass(frozen=True)
class CodexTokens:
    access_token: str
    refresh_token: str
    id_token: str | None
    client_id: str | None
    expires_at: datetime | None


def _decode_jwt_noverify(token: str) -> dict[str, Any]:
    parts = (token or "").split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload.encode("utf-8"))
        decoded = json.loads(raw.decode("utf-8"))
        return decoded if isinstance(decoded, dict) else {}
    except Exception:
        return {}


def _token_expiry(token: str) -> datetime | None:
    claims = _decode_jwt_noverify(token)
    exp = claims.get("exp")
    if not exp:
        return None
    try:
        return datetime.fromtimestamp(int(exp), tz=timezone.utc)
    except Exception:
        return None


def _token_client_id(token: str) -> str | None:
    claims = _decode_jwt_noverify(token)
    client_id = claims.get("client_id")
    return str(client_id) if client_id else None


def load_codex_tokens(path: Path | None = None) -> CodexTokens:
    p = (path or CODEX_AUTH_PATH).expanduser()
    payload = json.loads(p.read_text(encoding="utf-8"))
    tokens = payload.get("tokens") or {}

    access = str(tokens.get("access_token") or "").strip()
    refresh = str(tokens.get("refresh_token") or "").strip()
    id_token = tokens.get("id_token") or None
    if isinstance(id_token, str) and not id_token.strip():
        id_token = None

    if not access or not refresh:
        raise ValueError(f"Codex auth tokens missing in {p}")

    return CodexTokens(
        access_token=access,
        refresh_token=refresh,
        id_token=id_token if isinstance(id_token, str) else None,
        client_id=_token_client_id(access),
        expires_at=_token_expiry(access),
    )


async def refresh_codex_tokens(
    *,
    refresh_token: str,
    client_id: str | None,
    audience: str = OPENAI_OAUTH_AUDIENCE,
) -> dict[str, Any]:
    if not refresh_token.strip():
        raise ValueError("refresh_token is empty")

    if not client_id:
        client_id = os.environ.get("OPENAI_OAUTH_CLIENT_ID") or ""
    if not client_id.strip():
        raise ValueError("client_id is missing (set OPENAI_OAUTH_CLIENT_ID or re-login)")

    data = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
        "audience": audience,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0)) as client:
        resp = await client.post(OPENAI_OAUTH_TOKEN_URL, json=data)
        resp.raise_for_status()
        payload = resp.json()
        return payload if isinstance(payload, dict) else {}


def persist_codex_tokens(update: dict[str, Any], *, path: Path | None = None) -> None:
    p = (path or CODEX_AUTH_PATH).expanduser()
    payload = json.loads(p.read_text(encoding="utf-8"))
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        tokens = {}
        payload["tokens"] = tokens

    for key in ("access_token", "refresh_token", "id_token", "account_id"):
        if key in update and update[key]:
            tokens[key] = update[key]

    payload["last_refresh"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    original_mode = None
    try:
        original_mode = p.stat().st_mode
    except OSError:
        original_mode = None

    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)

    if original_mode is not None:
        try:
            os.chmod(p, original_mode)
        except OSError:
            pass
