"""Сравнение двух JSON-отчётов (до/после) с вычислением дельты."""

from __future__ import annotations

from typing import Any

SEVERITY_ORDER = {"ok": 0, "acceptable": 1, "bad": 2, "very_bad": 3}


def compare_reports(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Сравнивает два отчёта и возвращает дельту в формате JSON.

    Возвращает:
    - summary_delta: изменение общих метрик.
    - case_deltas: по каждому case_id — changed/unchanged, before_severity, after_severity.
    - improvements: кейсы, которые стали лучше (bad/very_bad -> ok/acceptable).
    - regressions: кейсы, которые стали хуже (ok/acceptable -> bad/very_bad).
    - critical_regressions: кейсы, ставшие very_bad из ok/acceptable.
    - unchanged: кейсы без изменений.
    """
    if before.get("mode", "mock") != after.get("mode", "mock"):
        raise ValueError("Cannot compare mock and live reports")
    if not before.get("complete", True) or not after.get("complete", True):
        raise ValueError("Cannot compare incomplete evaluation reports")
    before_cases = {c["case_id"]: c for c in before.get("cases", [])}
    after_cases = {c["case_id"]: c for c in after.get("cases", [])}

    all_case_ids = set(before_cases) | set(after_cases)

    improvements: list[dict[str, Any]] = []
    regressions: list[dict[str, Any]] = []
    critical_regressions: list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []
    behavior_changes: list[dict[str, Any]] = []
    case_deltas: list[dict[str, Any]] = []

    for case_id in sorted(all_case_ids):
        b = before_cases.get(case_id)
        a = after_cases.get(case_id)

        if b is None:
            # Новый кейс в after
            case_deltas.append(
                {
                    "case_id": case_id,
                    "status": "new",
                    "before_severity": None,
                    "after_severity": a["severity"] if a else None,
                }
            )
            if a and a["severity"] in ("bad", "very_bad"):
                regressions.append(
                    {
                        "case_id": case_id,
                        "change": "new_bad",
                        "after_severity": a["severity"],
                        "category": a.get("expected", {}).get("category"),
                    }
                )
            continue

        if a is None:
            # ーケс удалён из after
            case_deltas.append(
                {
                    "case_id": case_id,
                    "status": "removed",
                    "before_severity": b["severity"],
                    "after_severity": None,
                }
            )
            continue

        b_sev = b["severity"]
        a_sev = a["severity"]

        changed_fields = [
            key
            for key in ("actual", "guard", "issues")
            if _behavior(b.get(key), key) != _behavior(a.get(key), key)
        ]
        if b_sev == a_sev and changed_fields:
            change = {
                "case_id": case_id,
                "status": "behavior_changed",
                "before_severity": b_sev,
                "after_severity": a_sev,
                "changed_fields": changed_fields,
                "before": b,
                "after": a,
            }
            behavior_changes.append(change)
            case_deltas.append(change)
            continue
        if b_sev == a_sev:
            unchanged.append({"case_id": case_id, "severity": b_sev})
            case_deltas.append(
                {
                    "case_id": case_id,
                    "status": "unchanged",
                    "before_severity": b_sev,
                    "after_severity": a_sev,
                }
            )
            continue

        # Есть изменение
        b_rank = SEVERITY_ORDER.get(b_sev, 99)
        a_rank = SEVERITY_ORDER.get(a_sev, 99)

        case_deltas.append(
            {
                "case_id": case_id,
                "status": "changed",
                "before_severity": b_sev,
                "after_severity": a_sev,
            }
        )

        if a_rank < b_rank:
            # Стало лучше
            improvements.append(
                {
                    "case_id": case_id,
                    "change": f"{b_sev} -> {a_sev}",
                    "before_severity": b_sev,
                    "after_severity": a_sev,
                    "category": a.get("expected", {}).get("category"),
                }
            )
        else:
            # Стало хуже
            regressions.append(
                {
                    "case_id": case_id,
                    "change": f"{b_sev} -> {a_sev}",
                    "before_severity": b_sev,
                    "after_severity": a_sev,
                    "category": a.get("expected", {}).get("category"),
                }
            )
            if a_sev == "very_bad" and b_sev in ("ok", "acceptable"):
                critical_regressions.append(
                    {
                        "case_id": case_id,
                        "change": f"{b_sev} -> very_bad",
                        "before_severity": b_sev,
                        "after_severity": a_sev,
                        "category": a.get("expected", {}).get("category"),
                        "issues": a.get("issues", []),
                    }
                )

    # Дельта summary
    before_summary = before.get("summary", {})
    after_summary = after.get("summary", {})

    summary_delta = {}
    for key in (
        "total",
        "ok",
        "acceptable",
        "bad",
        "very_bad",
        "false_positive_count",
        "false_negative_count",
        "guard_mismatch_count",
        "critical_count",
    ):
        b_val = before_summary.get(key, 0)
        a_val = after_summary.get(key, 0)
        summary_delta[key] = {"before": b_val, "after": a_val, "delta": a_val - b_val}

    before_rate = before_summary.get("agent_adequacy_rate", 0.0)
    after_rate = after_summary.get("agent_adequacy_rate", 0.0)
    summary_delta["agent_adequacy_rate"] = {
        "before": before_rate,
        "after": after_rate,
        "delta": round(after_rate - before_rate, 4),
    }

    return {
        "summary_delta": summary_delta,
        "case_deltas": case_deltas,
        "behavior_changes": behavior_changes,
        "improvements": improvements,
        "regressions": regressions,
        "critical_regressions": critical_regressions,
        "unchanged": unchanged,
        "counts": {
            "improved": len(improvements),
            "regressed": len(regressions),
            "critical_regressions": len(critical_regressions),
            "unchanged": len(unchanged),
            "behavior_changed": len(behavior_changes),
            "new": len([d for d in case_deltas if d["status"] == "new"]),
            "removed": len([d for d in case_deltas if d["status"] == "removed"]),
        },
    }


def _behavior(value: Any, key: str) -> Any:
    if not isinstance(value, dict):
        return value
    if key == "guard":
        return {k: value.get(k) for k in ("action", "label", "status", "source")}
    if key == "actual":
        stable = {k: value.get(k) for k in ("state", "action", "reply", "mutation_count")}
        stable["mutations"] = _without_generated_fields(value.get("mutations", []))
        return stable
    return value


def _without_generated_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_generated_fields(item)
            for key, item in value.items()
            if key not in {"id", "target_id", "owner_id", "created_at", "updated_at"}
        }
    if isinstance(value, list):
        return [_without_generated_fields(item) for item in value]
    return value
