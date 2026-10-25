"""Unit-тесты для загрузчика датасета (guardrail_eval.loader)."""

import json
from pathlib import Path

import pytest

from guardrail_eval.loader import dataset_hash, load_dataset


def _write_jsonl(tmp_path: Path, records: list[dict]) -> Path:
    p = tmp_path / "test.jsonl"
    with open(p, "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    return p


def test_load_jsonl_valid(tmp_path):
    records = [
        {
            "case_id": "case_1",
            "user_input": "создай задачу",
            "llm_response_type": "tool_calls",
            "llm_responses": [],
            "expected_action": "allow",
            "expected_category": "none",
            "expected_state": "completed",
            "expected_db_mutations": 1,
            "expected_reply_contains": None,
            "guard_source": "user_input",
            "requires_remote_guard": False,
        }
    ]
    path = _write_jsonl(tmp_path, records)
    cases = load_dataset(path)
    assert len(cases) == 1
    assert cases[0].case_id == "case_1"
    assert cases[0].user_input == "создай задачу"
    assert cases[0].expected_action == "allow"
    assert cases[0].requires_remote_guard is False


def test_load_jsonl_missing_required(tmp_path):
    records = [
        {
            "case_id": "case_1",
            "user_input": "создай задачу",
            # отсутствует expected_action
        }
    ]
    path = _write_jsonl(tmp_path, records)
    with pytest.raises(ValueError, match="missing required fields"):
        load_dataset(path)


def test_load_json_array(tmp_path):
    records = [
        {
            "case_id": "case_1",
            "user_input": "test",
            "llm_response_type": "api_validation",
            "llm_responses": [],
            "expected_action": "refuse",
            "expected_category": "input_validation",
            "expected_state": "failed",
            "expected_db_mutations": 0,
            "expected_reply_contains": None,
            "guard_source": "user_input",
            "requires_remote_guard": False,
        }
    ]
    path = tmp_path / "test.json"
    path.write_text(json.dumps(records), encoding="utf-8")
    cases = load_dataset(path)
    assert len(cases) == 1
    assert cases[0].llm_response_type == "api_validation"


def test_load_jsonl_empty_file(tmp_path):
    path = tmp_path / "empty.jsonl"
    path.write_text("", encoding="utf-8")
    cases = load_dataset(path)
    assert cases == []


def test_dataset_hash_deterministic(tmp_path):
    path = tmp_path / "h.jsonl"
    path.write_text('{"case_id": "x"}', encoding="utf-8")
    h1 = dataset_hash(path)
    h2 = dataset_hash(path)
    assert h1 == h2
    assert len(h1) == 16


def test_defaults_applied(tmp_path):
    """Опциональные поля должны получить значения по умолчанию."""
    records = [
        {
            "case_id": "case_1",
            "user_input": "test",
            "llm_response_type": "tool_calls",
            "expected_action": "allow",
            "expected_category": "none",
            "expected_state": "completed",
            "expected_db_mutations": 0,
            "guard_source": "user_input",
            "requires_remote_guard": False,
        }
    ]
    path = _write_jsonl(tmp_path, records)
    cases = load_dataset(path)
    assert cases[0].llm_responses == []
    assert cases[0].expected_reply_contains is None
