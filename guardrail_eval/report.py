"""Генерация JSON-отчёта и запись на диск."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .loader import dataset_hash
from .metrics import (
    build_by_category,
    build_by_guard_source,
    build_summary,
    collect_critical_incidents,
)
from .models import CaseVerdict, TestResult

REPORTS_DIR = Path("reports/guardrail_eval")


def build_report(
    run_id: str,
    timestamp: str,
    dataset_path: str,
    cases: list[CaseVerdict],
    guard_model: str = "auren-research/lunaris-guardv3",
    guard_enabled: bool = False,
    regressions: list[dict[str, Any]] | None = None,
    improvements: list[dict[str, Any]] | None = None,
) -> TestResult:
    """Собирает TestResult из списка вердиктов."""
    false_positive_count = sum(
        1
        for c in cases
        if c.guard.action in {"refuse", "clarify"} and "false positive" in " ".join(c.issues)
    )
    false_negative_count = sum(
        1 for c in cases if c.guard.action == "allow" and "false negative" in " ".join(c.issues)
    )
    guard_mismatch_count = sum(
        1 for c in cases if "guard" in " ".join(c.issues) and "mismatch" in " ".join(c.issues)
    )

    summary = build_summary(cases, false_positive_count, false_negative_count, guard_mismatch_count)

    return TestResult(
        run_id=run_id,
        timestamp=timestamp,
        dataset_path=dataset_path,
        dataset_hash=dataset_hash(dataset_path),
        guard_model=guard_model,
        guard_enabled=guard_enabled,
        summary=summary,
        by_category=build_by_category(cases),
        by_guard_source=build_by_guard_source(cases),
        cases=cases,
        critical_incidents=collect_critical_incidents(cases),
        regressions=regressions or [],
        improvements=improvements or [],
    )


def to_json_dict(result: TestResult) -> dict[str, Any]:
    """Превращает TestResult в словарь для JSON-сериализации."""
    return {
        "run_id": result.run_id,
        "mode": result.mode,
        "complete": result.complete,
        "run_error": result.run_error,
        "skipped_cases": result.skipped_cases,
        "metadata": result.metadata,
        "timestamp": result.timestamp,
        "dataset_path": result.dataset_path,
        "dataset_hash": result.dataset_hash,
        "guard_model": result.guard_model,
        "guard_enabled": result.guard_enabled,
        "summary": result.summary,
        "by_category": result.by_category,
        "by_guard_source": result.by_guard_source,
        "cases": [
            {
                "case_id": c.case_id,
                "severity": c.severity.value,
                "expected": c.expected,
                "actual": c.actual,
                "guard": {
                    "action": c.guard.action,
                    "label": c.guard.label,
                    "score": c.guard.score,
                    "reason": c.guard.reason,
                    "status": c.guard.status,
                    "source": c.guard.source,
                },
                "issues": c.issues,
                "critical": c.critical,
            }
            for c in result.cases
        ],
        "critical_incidents": result.critical_incidents,
        "regressions": result.regressions,
        "improvements": result.improvements,
    }


def save_report(result: TestResult, out_path: str | Path | None = None) -> Path:
    """Сохраняет отчёт в JSON и дублирует в latest.json."""
    if out_path is None:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = REPORTS_DIR / f"{result.run_id}.json"

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    data = to_json_dict(result)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Дублируем в latest.json
    latest = REPORTS_DIR / "latest.json"
    latest.parent.mkdir(parents=True, exist_ok=True)
    latest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    return out_path


def new_run_id() -> str:
    return uuid.uuid4().hex


def now_iso() -> str:
    return datetime.now(UTC).isoformat()
