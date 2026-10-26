from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest

from planner import agent
from planner.agent import (
    ContextWindowExceeded,
    TranscriptionError,
    _context_window_exceeded,
    build_system_prompt,
    run_agent,
)
from planner.config import Settings


@pytest.mark.asyncio
async def test_agent_reports_missing_llm_configuration(monkeypatch) -> None:

    from planner.config import Settings

    monkeypatch.setattr(
        agent,
        "get_settings",
        lambda: Settings(_env_file=None, llm_base_url=None, guard_enabled=False),
    )
    result = await run_agent("создай задачу")
    assert result.state == "needs_clarification"
    assert "LLM" in result.result


@pytest.mark.asyncio
async def test_transcribe_omits_authorization_for_empty_api_key(monkeypatch, tmp_path) -> None:
    captured: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"text": "распознано"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **kwargs):
            captured.update(kwargs)
            return FakeResponse()

    settings = SimpleNamespace(
        stt_base_url="http://stt.test/v1",
        stt_api_key="",
        stt_model="gigaam-v3-e2e-rnnt",
    )
    audio_path = tmp_path / "message.webm"
    audio_path.write_bytes(b"audio")
    monkeypatch.setattr(agent, "get_settings", lambda: settings)
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    assert await agent.transcribe(str(audio_path)) == "распознано"
    assert "Authorization" not in captured["headers"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "message"),
    [
        (
            httpx.ConnectError("internal detail"),
            "Не удалось связаться с сервисом распознавания речи. Проверьте, что GigaAM запущен, и попробуйте записать сообщение ещё раз.",
        ),
        (
            httpx.ReadTimeout("internal detail"),
            "Не удалось связаться с сервисом распознавания речи. Проверьте, что GigaAM запущен, и попробуйте записать сообщение ещё раз.",
        ),
    ],
)
async def test_transcribe_maps_connection_failures_to_safe_message(
    monkeypatch, tmp_path, failure, message
) -> None:
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **_kwargs):
            raise failure

    audio_path = tmp_path / "message.webm"
    audio_path.write_bytes(b"audio")
    monkeypatch.setattr(
        agent,
        "get_settings",
        lambda: SimpleNamespace(
            stt_base_url="http://stt.test/v1", stt_api_key="", stt_model="gigaam"
        ),
    )
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    with pytest.raises(TranscriptionError, match="^" + message.replace(".", r"\.") + "$"):
        await agent.transcribe(str(audio_path))


@pytest.mark.asyncio
async def test_transcribe_maps_invalid_response_to_safe_message(monkeypatch, tmp_path) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"unexpected": "shape"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **_kwargs):
            return FakeResponse()

    audio_path = tmp_path / "message.webm"
    audio_path.write_bytes(b"audio")
    monkeypatch.setattr(
        agent,
        "get_settings",
        lambda: SimpleNamespace(
            stt_base_url="http://stt.test/v1", stt_api_key="", stt_model="gigaam"
        ),
    )
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    with pytest.raises(TranscriptionError, match="некорректный ответ"):
        await agent.transcribe(str(audio_path))


@pytest.mark.asyncio
async def test_agent_hides_invalid_model_envelope_details(monkeypatch) -> None:
    async def invalid(*_args, **_kwargs):
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "bad",
                    "type": "function",
                    "function": {
                        "name": "commit_calendar_command",
                        "arguments": '{"reply":"ok","mutations":[{"operation":"create",'
                        '"resource":"task","payload":{"title":null}}]}',
                    },
                }
            ],
        }

    monkeypatch.setattr(agent, "_complete_react", invalid)
    result = await run_agent("создай задачу")
    assert result.state == "failed"
    assert "Переформулируйте" in result.result
    assert "title" not in result.result
    assert "ValidationError" not in result.result


@pytest.mark.asyncio
async def test_system_prompt_contains_local_clock_and_timezone() -> None:
    local_now = datetime(2026, 10, 14, 19, 30, tzinfo=ZoneInfo("Europe/Moscow"))
    prompt = await build_system_prompt(local_now, "Europe/Moscow")
    assert "2026-10-14T19:30:00+03:00" in prompt
    assert "Europe/Moscow" in prompt
    assert "absolute ISO-8601" in prompt
    assert "list_tasks, list_events, and list_reminders" in prompt
    assert "time_range" in prompt
    assert "complete resulting title" in prompt
    assert "preserve every unrequested part" in prompt
    assert "non-empty reply" in prompt


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

    monkeypatch.setattr(agent, "_complete_react", overflow)
    result = await run_agent("продолжим")
    payload = __import__("json").loads(result.result)
    assert result.state == "needs_clarification"
    assert payload["requires_new_conversation"] is True
    assert "новый диалог" in payload["reply"].lower()
