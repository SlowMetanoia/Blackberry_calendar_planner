from collections.abc import Sequence

import httpx

from .config import Settings
from .llm import normalize_base_url


class EmbeddingError(RuntimeError):
    pass


class EmbeddingClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        api_key = self.settings.embedding_api_key or self.settings.llm_api_key
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        base_url = self.settings.embedding_base_url or self.settings.llm_base_url
        if not base_url:
            raise EmbeddingError("Embedding server URL is not configured")
        if not texts:
            return []
        url = f"{normalize_base_url(base_url)}/embeddings"
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.embedding_request_timeout_seconds
            ) as client:
                response = await client.post(
                    url,
                    headers=self._headers(),
                    json={"model": self.settings.embedding_model, "input": list(texts)},
                )
                response.raise_for_status()
                payload = response.json()
            ordered = sorted(payload["data"], key=lambda item: int(item["index"]))
            vectors = [[float(value) for value in item["embedding"]] for item in ordered]
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise EmbeddingError("Embedding model is unavailable or returned invalid data") from exc
        if len(vectors) != len(texts) or any(
            len(vector) != self.settings.embedding_dimensions for vector in vectors
        ):
            raise EmbeddingError(
                f"Embedding model must return {self.settings.embedding_dimensions} dimensions"
            )
        return vectors

    async def embed_query(self, query: str) -> list[float]:
        return (await self.embed([f"task: search result | query: {query}"]))[0]

    async def embed_query_batch(self, queries: Sequence[str]) -> list[list[float]]:
        return await self.embed([f"task: search result | query: {query}" for query in queries])

    async def embed_documents(self, documents: Sequence[tuple[str, str]]) -> list[list[float]]:
        return await self.embed(
            [
                f"task: search result | document: {title or 'Без названия'}. {description}"
                for title, description in documents
            ]
        )
