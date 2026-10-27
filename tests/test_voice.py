import uuid
from datetime import UTC, datetime

import pytest

from planner import main
from planner.models import AgentMessage, User
from planner.schemas import UserPreferencesUpdate
from planner.voice import (
    HandsFreeProtocolError,
    VoiceConversation,
    format_speech_text,
    split_speech_text,
)


def test_speech_formatter_uses_structured_calendar_data_and_omits_details() -> None:
    speech = format_speech_text(
        operations=[
            {
                "operation": "create",
                "resource": "event",
                "after": {
                    "title": "Встреча с Денисом",
                    "starts_at": "2026-10-22T09:30:00Z",
                    "description": "Секретное длинное описание",
                    "location": "Центр",
                    "duration_minutes": 120,
                },
            },
            {
                "operation": "delete",
                "resource": "task",
                "before": {"title": "Купить хлеб", "deadline": None},
            },
        ],
        display_items=[],
        timezone="Europe/Moscow",
    )

    assert speech == (
        "Создано событие «Встреча с Денисом»: четверг, 22 октября 2026 года, 12:30. "
        "Удалена задача «Купить хлеб»: без срока."
    )
    assert "Секретное" not in speech
    assert "Центр" not in speech
    assert "120" not in speech


def test_speech_formatter_reads_all_items_in_order_and_marks_missing_event_time() -> None:
    speech = format_speech_text(
        operations=[],
        display_items=[
            {
                "resource": "task",
                "id": str(uuid.uuid4()),
                "data": {
                    "title": "Отчёт",
                    "deadline": "2026-10-23T15:00:00Z",
                },
            },
            {
                "resource": "event",
                "id": str(uuid.uuid4()),
                "data": {"title": "Встреча без даты"},
            },
        ],
        timezone="Europe/Moscow",
    )

    assert speech == (
        "Задача «Отчёт»: пятница, 23 октября 2026 года, 18:00. "
        "Событие «Встреча без даты»: время не указано."
    )


def test_speech_text_is_split_at_sentence_and_safe_boundaries() -> None:
    assert split_speech_text("Первая фраза. Вторая фраза! Третья?") == [
        "Первая фраза.",
        "Вторая фраза!",
        "Третья?",
    ]
    chunks = split_speech_text("слово " * 100, max_chars=80)
    assert chunks
    assert all(len(chunk) <= 80 for chunk in chunks)
    assert " ".join(chunks).replace("  ", " ").strip() == ("слово " * 100).strip()


@pytest.mark.parametrize("voice", ["aidar", "baya", "kseniya", "xenia", "eugene"])
def test_voice_preferences_accept_supported_voices(voice: str) -> None:
    assert UserPreferencesUpdate(tts_voice=voice).tts_voice == voice


@pytest.mark.parametrize("speed", [0.74, 1.51])
def test_voice_preferences_reject_speed_outside_range(speed: float) -> None:
    with pytest.raises(ValueError):
        UserPreferencesUpdate(tts_speed=speed)


def test_hands_free_requires_wake_once_then_accepts_follow_up_and_stop() -> None:
    conversation = VoiceConversation(active=False)

    assert conversation.accept_transcript("разговор рядом") is None
    assert conversation.accept_transcript("Айвори") is None
    assert conversation.accept_transcript("Вику") is None
    assert conversation.accept_transcript("Вика") == ""
    assert conversation.active is True
    assert conversation.accept_transcript("создай задачу") == "создай задачу"
    assert conversation.accept_transcript("Vika, закончи диалог") is None
    assert conversation.active is False


def test_hands_free_requires_a_pause_after_wake_word() -> None:
    conversation = VoiceConversation(active=False)

    assert conversation.accept_transcript("Вика, создай задачу слишком рано") == ""
    assert conversation.active is True
    assert conversation.accept_transcript("создай задачу после сигнала") == (
        "создай задачу после сигнала"
    )


def test_hands_free_direct_activation_and_single_inflight_turn() -> None:
    conversation = VoiceConversation(active=False)
    conversation.activate()
    assert conversation.accept_transcript("покажи завтра") == "покажи завтра"
    conversation.start_turn()
    with pytest.raises(HandsFreeProtocolError, match="in progress"):
        conversation.start_turn()
    conversation.finish_turn()
    conversation.start_turn()


def test_pcm_limits_are_enforced() -> None:
    conversation = VoiceConversation(max_pcm_bytes=8, max_duration_seconds=1)
    conversation.begin_utterance(sample_rate=16_000)
    conversation.add_pcm(b"12345678")
    with pytest.raises(HandsFreeProtocolError, match="too large"):
        conversation.add_pcm(b"9")


def test_voice_session_ticket_contract_is_exposed() -> None:
    from planner.main import app

    routes = {
        (route.path, method)
        for route in app.routes
        for method in (getattr(route, "methods", ()) or ())
    }
    assert ("/voice/capabilities", "GET") in routes
    assert ("/voice/session-tickets", "POST") in routes
    assert any(route.path == "/voice/session" for route in app.routes)


def test_formatter_accepts_datetime_values() -> None:
    speech = format_speech_text(
        operations=[],
        display_items=[
            {
                "resource": "event",
                "data": {
                    "title": "UTC",
                    "starts_at": datetime(2026, 10, 21, 12, tzinfo=UTC),
                },
            }
        ],
        timezone="UTC",
    )
    assert "среда, 21 октября 2026 года, 12:00" in speech


@pytest.mark.asyncio
async def test_voice_ticket_is_owner_scoped_and_single_use(monkeypatch) -> None:
    values = {}

    class FakeRedis:
        async def setex(self, key, _ttl, value):
            values[key] = value

        async def execute_command(self, command, key):
            assert command == "GETDEL"
            return values.pop(key, None)

        async def close(self):
            return None

    monkeypatch.setattr(main, "_redis_pool", lambda: _async_value(FakeRedis()))
    owner = User(id=uuid.uuid4(), email="voice@example.test", password_hash="x")

    issued = await main.create_voice_session_ticket(user=owner)
    assert await main._consume_voice_ticket(issued["ticket"]) == owner.id
    assert await main._consume_voice_ticket(issued["ticket"]) is None


async def _async_value(value):
    return value


@pytest.mark.asyncio
async def test_tts_failure_is_reported_without_failing_message(monkeypatch) -> None:
    class FakeSocket:
        def __init__(self):
            self.events = []

        async def send_json(self, value):
            self.events.append(value)

        async def send_bytes(self, value):
            raise AssertionError("no audio should be sent")

    async def unavailable(*_args, **_kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(main, "_tts_audio", unavailable)
    socket = FakeSocket()
    user = User(
        id=uuid.uuid4(),
        email="tts@example.test",
        password_hash="x",
        voice_output_enabled=True,
        tts_voice="kseniya",
        tts_speed=1.0,
    )
    message = AgentMessage(id=uuid.uuid4(), speech_text="Готово.")

    assert await main._send_tts(socket, user, message) is False

    assert socket.events == [
        {"type": "tts_unavailable", "message": "Голосовой вывод временно недоступен"}
    ]


@pytest.mark.asyncio
async def test_disabled_tts_emits_one_playback_decision() -> None:
    class FakeSocket:
        def __init__(self):
            self.events = []

        async def send_json(self, value):
            self.events.append(value)

    socket = FakeSocket()
    user = User(
        id=uuid.uuid4(),
        email="silent@example.test",
        password_hash="x",
        voice_output_enabled=False,
    )
    message = AgentMessage(id=uuid.uuid4(), speech_text="Готово.")

    await main._finish_tts(socket, user, message)

    assert socket.events == [{"type": "playback_skipped"}]
