from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

from openai import AsyncOpenAI

from drost.config import Settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-]{2,}")
_GEMINI_DOCUMENT_TASK = "RETRIEVAL_DOCUMENT"
_GEMINI_QUERY_TASK = "RETRIEVAL_QUERY"


class EmbeddingService:
    """Embeddings with provider-backed primary path and deterministic fallback."""

    def __init__(self, settings: Settings) -> None:
        self._provider = settings.memory_embedding_provider
        self._model = settings.memory_embedding_model
        self._dimensions = int(settings.memory_embedding_dimensions)

        self._client: Any | None = None
        self._client_type = "none"
        if self._provider == "gemini":
            if settings.gemini_api_key:
                try:
                    from google import genai
                except Exception as exc:
                    logger.warning("Gemini SDK unavailable, falling back to deterministic embeddings: %s", exc)
                else:
                    self._client = genai.Client(api_key=settings.gemini_api_key)
                    self._client_type = "gemini"
            else:
                logger.info("Gemini embedding provider configured without GEMINI_API_KEY; using deterministic fallback")
        elif self._provider == "openai" and settings.openai_api_key:
            self._client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=(settings.openai_base_url or None),
            )
            self._client_type = "openai"
        elif self._provider == "xai" and settings.xai_api_key:
            self._client = AsyncOpenAI(
                api_key=settings.xai_api_key,
                base_url=settings.xai_base_url,
            )
            self._client_type = "xai"

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
        return await self.embed_document(text)

    async def embed_query(self, text: str) -> list[float]:
        return await self._embed(text, task_type=_GEMINI_QUERY_TASK)

    async def embed_document(self, text: str, *, title: str | None = None) -> list[float]:
        return await self._embed(text, task_type=_GEMINI_DOCUMENT_TASK, title=title)

    async def _embed(self, text: str, *, task_type: str, title: str | None = None) -> list[float]:
        cleaned = (text or "").strip()
        if not cleaned:
            return [0.0] * self._dimensions

        if self._client is not None and self._client_type == "gemini":
            return await self._embed_gemini(cleaned, task_type=task_type, title=title)

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

    async def _embed_gemini(self, text: str, *, task_type: str, title: str | None = None) -> list[float]:
        if self._client is None:
            return self._deterministic_embedding(text)
        try:
            from google.genai import types
        except Exception as exc:
            logger.warning("Gemini types unavailable, falling back to deterministic embeddings: %s", exc)
            return self._deterministic_embedding(text)

        config = types.EmbedContentConfig(
            taskType=task_type,
            title=(title or None) if task_type == _GEMINI_DOCUMENT_TASK else None,
            autoTruncate=True,
        )
        try:
            resp = await self._client.aio.models.embed_content(
                model=self._model,
                contents=text,
                config=config,
            )
        except Exception as exc:
            logger.warning("Gemini embedding API failed, falling back to deterministic embedding: %s", exc)
            return self._deterministic_embedding(text)

        embeddings = list(getattr(resp, "embeddings", []) or [])
        if not embeddings:
            return self._deterministic_embedding(text)

        first = embeddings[0]
        vector = list(getattr(first, "values", []) or [])
        if not vector:
            return self._deterministic_embedding(text)

        stats = getattr(first, "statistics", None)
        if getattr(stats, "truncated", False):
            logger.info(
                "Gemini embedding input truncated task_type=%s token_count=%s",
                task_type,
                getattr(stats, "token_count", None),
            )

        return self._normalize(self._resize([float(v) for v in vector]))

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
        if self._client is not None and self._client_type == "gemini":
            await self._client.aio.aclose()
            self._client.close()
            return
        if self._client is not None:
            await self._client.close()
