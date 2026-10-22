"""Input/output safety guardrails for the calendar agent.

The guard service is intentionally behind a small HTTP contract so a local
Russian-capable classifier can be deployed independently from the API.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from .config import Settings

GuardAction = Literal["allow", "refuse", "clarify"]
GuardCategory = Literal[
    "none",
    "prompt_injection",
    "off_topic",
    "hate",
    "extremist_praise",
    "violence",
    "sexual",
    "unsafe_other",
]

SAFE_REFUSAL = (
    "Я могу помогать только с задачами и событиями календаря. "
    "Не могу помогать с созданием другого вредоносного контента."
)
HATE_REFUSAL = (
    "Я могу помогать только с задачами и событиями календаря. "
    "Не могу помогать с созданием контента, который может вызывать ненависть."
)
OFF_TOPIC_REFUSAL = (
    "Я предназначен для управления задачами и событиями календаря. "
    "Сформулируйте запрос про задачу, встречу, напоминание или расписание."
)
INJECTION_REFUSAL = (
    "Я не могу выполнять инструкции, которые пытаются изменить правила работы агента. "
    "Сформулируйте обычный запрос к календарю."
)


@dataclass(frozen=True)
class GuardDecision:
    action: GuardAction
    category: GuardCategory = "none"
    score: float = 0.0
    reason: str = ""


_INJECTION_PATTERNS = (
    r"игнорируй\s+(все\s+)?предыдущие\s+инструкции",
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"раскр(ой|ывать)\s+.*(системн|скрыт).*промпт",
    r"reveal\s+.*system\s+prompt",
    r"ты\s+теперь\s+(системный|администратор|другой)\s+агент",
    r"вызови\s+commit_calendar_command",
)

_HARMFUL_PATTERNS = (
    ("extremist_praise", r"(восхвал|оправд|прослав)\w*\s+(нацизм|нацист|фашизм|фашист)"),
    ("extremist_praise", r"(нацизм|нацист|фашизм|фашист)\w*\s+(прав|хорош|велик|нужн)"),
    ("hate", r"разжиг\w*\s+ненавист"),
    ("hate", r"(убить|истребить|уничтожить)\s+(всех|людей|евреев|мусульман|мигрантов)"),
    ("hate", r"расов\w*\s+превосходств"),
    ("violence", r"(как|способ)\s+(убить|взорвать|совершить\s+теракт)"),
)


def _contains(patterns: tuple[str, ...], text: str) -> bool:
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def _deterministic_decision(text: str) -> GuardDecision | None:
    normalized = " ".join(text.casefold().split())
    for category, pattern in _HARMFUL_PATTERNS:
        if re.search(pattern, normalized, re.IGNORECASE):
            return GuardDecision("refuse", category, 1.0, "deterministic_harmful_pattern")
    if _contains(_INJECTION_PATTERNS, normalized):
        return GuardDecision("refuse", "prompt_injection", 1.0, "deterministic_injection_pattern")
    return None


def _parse_remote_decision(payload: Any) -> GuardDecision:
    if not isinstance(payload, dict):
        return GuardDecision("clarify", "unsafe_other", 1.0, "invalid_guard_response")
    label = str(payload.get("label", payload.get("category", "none"))).casefold()
    score = float(payload.get("score", payload.get("confidence", 0.0)) or 0.0)
    action = str(payload.get("action", "allow")).casefold()
    category_map = {
        "injection": "prompt_injection",
        "prompt_injection": "prompt_injection",
        "jailbreak": "prompt_injection",
        "off-topic": "off_topic",
        "off_topic": "off_topic",
        "hate_speech": "hate",
        "hate": "hate",
        "violent_crimes": "violence",
        "non_violent_crimes": "unsafe_other",
        "sex_crimes": "sexual",
        "child_exploitation": "sexual",
        "indiscriminate_weapons": "violence",
        "sexual_content": "sexual",
        "suicide_self_harm": "unsafe_other",
        "code_interpreter_abuse": "unsafe_other",
        "extremism": "extremist_praise",
        "extremist_praise": "extremist_praise",
        "violence": "violence",
        "sexual": "sexual",
        "unsafe": "unsafe_other",
        "unsafe_other": "unsafe_other",
    }
    category = category_map.get(label, "none")
    if action not in {"allow", "refuse", "clarify"}:
        action = "refuse" if category != "none" else "clarify"
    if category != "none" and action == "allow" and score >= 0.5:
        action = "refuse"
    return GuardDecision(
        action, category, max(0.0, min(score, 1.0)), str(payload.get("reason", ""))
    )


async def classify(text: str, settings: Settings, *, source: str = "user") -> GuardDecision:
    """Classify text with deterministic rules and an optional local guard model."""
    deterministic = _deterministic_decision(text)
    if deterministic is not None:
        return deterministic
    if not settings.guard_enabled or not settings.guard_base_url:
        return GuardDecision("allow")
    url = f"{settings.guard_base_url.rstrip('/')}/classify"
    payload = {"model": settings.guard_model, "text": text, "source": source}
    headers = {"Content-Type": "application/json"}
    if settings.guard_api_key:
        headers["Authorization"] = f"Bearer {settings.guard_api_key}"
    try:
        async with httpx.AsyncClient(timeout=settings.guard_request_timeout_seconds) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
        return _parse_remote_decision(response.json())
    except (httpx.HTTPError, ValueError, TypeError):
        # Fail closed only for configured guards. A broken guard must not let
        # arbitrary content through in a production safety configuration.
        return GuardDecision("clarify", "unsafe_other", 1.0, "guard_unavailable")


def refusal_for(decision: GuardDecision) -> str:
    if decision.category == "off_topic":
        return OFF_TOPIC_REFUSAL
    if decision.category == "prompt_injection":
        return INJECTION_REFUSAL
    if decision.category == "hate":
        return HATE_REFUSAL
    return SAFE_REFUSAL


def mark_untrusted_text(value: str) -> str:
    """Make retrieved calendar text visibly data-only to the planner model."""
    return f"<untrusted_calendar_data>{value}</untrusted_calendar_data>"
