"""CLI для guardrail_eval: run и compare."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .comparator import compare_reports
from .report import save_report
from .runner import GuardrailRunner


def _load_json(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def cmd_run(args: argparse.Namespace) -> int:
    runner = GuardrailRunner(
        dataset_path=args.dataset,
        call_guard=args.call_guard,
        guard_url=args.guard_url,
        guard_model=args.guard_model,
    )
    report = asyncio.run(runner.run())
    out_path = args.out or f"reports/guardrail_eval/{report.run_id}.json"
    save_report(report, out_path)
    print(f"Отчёт сохранён: {out_path}")
    print(
        f"all: {report.summary['total']}, ok: {report.summary['ok']}, "
        f"acceptable: {report.summary['acceptable']}, bad: {report.summary['bad']}, "
        f"very_bad: {report.summary['very_bad']}, critical: {report.summary['critical_count']}"
    )
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    before = _load_json(args.before)
    after = _load_json(args.after)
    delta = compare_reports(before, after)

    out_path = args.out or "reports/guardrail_eval/compare_latest.json"
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(delta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Сравнение сохранено: {out_path}")
    print(
        f"Улучшилось: {delta['counts']['improved']}, "
        f"регрессий: {delta['counts']['regressed']}, "
        f"критических регрессий: {delta['counts']['critical_regressions']}, "
        f"без изменений: {delta['counts']['unchanged']}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="guardrail_eval",
        description="Оценка качества гардрейлов Smart Planner",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # run
    p_run = sub.add_parser("run", help="Прогнать датасет и сохранить JSON-отчёт")
    p_run.add_argument("--dataset", required=True, help="Путь к JSONL/JSON датасету")
    p_run.add_argument(
        "--out",
        help="Путь для сохранения отчёта (по умолчанию reports/guardrail_eval/<run_id>.json)",
    )
    p_run.add_argument("--call-guard", action="store_true", help="Вызвать удалённый guard-сервис")
    p_run.add_argument("--guard-url", default="http://localhost:8090", help="URL guard-сервиса")
    p_run.add_argument(
        "--guard-model", default="auren-research/lunaris-guardv3", help="Модель гарда"
    )
    p_run.set_defaults(func=cmd_run)

    # compare
    p_cmp = sub.add_parser("compare", help="Сравнить два JSON-отчёта")
    p_cmp.add_argument("--before", required=True, help="Отчёт до изменений")
    p_cmp.add_argument("--after", required=True, help="Отчёт после изменений")
    p_cmp.add_argument(
        "--out",
        help="Путь для сохранения дельты (по умолчанию reports/guardrail_eval/compare_latest.json)",
    )
    p_cmp.set_defaults(func=cmd_compare)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
