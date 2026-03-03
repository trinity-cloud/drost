from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

from openai import AsyncOpenAI

from drost.config import Settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-]{2,}")


class EmbeddingService:
    """Embeddings with provider-backed primary path and deterministic fallback."""

    def __init__(self, settings: Settings) -> None:
        self._provider = settings.memory_embedding_provider
        self._model = settings.memory_embedding_model
        self._dimensions = int(settings.memory_embedding_dimensions)

        self._client: AsyncOpenAI | None = None
        if self._provider == "openai" and settings.openai_api_key:
            self._client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=(settings.openai_base_url or None),
            )
        elif self._provider == "xai" and settings.xai_api_key:
            self._client = AsyncOpenAI(
                api_key=settings.xai_api_key,
                base_url=settings.xai_base_url,
            )

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @staticmethod
    def _normalize(vec: list[float]) -> list[float]:
        if not vec:
            return vec
        norm_sq = 0.0
        for v in vec:
            norm_sq += v * v
        if norm_sq <= 0.0:
            return vec
        scale = norm_sq ** 0.5
        return [v / scale for v in vec]

    def _resize(self, vec: list[float]) -> list[float]:
        dims = self._dimensions
        if len(vec) == dims:
            return vec
        if len(vec) > dims:
            return vec[:dims]
        return vec + [0.0] * (dims - len(vec))

    async def embed_one(self, text: str) -> list[float]:
        cleaned = (text or "").strip()
        if not cleaned:
            return [0.0] * self._dimensions

        if self._client is not None:
            payload: dict[str, Any] = {"model": self._model, "input": [cleaned]}
            if self._dimensions > 0:
                payload["dimensions"] = self._dimensions
            try:
                resp = await self._client.embeddings.create(**payload)
            except Exception as exc:
                # Some OpenAI-compatible providers reject `dimensions`.
                if "dimensions" in payload:
                    payload.pop("dimensions", None)
                    try:
                        resp = await self._client.embeddings.create(**payload)
                    except Exception as exc2:
                        logger.warning("Embedding API failed, falling back to deterministic embedding: %s", exc2)
                        return self._deterministic_embedding(cleaned)
                else:
                    logger.warning("Embedding API failed, falling back to deterministic embedding: %s", exc)
                    return self._deterministic_embedding(cleaned)

            vector = list(getattr(resp.data[0], "embedding", []) or [])
            if not vector:
                return self._deterministic_embedding(cleaned)
            vector = [float(v) for v in vector]
            return self._normalize(self._resize(vector))

        return self._deterministic_embedding(cleaned)

    def _deterministic_embedding(self, text: str) -> list[float]:
        dims = self._dimensions
        if dims <= 0:
            return []

        vec = [0.0] * dims
        tokens = _TOKEN_RE.findall(text.lower())
        if not tokens:
            tokens = [text.lower()]

        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            for i in range(0, len(digest), 4):
                chunk = digest[i : i + 4]
                if len(chunk) < 4:
                    continue
                value = int.from_bytes(chunk, "big", signed=False)
                index = value % dims
                sign = -1.0 if ((value >> 1) & 1) else 1.0
                weight = ((value >> 8) % 1000) / 1000.0
                vec[index] += sign * weight

        return self._normalize(vec)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
