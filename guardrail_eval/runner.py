"""Оркестратор прогона датасета через run_agent с оценкой гардрейлов."""

from __future__ import annotations

from typing import Any

from .adapters import AgentRunAdapter
from .classifier import ClassificationInput, classify
from .guard_client import GuardClient
from .loader import load_dataset
from .models import CaseVerdict, EvalCase, GuardResult
from .report import build_report, new_run_id, now_iso, save_report


class GuardrailRunner:
    """Запускает оценку всего датасета и возвращает TestResult."""

    def __init__(
        self,
        dataset_path: str,
        call_guard: bool = False,
        guard_url: str = "http://localhost:8090",
        guard_model: str = "auren-research/lunaris-guardv3",
    ) -> None:
        self.dataset_path = dataset_path
        self.call_guard = call_guard
        self.guard_url = guard_url
        self.guard_model = guard_model
        self._guard_client = GuardClient(base_url=guard_url, model=guard_model)

    async def run(self) -> Any:
        """Выполняет полный прогон: загрузка датасета -> run_agent -> оценка -> отчёт."""
        cases = load_dataset(self.dataset_path)

        verdicts: list[CaseVerdict] = []
        fp_count = 0
        fn_count = 0
        mismatch_count = 0

        async with AgentRunAdapter() as adapter:
            for case in cases:
                verdict = await self._evaluate_one(adapter, case)
                verdicts.append(verdict)
                if "false positive" in " ".join(verdict.issues):
                    fp_count += 1
                if "false negative" in " ".join(verdict.issues):
                    fn_count += 1
                if "guard" in " ".join(verdict.issues) and "mismatch" in " ".join(verdict.issues):
                    mismatch_count += 1

        report = build_report(
            run_id=new_run_id(),
            timestamp=now_iso(),
            dataset_path=self.dataset_path,
            cases=verdicts,
            guard_model=self.guard_model,
            guard_enabled=self.call_guard,
        )
        save_report(report)
        return report

    async def _evaluate_one(
        self,
        adapter: AgentRunAdapter,
        case: EvalCase,
    ) -> CaseVerdict:
        """Оценивает один кейс: запускает run_agent, проверяет гард, классифицирует."""
        # 1. Запускаем run_agent
        actual = await adapter.run(
            case_user_input=case.user_input,
            llm_response_type=case.llm_response_type,
            llm_responses=case.llm_responses,
        )

        # 2. Guard (опционально)
        guard = GuardResult(source=case.guard_source, status="unavailable")
        if self.call_guard or case.requires_remote_guard:
            guard_result = await self._guard_client.classify(
                text=case.user_input,
                source=case.guard_source,
            )
            guard = GuardResult(
                action=guard_result["action"],
                label=guard_result["label"],
                score=guard_result["score"],
                reason=guard_result["reason"],
                status=guard_result["status"],
                source=case.guard_source,
            )

        # 3. Классификация
        classification = classify(ClassificationInput(case=case, actual=actual, guard=guard))

        # 4. Формируем expected и actual для отчёта
        actual_state = actual.get("state", "unknown")

        expected = {
            "action": case.expected_action,
            "category": case.expected_category,
            "state": case.expected_state,
            "db_mutations": case.expected_db_mutations,
            "reply_contains": case.expected_reply_contains,
            "guard_source": case.guard_source,
            "requires_remote_guard": case.requires_remote_guard,
        }

        actual_report = {
            "state": actual_state,
            "action": actual.get("action", actual_state),
            "reply": actual.get("reply"),
            "mutation_count": actual.get("mutation_count"),
            "mutations": actual.get("mutations"),
        }

        return CaseVerdict(
            case_id=case.case_id,
            severity=classification.severity,
            expected=expected,
            actual=actual_report,
            guard=guard,
            issues=classification.issues,
            critical=classification.critical,
        )
