from typing import Any

import httpx

from .config import Settings


def normalize_base_url(value: str) -> str:
    """Return an OpenAI-compatible v1 base URL from an LM Studio root or v1 URL."""
    normalized = value.rstrip("/")
    return normalized if normalized.endswith("/v1") else f"{normalized}/v1"


def auth_headers(settings: Settings) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"
    return headers


def react_completion_payload(
    settings: Settings,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build an OpenAI-compatible tool-calling request for the ReAct loop."""
    return {
        "model": settings.llm_model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0,
        "top_p": 1,
        "top_k": 20,
        "max_tokens": settings.llm_max_tokens,
        "stream": False,
        "reasoning_effort": settings.llm_reasoning_effort,
    }


async def verify_llm_connection(settings: Settings) -> None:
    """Fail startup unless LM Studio is reachable and exposes the configured model."""
    if not settings.llm_base_url:
        if settings.llm_required:
            raise RuntimeError("LLM_BASE_URL is required")
        return

    base_url = normalize_base_url(settings.llm_base_url)
    try:
        async with httpx.AsyncClient(timeout=settings.llm_startup_timeout_seconds) as client:
            response = await client.get(f"{base_url}/models", headers=auth_headers(settings))
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError(f"LLM server is unavailable at {base_url}: {exc}") from exc

    try:
        available = [str(item["id"]) for item in response.json()["data"]]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"LLM server returned an invalid /models response at {base_url}"
        ) from exc
    if settings.llm_model not in available:
        shown = ", ".join(available) if available else "<none>"
        raise RuntimeError(
            f"LLM model {settings.llm_model!r} is unavailable at {base_url}; available: {shown}"
        )
