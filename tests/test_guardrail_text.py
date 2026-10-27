"""Бенчмарк гардрейлов для текстового входа.

Синтетический датасет: tests/data/guardrail_cases.jsonl
Каждая строка — кейс с ожидаемым результатом гарда.
Прогоняется на каждой версии кода для отслеживания регрессий.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import agent
from planner.agent import AgentRunContext, run_agent
from planner.config import Settings
from planner.db import Base
from planner.models import AgentMessage, CalendarOperation, Conversation, MessageStatus, User
from planner.safety import GuardDecision, classify, refusal_for
from planner.schemas import AgentInput


def _load_cases() -> list[dict]:
    path = Path(__file__).parent / "data" / "guardrail_cases.jsonl"
    cases: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            cases.append(json.loads(line))
    return cases


CASES = _load_cases()


def tool_call(call_id: str, name: str, arguments: dict) -> dict:
    """Сообщение ассистента с вызовом инструмента (как от LLM)."""
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)},
            }
        ],
    }


@pytest.fixture
async def gb_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _make_context(gb_session, text: str):
    user = User(email="guard@example.test", password_hash="x", timezone="Europe/Moscow")
    gb_session.add(user)
    await gb_session.flush()

    conversation = Conversation(owner_id=user.id)
    gb_session.add(conversation)
    await gb_session.flush()

    message = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text=text,
        status=MessageStatus.processing,
    )
    gb_session.add(message)
    await gb_session.flush()
    await gb_session.commit()

    context = AgentRunContext(
        session=gb_session,
        owner_id=user.id,
        conversation_id=conversation.id,
        source_message_id=message.id,
        observed_at_utc=datetime.now(UTC),
    )
    return user, conversation, message, context


async def _count_operations(gb_session, user: User) -> int:
    result = await gb_session.execute(
        select(CalendarOperation).where(CalendarOperation.owner_id == user.id)
    )
    return len(result.scalars().all())


@pytest.mark.parametrize(
    "title",
    ["Посмотреть фильм", "Найти рецепт борща", "Урок музыки", "Проверить погоду"],
)
async def test_ordinary_topics_are_saved_through_agent(monkeypatch, gb_session, title):
    user, _, _, context = await _make_context(gb_session, f"Создай задачу: {title}")

    async def complete(_messages, _tools):
        return tool_call(
            "save-task",
            "commit_calendar_command",
            {
                "reply": f"Создана задача: {title}",
                "mutations": [
                    {"operation": "create", "resource": "task", "payload": {"title": title}}
                ],
            },
        )

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent(f"Создай задачу: {title}", context)
    assert result.state == "completed"
    assert title in json.loads(result.result)["reply"]
    assert await _count_operations(gb_session, user) == 1


# =====================================================================
# Часть 1: Прямые тесты classify() — детерминированные паттерны гарда
# =====================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda c: c["case_id"])
async def test_classify_direct(case):
    """Прямой вызов classify() без моков. Проверяем детерминированные паттерны."""
    if case.get("requires_remote_guard"):
        pytest.skip(f"{case['case_id']} требует удалённой модели гарда")

    # API-валидация (пустая/слишком длинная строка) не доходит до classify()
    if case.get("llm_response_type") == "api_validation":
        pytest.skip(f"{case['case_id']} — это API-валидация, не паттерн гарда")

    user_input = case["user_input"]
    if user_input == "__LONG_INPUT__":
        user_input = "x" * 10_001

    settings = Settings(guard_enabled=False)
    decision = await classify(user_input, settings, source=case.get("guard_source", "user_input"))

    expected_action = case["expected_action"]
    expected_category = case["expected_category"]

    assert decision.action == expected_action, (
        f"case={case['case_id']}: ожидалось действие {expected_action}, получено {decision.action}"
    )
    assert decision.category == expected_category, (
        f"case={case['case_id']}: ожидалась категория {expected_category}, получено {decision.category}"
    )


def test_refusal_messages_do_not_echo_unsafe():
    """Отказы не содержат опасный текст во входе."""
    for category in (
        "hate",
        "extremist_praise",
        "violence",
        "sexual",
        "prompt_injection",
        "off_topic",
    ):
        decision = GuardDecision("refuse", category, 1.0, "test")
        response = refusal_for(decision)
        assert response is not None
        assert len(response) > 0


# =====================================================================
# Часть 2: Сквозные тесты run_agent() через _guard_input
# =====================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda c: c["case_id"])
async def test_run_agent_guardrail(monkeypatch, gb_session, case):
    """Сквозной прогон через run_agent с моком LLM."""
    if case.get("requires_remote_guard"):
        pytest.skip(f"{case['case_id']} требует удалённой модели гарда")

    user_input = case["user_input"]
    if user_input == "__LONG_INPUT__":
        user_input = "x" * 10_001

    expected_state = case["expected_state"]
    expected_mutations = case["expected_db_mutations"]
    expected_reply = case.get("expected_reply_contains")
    llm_response_type = case.get("llm_response_type", "tool_calls")
    llm_responses = case.get("llm_responses", [])

    # --- API-уровень валидации (AgentInput) ---
    if llm_response_type == "api_validation":
        with pytest.raises(ValidationError):
            AgentInput.model_validate({"text": user_input})
        return

    _user, _conversation, _message, context = await _make_context(gb_session, user_input)

    # --- Мокаем LLM ---
    async def complete(_messages, _tools):
        if llm_response_type == "raw_content":
            return {"role": "assistant", "content": llm_responses[0], "tool_calls": []}
        if llm_response_type == "tool_calls":
            if not llm_responses:
                return {"role": "assistant", "content": None, "tool_calls": []}
            spec = llm_responses.pop(0)
            return tool_call(
                call_id=f"call-{spec['name']}", name=spec["name"], arguments=spec["arguments"]
            )
        return {"role": "assistant", "content": None, "tool_calls": []}

    monkeypatch.setattr(agent, "_complete_react", complete)

    # --- Прогоняем ---
    result = await run_agent(user_input, context)

    # --- Проверяем статус ---
    assert result.state == expected_state, (
        f"case={case['case_id']}: ожидался статус {expected_state}, получен {result.state}"
    )

    # result.result — JSON только для completed; для failed/needs_clarification это строка
    payload = None
    if result.state == "completed":
        try:
            payload = json.loads(result.result)
        except json.JSONDecodeError:
            payload = {}

    # --- Проверяем ответ пользователю ---
    if expected_reply is not None and payload is not None:
        assert expected_reply in payload.get("reply", ""), (
            f"case={case['case_id']}: ожидался ответ с {expected_reply!r}, получено {payload.get('reply')!r}"
        )

    # --- Проверяем мутации в БД ---
    actual_mutations = await _count_operations(gb_session, _user)
    assert actual_mutations == expected_mutations, (
        f"case={case['case_id']}: ожидалось {expected_mutations} мутаций в БД, получено {actual_mutations}"
    )


# =====================================================================
# Часть 3: Валидация AgentInput отдельно
# =====================================================================


@pytest.mark.asyncio
async def test_agent_input_validation_rejects_bad_text():
    """AgentInput не пропускает пустые и слишком длинные строки."""
    with pytest.raises(ValidationError):
        AgentInput.model_validate({"text": "   "})
    with pytest.raises(ValidationError):
        AgentInput.model_validate({"text": "x" * 10_001})
    valid = AgentInput.model_validate({"text": "создай задачу"})
    assert valid.text == "создай задачу"
