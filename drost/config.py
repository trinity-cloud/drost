from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Literal

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from drost.workspace_bootstrap import seed_workspace_files

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
    exa_api_key: str = Field(default="", validation_alias=AliasChoices("DROST_EXA_API_KEY", "EXA_API_KEY"))
    gemini_api_key: str = Field(default="", validation_alias=AliasChoices("DROST_GEMINI_API_KEY", "GEMINI_API_KEY"))

    sqlite_path: Path = Field(default_factory=lambda: Path("~/.drost/drost.sqlite3").expanduser())
    sqvector_extension_path: str = ""

    memory_enabled: bool = True
    memory_top_k: int = 6
    memory_embedding_model: str = "gemini-embedding-001"
    memory_embedding_provider: Literal["gemini", "openai", "xai", "none"] = "gemini"
    memory_embedding_dimensions: int = 3072
    memory_maintenance_enabled: bool = True
    memory_maintenance_interval_seconds: int = 1800
    memory_maintenance_max_events_per_run: int = 200
    memory_entity_synthesis_enabled: bool = True
    memory_continuity_enabled: bool = True
    memory_continuity_auto_on_new: bool = True
    memory_continuity_source_max_messages: int = 120
    memory_continuity_source_max_chars: int = 40_000
    memory_continuity_summary_max_tokens: int = 1_500
    memory_continuity_summary_max_chars: int = 12_000
    memory_continuity_inject_until_messages: int = 12

    session_history_limit: int = 64

    agent_max_iterations: int = 10
    agent_max_tool_calls_per_run: int = 24
    agent_tool_timeout_seconds: float = 30.0
    agent_run_timeout_seconds: float = 180.0

    context_budget_total_tokens: int = 96_000
    context_budget_system_tokens: int = 24_000
    context_budget_history_tokens: int = 24_000
    context_budget_memory_tokens: int = 24_000
    context_budget_reserve_tokens: int = 24_000

    history_compaction_enabled: bool = True
    history_compaction_trigger_ratio: float = 0.70
    history_compaction_keep_recent_messages: int = 12
    history_compaction_summary_max_tokens: int = 1_500

    workspace_dir: Path = Field(default_factory=lambda: Path("~/.drost").expanduser())
    attachments_dir: Path = Field(default_factory=lambda: Path("~/.drost/attachments").expanduser())
    trace_enabled: bool = True
    trace_dir: Path = Field(default_factory=lambda: Path("~/.drost/traces").expanduser())
    vision_max_inline_image_bytes: int = 5 * 1024 * 1024
    prompt_workspace_files: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]
    )

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

    @field_validator("prompt_workspace_files", mode="before")
    @classmethod
    def parse_prompt_workspace_files(cls, value: str | list[str] | None) -> list[str]:
        if value is None:
            return []
        if isinstance(value, list):
            out: list[str] = []
            for item in value:
                cleaned = str(item or "").strip()
                if cleaned:
                    out.append(cleaned)
            return out
        cleaned = str(value).strip()
        if not cleaned:
            return []
        return [token.strip() for token in cleaned.split(",") if token.strip()]

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

    @field_validator(
        "agent_max_iterations",
        "agent_max_tool_calls_per_run",
        "memory_maintenance_interval_seconds",
        "memory_maintenance_max_events_per_run",
        "memory_continuity_source_max_messages",
        "memory_continuity_source_max_chars",
        "memory_continuity_summary_max_tokens",
        "memory_continuity_summary_max_chars",
        "memory_continuity_inject_until_messages",
        "context_budget_total_tokens",
        "context_budget_system_tokens",
        "context_budget_history_tokens",
        "context_budget_memory_tokens",
        "context_budget_reserve_tokens",
        "history_compaction_keep_recent_messages",
        "history_compaction_summary_max_tokens",
    )
    @classmethod
    def validate_positive_ints(cls, value: int) -> int:
        if int(value) < 1:
            raise ValueError("value must be >= 1")
        return int(value)

    @field_validator("agent_tool_timeout_seconds", "agent_run_timeout_seconds")
    @classmethod
    def validate_positive_floats(cls, value: float) -> float:
        if float(value) <= 0:
            raise ValueError("value must be > 0")
        return float(value)

    @field_validator("history_compaction_trigger_ratio")
    @classmethod
    def validate_compaction_ratio(cls, value: float) -> float:
        ratio = float(value)
        if ratio <= 0.0 or ratio >= 1.0:
            raise ValueError("history_compaction_trigger_ratio must be in (0, 1)")
        return ratio

    @model_validator(mode="after")
    def apply_provider_env_fallbacks(self) -> Settings:
        if not self.openai_api_key:
            self.openai_api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
        if not self.anthropic_token:
            self.anthropic_token = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        if not self.xai_api_key:
            self.xai_api_key = (os.environ.get("XAI_API_KEY") or "").strip()
        if not self.exa_api_key:
            self.exa_api_key = (os.environ.get("EXA_API_KEY") or "").strip()
        if not self.gemini_api_key:
            self.gemini_api_key = (os.environ.get("GEMINI_API_KEY") or "").strip()

        self.sqlite_path = Path(self.sqlite_path).expanduser()
        self.openai_codex_auth_path = Path(self.openai_codex_auth_path).expanduser()
        self.workspace_dir = Path(self.workspace_dir).expanduser()
        self.attachments_dir = Path(self.attachments_dir).expanduser()
        self.trace_dir = Path(self.trace_dir).expanduser()

        self.log_level = (self.log_level or "INFO").upper()
        self.openai_base_url = (self.openai_base_url or "").strip()
        self.xai_base_url = (self.xai_base_url or "https://api.x.ai/v1").strip()
        self.exa_api_key = (self.exa_api_key or "").strip()
        self.gemini_api_key = (self.gemini_api_key or "").strip()
        self.sqvector_extension_path = (self.sqvector_extension_path or "").strip()
        self.telegram_bot_token = (self.telegram_bot_token or "").strip()
        self.telegram_webhook_url = (self.telegram_webhook_url or "").strip()
        self.telegram_webhook_secret = (self.telegram_webhook_secret or "").strip()
        self.prompt_workspace_files = [str(name).strip() for name in self.prompt_workspace_files if str(name).strip()]
        if not self.prompt_workspace_files:
            self.prompt_workspace_files = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]

        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        seed_workspace_files(
            workspace_dir=self.workspace_dir,
            prompt_workspace_files=self.prompt_workspace_files,
        )
        if self.trace_enabled:
            self.trace_dir.mkdir(parents=True, exist_ok=True)

        if self.memory_embedding_provider == "gemini":
            self.memory_embedding_model = (self.memory_embedding_model or "gemini-embedding-001").strip()
            if self.memory_embedding_model != "gemini-embedding-001":
                raise ValueError("memory_embedding_model must be 'gemini-embedding-001' when provider is gemini")
            if int(self.memory_embedding_dimensions) != 3072:
                raise ValueError("Gemini embeddings must use the full 3072-dimensional output")

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
