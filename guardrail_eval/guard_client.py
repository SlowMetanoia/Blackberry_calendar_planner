"""Клиент для вызова удалённого guard-сервиса POST /classify."""

from __future__ import annotations

import httpx

GUARD_MODEL = "auren-research/lunaris-guardv3"
DEFAULT_GUARD_URL = "http://localhost:8090"


class GuardClient:
    """Клиент к guard-сервису. Если сервер недоступен — возвращает status='unavailable'."""

    def __init__(
        self,
        base_url: str = DEFAULT_GUARD_URL,
        model: str = GUARD_MODEL,
        timeout_seconds: float = 5.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def classify(
        self,
        text: str,
        source: str = "user_input",
    ) -> dict[str, Any]:
        """Вызывает POST /classify. Возвращает dict с action, label, score, reason, status."""

        payload = {
            "model": self.model,
            "text": text,
            "source": source,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/classify",
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()
                return {
                    "action": str(data.get("action", "allow")),
                    "label": str(data.get("label", "none")),
                    "score": float(data.get("score", 0.0)),
                    "reason": str(data.get("reason", "")),
                    "status": "ok",
                }
        except (httpx.HTTPError, ValueError, TypeError, OSError):
            return {
                "action": None,
                "label": None,
                "score": 0.0,
                "reason": "guard_unavailable",
                "status": "unavailable",
            }


# Тип для аннотаций (избегаем циклических импортов)
from typing import Any
