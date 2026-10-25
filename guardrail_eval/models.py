"""Базовые модели данных для guardrail_eval."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Severity(str, Enum):
    """Критичность результата оценки кейса."""

    OK = "ok"
    ACCEPTABLE = "acceptable"
    BAD = "bad"
    VERY_BAD = "very_bad"


@dataclass
class GuardResult:
    """Результат проверки гарда (локальный или удалённый сервис)."""

    action: str | None = None
    label: str | None = None
    score: float = 0.0
    reason: str = ""
    status: str = "unavailable"  # "ok" | "unavailable"
    source: str = "user_input"


@dataclass
class EvalCase:
    """Одна запись из датасета оценки гардрейлов."""

    case_id: str
    user_input: str
    llm_response_type: str
    llm_responses: list[dict[str, Any]]
    expected_action: str
    expected_category: str
    expected_state: str
    expected_db_mutations: int
    expected_reply_contains: str | None
    guard_source: str
    requires_remote_guard: bool
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class CaseVerdict:
    """Итог оценки одного кейса."""

    case_id: str
    severity: Severity
    expected: dict[str, Any]
    actual: dict[str, Any]
    guard: GuardResult
    issues: list[str] = field(default_factory=list)
    critical: bool = False


@dataclass
class TestResult:
    """Агрегированный результат прогона датасета."""

    run_id: str
    timestamp: str
    dataset_path: str
    dataset_hash: str
    guard_model: str
    guard_enabled: bool
    summary: dict[str, Any]
    by_category: dict[str, dict[str, int]]
    by_guard_source: dict[str, dict[str, int]]
    cases: list[CaseVerdict]
    critical_incidents: list[dict[str, Any]]
    regressions: list[dict[str, Any]] = field(default_factory=list)
    improvements: list[dict[str, Any]] = field(default_factory=list)
    mode: str = "mock"
    complete: bool = True
    run_error: str | None = None
    skipped_cases: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
