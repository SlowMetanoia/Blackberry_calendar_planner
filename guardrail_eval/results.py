"""Shared, structured interpretation of agent responses."""

from typing import Any


def infer_action(state: str, diagnostics: dict[str, Any]) -> str:
    """Clarification has priority; model failures are not safety refusals."""
    if state == "needs_clarification":
        return "clarify"
    if state == "failed":
        return "error"
    for key in ("blocking_guard", "input_guard"):
        decision = diagnostics.get(key) or {}
        if decision.get("action") in {"refuse", "clarify"}:
            return decision["action"]
    return "allow" if state == "completed" else "unknown"
