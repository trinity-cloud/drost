from __future__ import annotations

import logging
from dataclasses import dataclass

from drost.config import Settings
from drost.providers.anthropic_provider import AnthropicProvider
from drost.providers.base import BaseProvider
from drost.providers.openai_compatible import OpenAICompatibleProvider

logger = logging.getLogger(__name__)


@dataclass
class ProviderRegistry:
    providers: dict[str, BaseProvider]
    active_name: str

    def get(self, name: str | None = None) -> BaseProvider:
        key = name or self.active_name
        if key not in self.providers:
            raise KeyError(f"Provider '{key}' is not available")
        return self.providers[key]

    def set_active(self, name: str) -> None:
        if name not in self.providers:
            raise KeyError(f"Provider '{name}' is not available")
        self.active_name = name

    def names(self) -> list[str]:
        return list(self.providers.keys())

    async def close(self) -> None:
        for provider in self.providers.values():
            try:
                await provider.close()
            except Exception:
                logger.debug("Provider close failed", exc_info=True)


def build_provider_registry(settings: Settings) -> ProviderRegistry:
    providers: dict[str, BaseProvider] = {}

    providers["openai-codex"] = OpenAICompatibleProvider(
        provider_name="openai-codex",
        model=settings.openai_model,
        token=settings.openai_api_key,
        base_url=settings.openai_base_url or None,
        codex_auth_path=str(settings.openai_codex_auth_path),
        tools_strict=True,
    )

    anthropic_token = (settings.anthropic_token or "").strip()
    if anthropic_token:
        providers["anthropic"] = AnthropicProvider(
            model=settings.anthropic_model,
            token=anthropic_token,
        )
    else:
        logger.info("Anthropic provider disabled: no token configured")

    xai_token = (settings.xai_api_key or "").strip()
    if xai_token:
        providers["xai"] = OpenAICompatibleProvider(
            provider_name="xai",
            model=settings.xai_model,
            token=xai_token,
            base_url=settings.xai_base_url,
            tools_strict=False,
        )
    else:
        logger.info("xAI provider disabled: no API key configured")

    active_name = settings.default_provider
    if active_name not in providers:
        if not providers:
            raise ValueError(
                "No providers are configured. Configure at least one provider token or Codex OAuth auth.json."
            )
        fallback = next(iter(providers.keys()))
        logger.warning("Default provider '%s' unavailable; falling back to '%s'", active_name, fallback)
        active_name = fallback

    return ProviderRegistry(providers=providers, active_name=active_name)
