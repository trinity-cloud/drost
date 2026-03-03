from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

ProviderName = Literal["openai-codex", "anthropic", "xai"]


class Settings(BaseSettings):
    """Runtime configuration for Drost.

    Environment variables are read with the `DROST_` prefix by default,
    with selective fallback to standard provider env vars.
    """

    model_config = SettingsConfigDict(
        env_prefix="DROST_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "drost"
    gateway_host: str = "0.0.0.0"
    gateway_port: int = 8766
    log_level: str = "INFO"

    telegram_bot_token: str = ""
    telegram_allowed_user_ids: Annotated[list[int], NoDecode] = Field(default_factory=list)
    telegram_webhook_url: str = ""
    telegram_webhook_path: str = "/webhook/telegram"
    telegram_webhook_secret: str = ""

    default_provider: ProviderName = "openai-codex"

    openai_model: str = "gpt-5-codex"
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_codex_auth_path: Path = Field(
        default_factory=lambda: Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser() / "auth.json"
    )

    anthropic_model: str = "claude-sonnet-4-20250514"
    anthropic_token: str = ""

    xai_model: str = "grok-3-latest"
    xai_api_key: str = ""
    xai_base_url: str = "https://api.x.ai/v1"

    sqlite_path: Path = Field(default_factory=lambda: Path("~/.drost/drost.sqlite3").expanduser())
    sqvector_extension_path: str = ""

    memory_enabled: bool = True
    memory_top_k: int = 6
    memory_embedding_model: str = "text-embedding-3-small"
    memory_embedding_provider: Literal["openai", "xai", "none"] = "openai"
    memory_embedding_dimensions: int = 384

    session_history_limit: int = 64

    @field_validator("telegram_allowed_user_ids", mode="before")
    @classmethod
    def parse_telegram_allowed_user_ids(cls, value: str | list[int] | None) -> list[int]:
        if value is None:
            return []
        if isinstance(value, list):
            out: list[int] = []
            for item in value:
                try:
                    out.append(int(item))
                except Exception:
                    continue
            return out
        cleaned = str(value).strip()
        if not cleaned:
            return []
        out = []
        for item in cleaned.split(","):
            token = item.strip()
            if not token:
                continue
            try:
                out.append(int(token))
            except Exception:
                continue
        return out

    @field_validator("gateway_port")
    @classmethod
    def validate_gateway_port(cls, value: int) -> int:
        if value < 1 or value > 65535:
            raise ValueError("gateway_port must be in [1, 65535]")
        return value

    @field_validator("telegram_webhook_path")
    @classmethod
    def normalize_webhook_path(cls, value: str) -> str:
        cleaned = (value or "").strip() or "/webhook/telegram"
        if not cleaned.startswith("/"):
            cleaned = f"/{cleaned}"
        return cleaned

    @field_validator("session_history_limit")
    @classmethod
    def validate_session_history_limit(cls, value: int) -> int:
        if value < 4:
            raise ValueError("session_history_limit must be >= 4")
        return value

    @field_validator("memory_top_k")
    @classmethod
    def validate_memory_top_k(cls, value: int) -> int:
        if value < 1:
            raise ValueError("memory_top_k must be >= 1")
        return value

    @field_validator("memory_embedding_dimensions")
    @classmethod
    def validate_memory_embedding_dimensions(cls, value: int) -> int:
        if value < 8:
            raise ValueError("memory_embedding_dimensions must be >= 8")
        return value

    @model_validator(mode="after")
    def apply_provider_env_fallbacks(self) -> "Settings":
        if not self.openai_api_key:
            self.openai_api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
        if not self.anthropic_token:
            self.anthropic_token = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        if not self.xai_api_key:
            self.xai_api_key = (os.environ.get("XAI_API_KEY") or "").strip()

        self.sqlite_path = Path(self.sqlite_path).expanduser()
        self.openai_codex_auth_path = Path(self.openai_codex_auth_path).expanduser()

        self.log_level = (self.log_level or "INFO").upper()
        self.openai_base_url = (self.openai_base_url or "").strip()
        self.xai_base_url = (self.xai_base_url or "https://api.x.ai/v1").strip()
        self.sqvector_extension_path = (self.sqvector_extension_path or "").strip()
        self.telegram_bot_token = (self.telegram_bot_token or "").strip()
        self.telegram_webhook_url = (self.telegram_webhook_url or "").strip()
        self.telegram_webhook_secret = (self.telegram_webhook_secret or "").strip()

        return self

    @property
    def use_webhook(self) -> bool:
        return bool(self.telegram_webhook_url)

    @property
    def codex_oauth_enabled(self) -> bool:
        # Morpheus behavior: missing API key means use Codex OAuth.
        return not bool(self.openai_api_key)



def load_settings() -> Settings:
    return Settings()
