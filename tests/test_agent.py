from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from planner import agent
from planner.agent import (
    ContextWindowExceeded,
    LLMProtocolError,
    _context_window_exceeded,
    _response_content,
    build_system_prompt,
    parse_decision,
    run_agent,
)


@pytest.mark.asyncio
async def test_agent_reports_missing_llm_configuration(monkeypatch) -> None:
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    result = await run_agent("создай задачу")
    assert result.state == "needs_clarification"
    assert "LLM" in result.result


def test_decision_envelope_rejects_free_text() -> None:
    with pytest.raises(ValueError, match="invalid JSON"):
        parse_decision("создам задачу")


def test_decision_envelope_requires_target_for_update() -> None:
    raw = '{"reply":"ok","reads":[],"mutations":[{"operation":"update","resource":"task","payload":{"title":"x"}}],"clarification":null}'
    with pytest.raises(ValueError):
        parse_decision(raw)


def test_decision_envelope_accepts_read_and_create() -> None:
    raw = '{"reply":"ok","reads":[{"operation":"list","resource":"task"}],"mutations":[{"operation":"create","resource":"task","payload":{"title":"x"}}],"clarification":null}'
    decision = parse_decision(raw)
    assert decision.reads[0].operation == "list"
    assert decision.mutations[0].operation == "create"


def test_decision_envelope_rejects_wrong_event_datetime_field() -> None:
    raw = '{"reply":"ok","reads":[],"mutations":[{"operation":"create","resource":"event","payload":{"title":"Встреча","start":"2026-10-15T13:00:00+03:00"}}],"clarification":null}'
    with pytest.raises(ValueError):
        parse_decision(raw)


def test_decision_envelope_accepts_strict_event_payload() -> None:
    raw = '{"reply":"ok","reads":[],"mutations":[{"operation":"create","resource":"event","payload":{"title":"Встреча","starts_at":"2026-10-15T13:00:00+03:00"}}],"clarification":null}'
    decision = parse_decision(raw)
    assert decision.mutations[0].payload.starts_at.isoformat() == "2026-10-15T13:00:00+03:00"


def test_decision_envelope_requires_empty_delete_payload() -> None:
    raw = '{"reply":"ok","reads":[],"mutations":[{"operation":"delete","resource":"task","target_id":"4a5b8f1d-4625-4deb-a672-49b9de7b8221","payload":{"title":"x"}}],"clarification":null}'
    with pytest.raises(ValueError):
        parse_decision(raw)


def test_system_prompt_contains_local_clock_and_timezone() -> None:
    local_now = datetime(2026, 10, 14, 19, 30, tzinfo=ZoneInfo("Europe/Moscow"))
    prompt = build_system_prompt(local_now, "Europe/Moscow")
    assert "2026-10-14T19:30:00+03:00" in prompt
    assert "Europe/Moscow" in prompt
    assert "absolute ISO-8601" in prompt


def test_empty_content_does_not_fall_back_to_reasoning() -> None:
    body = {"choices": [{"message": {"content": "", "reasoning_content": '{"reply":"unsafe"}'}}]}
    with pytest.raises(LLMProtocolError, match="reasoning_content was returned instead"):
        _response_content(body)


def test_lm_studio_context_error_is_detected() -> None:
    response = httpx.Response(
        400,
        text="The prompt exceeds the maximum context length",
        request=httpx.Request("POST", "http://lm.test/v1/chat/completions"),
    )
    assert _context_window_exceeded(response) is True


@pytest.mark.asyncio
async def test_context_overflow_requests_a_new_conversation(monkeypatch) -> None:
    async def overflow(*_args, **_kwargs):
        raise ContextWindowExceeded("context window exceeded")

    monkeypatch.setattr(agent, "_complete", overflow)
    result = await run_agent("продолжим")
    payload = __import__("json").loads(result.result)
    assert result.state == "needs_clarification"
    assert payload["requires_new_conversation"] is True
    assert "новый диалог" in payload["reply"].lower()
