"""Run deterministic or HTTP-backed evaluations and build comparable reports."""

from __future__ import annotations

from .adapters import AgentRunAdapter
from .classifier import ClassificationInput, classify
from .guard_client import GuardClient
from .live import LiveAgentAdapter, LiveEvaluationError
from .loader import load_dataset
from .models import CaseVerdict, EvalCase, GuardResult, TestResult
from .report import build_report, new_run_id, now_iso


class GuardrailRunner:
    def __init__(
        self,
        dataset_path: str,
        call_guard: bool = False,
        guard_url: str = "http://localhost:8090",
        guard_model: str = "auren-research/lunaris-guardv3",
        *,
        live: bool = False,
        api_url: str = "http://localhost:8000",
        case_timeout: float = 180,
        poll_interval: float = 0.5,
        case_ids: list[str] | None = None,
    ) -> None:
        if live and call_guard:
            raise ValueError(
                "--live uses the application's guard; do not combine with --call-guard"
            )
        self.dataset_path = dataset_path
        self.call_guard = call_guard
        self.guard_model = guard_model
        self.live = live
        self.api_url = api_url
        self.case_timeout = case_timeout
        self.poll_interval = poll_interval
        self.case_ids = case_ids
        self._guard_client = GuardClient(base_url=guard_url, model=guard_model)

    async def run(self) -> TestResult:
        cases = load_dataset(self.dataset_path)
        if self.case_ids:
            missing = set(self.case_ids) - {case.case_id for case in cases}
            if missing:
                raise ValueError(f"Unknown case IDs: {', '.join(sorted(missing))}")
            cases = [case for case in cases if case.case_id in self.case_ids]
        if not cases:
            raise ValueError("Dataset/selection contains no cases")
        skipped = []
        if self.live:
            skipped = [
                {
                    "case_id": case.case_id,
                    "reason": case.raw.get("live_skip_reason", "mock-only case"),
                }
                for case in cases
                if case.raw.get("live") is False
            ]
            cases = [case for case in cases if case.raw.get("live") is not False]
        verdicts: list[CaseVerdict] = []
        run_error = None
        adapter = (
            LiveAgentAdapter(
                self.api_url, case_timeout=self.case_timeout, poll_interval=self.poll_interval
            )
            if self.live
            else AgentRunAdapter()
        )
        try:
            async with adapter:
                for case in cases:
                    print(f"[{len(verdicts) + 1}/{len(cases)}] {case.case_id}", flush=True)
                    verdicts.append(await self._evaluate_one(adapter, case))
        except LiveEvaluationError as exc:
            failed_case = cases[len(verdicts)].case_id if len(verdicts) < len(cases) else None
            run_error = f"{failed_case or 'startup'}: {exc}"
        diagnostics = next(
            (v.actual.get("diagnostics", {}) for v in verdicts if v.actual.get("diagnostics")), {}
        )
        report = build_report(
            run_id=new_run_id(),
            timestamp=now_iso(),
            dataset_path=self.dataset_path,
            cases=verdicts,
            guard_model=diagnostics.get("guard_model", self.guard_model),
            guard_enabled=bool(diagnostics.get("guard_enabled", self.call_guard)),
        )
        report.mode = "live" if self.live else "mock"
        report.complete = run_error is None and bool(verdicts)
        report.run_error = run_error or ("No executable cases" if not verdicts else None)
        report.skipped_cases = skipped
        report.metadata = {
            "api_url": self.api_url if self.live else None,
            "llm_model": diagnostics.get("llm_model"),
            "requested_cases": len(cases) + len(skipped),
            "evaluated_cases": len(verdicts),
            "case_timeout_seconds": self.case_timeout if self.live else None,
        }
        return report

    async def _evaluate_one(
        self,
        adapter: AgentRunAdapter | LiveAgentAdapter,
        case: EvalCase,
    ) -> CaseVerdict:
        if self.live:
            actual = await adapter.run_case(case)
        else:
            actual = await adapter.run(case.user_input, case.llm_response_type, case.llm_responses)
        diagnostics = actual.get("diagnostics", {})
        decision = diagnostics.get("input_guard") or {}
        if case.guard_source == "mutation_payload":
            decision = diagnostics.get("blocking_guard") or {}
        guard = GuardResult(
            action=decision.get("action"),
            label=decision.get("category"),
            score=decision.get("score", 0),
            reason=decision.get("reason", ""),
            source=decision.get("source", case.guard_source),
            status="ok" if decision else "unavailable",
        )
        if not self.live and (self.call_guard or case.requires_remote_guard):
            remote = await self._guard_client.classify(case.user_input, case.guard_source)
            guard = GuardResult(**remote, source=case.guard_source)
        classification = classify(ClassificationInput(case=case, actual=actual, guard=guard))
        if (self.call_guard or case.requires_remote_guard) and guard.status != "ok":
            raise LiveEvaluationError(f"Required guard is unavailable for {case.case_id}")
        expected = {
            "action": case.expected_action,
            "category": case.expected_category,
            "state": case.expected_state,
            "db_mutations": case.expected_db_mutations,
            "reply_contains": case.expected_reply_contains,
            "guard_source": case.guard_source,
            "requires_remote_guard": case.requires_remote_guard,
            "mutations": case.raw.get("expected_mutations"),
        }
        return CaseVerdict(
            case_id=case.case_id,
            severity=classification.severity,
            expected=expected,
            actual=actual,
            guard=guard,
            issues=classification.issues,
            critical=classification.critical,
        )
