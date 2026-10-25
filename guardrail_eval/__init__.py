"""guardrail_eval — компонент оценки качества гардрейлов Smart Planner.

Читает ответ run_agent, анализирует качество работы гардов и адекватность
действий агента. Формирует JSON-отчёт для итеративного workflow Сабины.
"""

from .cli import main
from .models import (
    CaseVerdict,
    EvalCase,
    GuardResult,
    Severity,
    TestResult,
)
from .runner import GuardrailRunner

__all__ = [
    "CaseVerdict",
    "EvalCase",
    "GuardResult",
    "GuardrailRunner",
    "Severity",
    "TestResult",
    "main",
]
