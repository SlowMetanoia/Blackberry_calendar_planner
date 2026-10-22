"""Инструмент анализа гардрейлов по датасету.

Сравнивает результаты текущего прогона с базлайном и считает проценты:
- общий проход (pass rate),
- защита по категориям атак,
- регрессии (было PASS, стало FAIL/SKIP),
- ложные срабатывания (ожидался allow, получено refuse/clarify).

Использование:
    python tests/analyze_guardrail.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

BASELINE_PATH = Path(__file__).parent / "data" / "guardrail_runs" / "run_baseline.json"
CASES_PATH = Path(__file__).parent / "data" / "guardrail_cases.jsonl"
TEST_PATH = Path(__file__).parent / "test_guardrail_text.py"


def load_cases() -> list[dict]:
    cases: list[dict] = []
    for line in CASES_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            cases.append(json.loads(line))
    return cases


def load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def run_pytest() -> tuple[dict[str, str], int]:
    """Запускает pytest и возвращает mapping test_node_id -> status plus returncode."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(TEST_PATH), "-v", "--tb=no", "-p", "no:cacheprovider"],
        check=False,
        capture_output=True,
        text=True,
    )
    statuses: dict[str, str] = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if "::" in line and (" PASSED " in line or " FAILED " in line or " SKIPPED " in line):
            parts = line.split()
            if len(parts) >= 2:
                node_id = parts[0]
                # Убираем префикс файла: tests/test_guardrail_text.py::test_... -> test_...
                if "::" in node_id:
                    node_id = node_id.split("::", 1)[1]
                status = parts[1].upper()
                statuses[node_id] = status
    return statuses, result.returncode


def analyze(current: dict[str, str], baseline: dict, cases: list[dict]) -> dict:
    baseline_results = baseline.get("results", {})

    total = 0
    passed = 0
    failed = 0
    skipped = 0

    regressions: list[dict] = []
    false_positives: list[dict] = []
    category_stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "passed": 0, "failed": 0, "skipped": 0}
    )

    for case in cases:
        case_id = case["case_id"]
        category = case.get("expected_category", "none")
        expected_action = case.get("expected_action", "allow")

        test_ids = [
            f"test_classify_direct[{case_id}]",
            f"test_run_agent_guardrail[{case_id}]",
        ]

        for test_id in test_ids:
            total += 1
            cat_stats = category_stats[category]
            cat_stats["total"] += 1

            cur_status = current.get(test_id, "UNKNOWN")
            base_status = baseline_results.get(test_id, "UNKNOWN")

            if cur_status == "PASSED":
                passed += 1
                cat_stats["passed"] += 1
            elif cur_status == "SKIPPED":
                skipped += 1
                cat_stats["skipped"] += 1
            else:
                failed += 1
                cat_stats["failed"] += 1

            if base_status == "PASS" and cur_status != "PASSED":
                regressions.append(
                    {
                        "test_id": test_id,
                        "case_id": case_id,
                        "category": category,
                        "baseline": base_status,
                        "current": cur_status,
                    }
                )

            if expected_action == "allow" and cur_status not in ("PASSED", "SKIPPED"):
                false_positives.append(
                    {
                        "test_id": test_id,
                        "case_id": case_id,
                        "category": category,
                        "current": cur_status,
                    }
                )

    pass_rate = (passed / total * 100) if total else 0.0
    fail_rate = (failed / total * 100) if total else 0.0
    skip_rate = (skipped / total * 100) if total else 0.0
    regression_rate = (len(regressions) / total * 100) if total else 0.0

    category_report = {}
    for cat, stats in sorted(category_stats.items()):
        cat_pass_rate = (stats["passed"] / stats["total"] * 100) if stats["total"] else 0.0
        category_report[cat] = {
            **stats,
            "pass_rate_percent": round(cat_pass_rate, 1),
        }

    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "pass_rate_percent": round(pass_rate, 1),
        "fail_rate_percent": round(fail_rate, 1),
        "skip_rate_percent": round(skip_rate, 1),
        "regression_count": len(regressions),
        "regression_rate_percent": round(regression_rate, 1),
        "false_positive_count": len(false_positives),
        "regressions": regressions,
        "false_positives": false_positives,
        "by_category": category_report,
    }


def print_report(report: dict) -> None:
    print("=" * 60)
    print("АНАЛИЗ ГАРДРЕЙЛОВ ПО ДАТАСЕТУ")
    print("=" * 60)
    print(f"Всего кейсов:      {report['total']}")
    print(f"  Прошли:          {report['passed']}  ({report['pass_rate_percent']}%)")
    print(f"  Упали:           {report['failed']}  ({report['fail_rate_percent']}%)")
    print(f"  Пропущены:       {report['skipped']}  ({report['skip_rate_percent']}%)")
    print(
        f"  Регрессии:       {report['regression_count']}  ({report['regression_rate_percent']}%)"
    )
    print(f"  Ложные срабатыв.: {report['false_positive_count']}")
    print()

    print("--- ПО КАТЕГОРИЯМ ---")
    for cat, stats in report["by_category"].items():
        print(
            f"  {cat:20s} passed={stats['passed']:3d}/{stats['total']:3d} "
            f"({stats['pass_rate_percent']}%) "
            f"failed={stats['failed']} skipped={stats['skipped']}"
        )
    print()

    if report["regressions"]:
        print("--- РЕГРЕССИИ (было PASS в базовой, стало не-PASS) ---")
        for r in report["regressions"]:
            print(f"  {r['test_id']}: {r['baseline']} -> {r['current']} [{r['category']}]")
        print()

    if report["false_positives"]:
        print("--- ЛОЖНЫЕ СРАБАТЫВАНИЯ (ожидался allow, но тест упал) ---")
        for fp in report["false_positives"]:
            print(f"  {fp['test_id']}: {fp['current']} [{fp['category']}]")
        print()

    print("=" * 60)


def main() -> None:
    cases = load_cases()
    baseline = load_baseline()

    current, _returncode = run_pytest()

    if not current:
        print("Не удалось получить результаты pytest. Проверьте, что зависимости установлены.")
        sys.exit(1)

    report = analyze(current, baseline, cases)
    print_report(report)

    sys.exit(0 if report["failed"] == 0 and report["regression_count"] == 0 else 1)


if __name__ == "__main__":
    main()
