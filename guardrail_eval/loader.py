"""Загрузчик и валидатор датасета оценки гардрейлов (JSON/JSONL)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .models import EvalCase

REQUIRED_FIELDS = (
    "case_id",
    "user_input",
    "llm_response_type",
    "expected_action",
    "expected_category",
    "expected_state",
    "expected_db_mutations",
    "guard_source",
    "requires_remote_guard",
)

OPTIONAL_FIELDS_WITH_DEFAULTS = {
    "llm_responses": [],
    "expected_reply_contains": None,
    "raw": {},
}


def load_dataset(path: str | Path) -> list[EvalCase]:
    """Загружает датасет из JSONL или JSON файла.

    Поддерживает:
    - JSONL: по одной JSON-строке на линию.
    - JSON: массив объектов или один объект.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")

    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    # Пытаемся распарсить как JSON (массив или один объект)
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            records = [data]
        elif isinstance(data, list):
            records = data
        else:
            raise TypeError(f"Unexpected JSON root type: {type(data)}")
    except json.JSONDecodeError:
        # П fallback: JSONL
        records = []
        for line in text.splitlines():
            line = line.strip()
            if line:
                records.append(json.loads(line))

    cases: list[EvalCase] = []
    for idx, record in enumerate(records):
        case = _validate_and_build(record, path, idx)
        cases.append(case)

    return cases


def _validate_and_build(record: dict[str, Any], path: Path, idx: int) -> EvalCase:
    missing = [f for f in REQUIRED_FIELDS if f not in record]
    if missing:
        raise ValueError(f"{path}:{idx + 1}: missing required fields: {missing}")

    # Применяем значения по умолчанию для опциональных полей
    for field_name, default in OPTIONAL_FIELDS_WITH_DEFAULTS.items():
        record.setdefault(field_name, default)

    raw = dict(record)
    case_id = str(record["case_id"])

    return EvalCase(
        case_id=case_id,
        user_input=str(record["user_input"]),
        llm_response_type=str(record["llm_response_type"]),
        llm_responses=list(record.get("llm_responses") or []),
        expected_action=str(record["expected_action"]),
        expected_category=str(record["expected_category"]),
        expected_state=str(record["expected_state"]),
        expected_db_mutations=int(record["expected_db_mutations"]),
        expected_reply_contains=record.get("expected_reply_contains"),
        guard_source=str(record["guard_source"]),
        requires_remote_guard=bool(record["requires_remote_guard"]),
        raw=raw,
    )


def dataset_hash(path: str | Path) -> str:
    """Возвращает SHA-256 хеш файла датасета для идентификации версии."""
    path = Path(path)
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()[:16]
