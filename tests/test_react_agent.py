import json

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import agent
from planner.agent import AgentRunContext, run_agent
from planner.agent_tools import AgentTool
from planner.config import Settings
from planner.db import Base
from planner.models import AgentMessage, Conversation, MessageStatus, Task, User
from planner.schemas import StrictInput
from planner.search import CalendarRetriever, SearchPage
from planner.services import EventService, TaskService


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as value:
        yield value
    await engine.dispose()


@pytest.fixture
async def user(session):
    value = User(email="react@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


async def runtime_context(session, user, text="request"):
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    message = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text=text,
        status=MessageStatus.processing,
    )
    session.add(message)
    await session.flush()
    return AgentRunContext(session, user.id, conversation.id, message.id)


def tool_call(call_id: str, name: str, arguments: dict) -> dict:
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


@pytest.mark.asyncio
async def test_react_reads_then_updates_observed_task(session, user, monkeypatch) -> None:
    task = Task(owner_id=user.id, title="Черновик")
    session.add(task)
    context = await runtime_context(session, user, "переименуй задачу")
    await session.commit()
    responses = [
        tool_call("read-1", "list_tasks", {}),
        tool_call(
            "commit-1",
            "commit_calendar_command",
            {
                "reply": "Переименовал задачу",
                "mutations": [
                    {
                        "operation": "update",
                        "resource": "task",
                        "target_id": str(task.id),
                        "payload": {"title": "Готово"},
                    }
                ],
            },
        ),
    ]
    seen_messages = []

    async def complete(messages, _tools):
        seen_messages.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("переименуй задачу", context)

    assert result.state == "completed"
    assert (await TaskService.get(session, user, task.id)).title == "Готово"
    payload = json.loads(result.result)
    assert payload["reads"][0]["id"] == str(task.id)
    assert len(payload["operations"]) == 1
    observation = json.loads(seen_messages[1][-1]["content"])
    assert observation["ok"] is True
    assert observation["data"][0]["data"]["title"] == "Черновик"


@pytest.mark.asyncio
async def test_search_tool_returns_metadata_and_observes_target(session, user, monkeypatch) -> None:
    task = Task(owner_id=user.id, title="Французский")
    session.add(task)
    context = await runtime_context(session, user, "переименуй французский")
    await session.commit()

    async def search(_cls, _session, _user, _settings, **_kwargs):
        return SearchPage(
            items=[
                {
                    "resource": "task",
                    "id": str(task.id),
                    "data": {"id": str(task.id), "title": task.title},
                    "matches": [
                        {
                            "kind": "fuzzy",
                            "field": "title",
                            "score": 0.8,
                            "threshold": 0.5,
                        }
                    ],
                }
            ],
            total=1,
            has_more=False,
            next_cursor=None,
            index_generation=3,
            thresholds={"fuzzy": 0.5, "semantic": 0.5},
        )

    monkeypatch.setattr(CalendarRetriever, "search", classmethod(search))
    responses = [
        tool_call("search-1", "search_calendar", {"query": "французкий"}),
        tool_call(
            "commit-1",
            "commit_calendar_command",
            {
                "reply": "Переименовал",
                "mutations": [
                    {
                        "operation": "update",
                        "resource": "task",
                        "target_id": str(task.id),
                        "payload": {"title": "Французский язык"},
                    }
                ],
            },
        ),
    ]
    seen = []

    async def complete(messages, _tools):
        seen.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("переименуй французский", context)

    assert result.state == "completed"
    assert (await TaskService.get(session, user, task.id)).title == "Французский язык"
    observation = json.loads(seen[1][-1]["content"])
    assert observation["meta"]["index_generation"] == 3
    assert observation["data"][0]["matches"][0]["kind"] == "fuzzy"


@pytest.mark.asyncio
async def test_unobserved_update_is_rejected_and_repair_can_clarify(
    session, user, monkeypatch
) -> None:
    task = Task(owner_id=user.id, title="Не трогать")
    session.add(task)
    context = await runtime_context(session, user)
    await session.commit()
    responses = [
        tool_call(
            "commit-1",
            "commit_calendar_command",
            {
                "reply": "Изменил",
                "mutations": [
                    {
                        "operation": "update",
                        "resource": "task",
                        "target_id": str(task.id),
                        "payload": {"title": "Нельзя"},
                    }
                ],
            },
        ),
        tool_call(
            "clarify-1",
            "request_clarification",
            {"question": "Уточните, какую задачу изменить"},
        ),
    ]
    repair_messages = []

    async def complete(messages, _tools):
        repair_messages.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("измени задачу", context)

    assert result.state == "needs_clarification"
    assert (await TaskService.get(session, user, task.id)).title == "Не трогать"
    error = json.loads(repair_messages[1][-1]["content"])
    assert error["error"]["code"] == "target_not_observed"


@pytest.mark.asyncio
async def test_repeated_run_uses_source_message_as_idempotency_key(
    session, user, monkeypatch
) -> None:
    context = await runtime_context(session, user, "создай задачу")
    await session.commit()

    async def complete(_messages, _tools):
        return tool_call(
            "commit-1",
            "commit_calendar_command",
            {
                "reply": "Создал",
                "mutations": [
                    {"operation": "create", "resource": "task", "payload": {"title": "Одна"}}
                ],
            },
        )

    monkeypatch.setattr(agent, "_complete_react", complete)
    first = await run_agent("создай задачу", context)
    second = await run_agent("создай задачу", context)

    assert first.state == second.state == "completed"
    assert [item.title for item in await TaskService.list(session, user)] == ["Одна"]
    assert (
        json.loads(first.result)["operations"][0]["id"]
        == json.loads(second.result)["operations"][0]["id"]
    )


@pytest.mark.asyncio
async def test_model_turn_limit_stops_without_mutation(monkeypatch) -> None:
    async def plain_content(_messages, _tools):
        return {"role": "assistant", "content": "Сделаю", "tool_calls": []}

    settings = Settings(llm_required=False, agent_max_model_turns=2)
    monkeypatch.setattr(agent, "_complete_react", plain_content)
    monkeypatch.setattr(agent, "get_settings", lambda: settings)

    result = await run_agent("создай задачу")

    assert result.state == "failed"
    assert "допустимое число шагов" in result.result


@pytest.mark.asyncio
async def test_unknown_tool_is_returned_as_safe_observation(monkeypatch) -> None:
    responses = [
        tool_call("unknown-1", "drop_database", {"owner_id": "foreign"}),
        tool_call("finish-1", "finish_response", {"reply": "Такого действия нет"}),
    ]
    seen_messages = []

    async def complete(messages, _tools):
        seen_messages.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("сделай неизвестное действие")

    assert result.state == "completed"
    error = json.loads(seen_messages[1][-1]["content"])
    assert error == {
        "ok": False,
        "error": {"code": "unknown_tool", "message": "Инструмент недоступен"},
    }


@pytest.mark.asyncio
async def test_invalid_arguments_and_mixed_terminal_calls_are_repairable(monkeypatch) -> None:
    mixed = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            tool_call("read-2", "list_tasks", {})["tool_calls"][0],
            tool_call("finish-2", "finish_response", {"reply": "Рано"})["tool_calls"][0],
        ],
    }
    responses = [
        tool_call("read-1", "list_tasks", {"owner_id": "forbidden"}),
        mixed,
        tool_call("finish-3", "finish_response", {"reply": "Исправил вызов"}),
    ]
    seen_messages = []

    async def complete(messages, _tools):
        seen_messages.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("покажи задачи")

    assert result.state == "completed"
    assert json.loads(seen_messages[1][-1]["content"])["error"]["code"] == "invalid_arguments"
    mixed_errors = [json.loads(item["content"])["error"]["code"] for item in seen_messages[2][-2:]]
    assert mixed_errors == ["mixed_tool_calls", "mixed_tool_calls"]


@pytest.mark.asyncio
async def test_read_tool_internal_error_is_not_exposed(session, user, monkeypatch) -> None:
    registry = agent.get_tool_registry()
    original = registry["list_tasks"]

    async def fail(_context, _args, _limit):
        raise RuntimeError("postgresql password=secret")

    registry["list_tasks"] = AgentTool(
        original.name, original.description, original.args_model, original.kind, fail
    )
    context = await runtime_context(session, user)
    await session.commit()
    responses = [
        tool_call("read-1", "list_tasks", {}),
        tool_call("finish-1", "finish_response", {"reply": "Не удалось прочитать календарь"}),
    ]
    seen_messages = []

    async def complete(messages, _tools):
        seen_messages.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "get_tool_registry", lambda: registry)
    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("покажи задачи", context)

    assert result.state == "completed"
    observation = seen_messages[1][-1]["content"]
    assert "secret" not in observation
    assert json.loads(observation)["error"]["code"] == "tool_failed"


@pytest.mark.asyncio
async def test_read_tool_cannot_access_another_owner_record(session, user, monkeypatch) -> None:
    other = User(email="other-react@example.test", password_hash="x")
    session.add(other)
    await session.flush()
    foreign = Task(owner_id=other.id, title="Чужая задача")
    session.add(foreign)
    context = await runtime_context(session, user, "покажи задачу")
    await session.commit()
    responses = [
        tool_call("get-1", "get_task", {"target_id": str(foreign.id)}),
        tool_call("finish-1", "finish_response", {"reply": "Задача не найдена"}),
    ]
    observations = []

    async def complete(messages, _tools):
        observations.append(messages)
        return responses.pop(0)

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("покажи задачу", context)

    assert result.state == "completed"
    assert json.loads(result.result)["reads"] == []
    assert json.loads(observations[1][-1]["content"])["data"] == []


@pytest.mark.asyncio
async def test_registry_accepts_future_multihop_read_tool_without_graph_change(
    session, user, monkeypatch
) -> None:
    class FindSlotsArgs(StrictInput):
        duration_minutes: int

    async def find_slots(_context, args, _limit):
        assert args.duration_minutes == 120
        return [
            {
                "starts_at": "2026-10-20T11:00:00+03:00",
                "duration_minutes": 120,
                "constraints": ["daytime", "no_overlap"],
            }
        ]

    registry = agent.get_tool_registry()
    registry["find_available_slots"] = AgentTool(
        "find_available_slots",
        "Return deterministic candidate calendar slots.",
        FindSlotsArgs,
        "read",
        find_slots,
    )
    context = await runtime_context(session, user, "найди окно")
    await session.commit()
    responses = [
        tool_call("tasks-1", "list_tasks", {}),
        tool_call("slots-1", "find_available_slots", {"duration_minutes": 120}),
        tool_call(
            "commit-1",
            "commit_calendar_command",
            {
                "reply": "Запланировал встречу",
                "mutations": [
                    {
                        "operation": "create",
                        "resource": "event",
                        "payload": {
                            "title": "Встреча с Денисом",
                            "starts_at": "2026-10-20T11:00:00+03:00",
                            "duration_minutes": 120,
                        },
                    }
                ],
            },
        ),
    ]
    seen = []

    async def complete(messages, tools):
        seen.append((messages, tools))
        return responses.pop(0)

    monkeypatch.setattr(agent, "get_tool_registry", lambda: registry)
    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await run_agent("найди окно", context)

    assert result.state == "completed"
    assert any(item["function"]["name"] == "find_available_slots" for item in seen[0][1])
    events = await EventService.list(session, user)
    assert [(item.title, item.duration_minutes) for item in events] == [("Встреча с Денисом", 120)]
    slot_observation = json.loads(seen[2][0][-1]["content"])
    assert slot_observation["data"][0]["constraints"] == ["daytime", "no_overlap"]
