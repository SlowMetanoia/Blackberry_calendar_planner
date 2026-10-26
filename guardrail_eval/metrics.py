"""Расчёт метрик и сводки по результатам оценки."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .models import CaseVerdict, Severity


def build_summary(
    cases: list[CaseVerdict],
    false_positive_count: int,
    false_negative_count: int,
    guard_mismatch_count: int,
) -> dict[str, Any]:
    """Строит словарь summary для JSON-отчёта."""
    total = len(cases)
    ok = sum(1 for c in cases if c.severity == Severity.OK)
    acceptable = sum(1 for c in cases if c.severity == Severity.ACCEPTABLE)
    bad = sum(1 for c in cases if c.severity == Severity.BAD)
    very_bad = sum(1 for c in cases if c.severity == Severity.VERY_BAD)
    critical = sum(1 for c in cases if c.critical)

    adequate = ok + acceptable
    agent_adequacy_rate = round(adequate / total, 4) if total else 0.0

    return {
        "total": total,
        "ok": ok,
        "acceptable": acceptable,
        "bad": bad,
        "very_bad": very_bad,
        "false_positive_count": false_positive_count,
        "false_negative_count": false_negative_count,
        "guard_mismatch_count": guard_mismatch_count,
        "agent_adequacy_rate": agent_adequacy_rate,
        "critical_count": critical,
    }


def build_by_category(cases: list[CaseVerdict]) -> dict[str, dict[str, int]]:
    """Разбивка по expected_category."""
    result: dict[str, dict[str, int]] = defaultdict(
        lambda: {"ok": 0, "acceptable": 0, "bad": 0, "very_bad": 0, "total": 0}
    )
    for case in cases:
        cat = case.expected.get("category", "unknown")
        stats = result[cat]
        stats["total"] += 1
        stats[case.severity.value] += 1
    return dict(result)


def build_by_guard_source(cases: list[CaseVerdict]) -> dict[str, dict[str, int]]:
    """Разбивка по guard_source."""
    result: dict[str, dict[str, int]] = defaultdict(
        lambda: {"ok": 0, "acceptable": 0, "bad": 0, "very_bad": 0, "total": 0}
    )
    for case in cases:
        src = case.expected.get("guard_source", "unknown")
        stats = result[src]
        stats["total"] += 1
        stats[case.severity.value] += 1
    return dict(result)


def collect_critical_incidents(cases: list[CaseVerdict]) -> list[dict[str, Any]]:
    """Собирает все very_bad кейсы в список критических инцидентов."""
    incidents = []
    for case in cases:
        if case.critical:
            incidents.append(
                {
                    "case_id": case.case_id,
                    "severity": case.severity.value,
                    "category": case.expected.get("category"),
                    "guard_source": case.expected.get("guard_source"),
                    "issues": case.issues,
                }
            )
    # Сортируем по case_id для стабильного вывода
    incidents.sort(key=lambda x: x["case_id"])
    return incidents
