import json
import uuid
from datetime import timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.db import Base
from planner.agent import AgentRunContext, run_agent
from planner import agent
from planner.models import (
    AgentMessage,
    ActionStatus,
    Conversation,
    MessageStatus,
    PlanStatus,
    PlannedAction,
    Task,
    User,
)
from planner.plans import PlanService
from planner.schemas import (
    DecisionTaskCreateAction,
    DecisionTaskDeleteAction,
    DecisionTaskUpdateAction,
)
from planner.services import TaskService


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
    value = User(email="owner@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


async def _plan(session, user, actions):
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    plan = await PlanService.create(
        session,
        owner_id=user.id,
        conversation_id=conversation.id,
        source_message_id=uuid.uuid4(),
        mutations=actions,
    )
    await session.commit()
    return plan


@pytest.mark.asyncio
async def test_create_only_plan_gets_fifteen_second_expiry(session, user) -> None:
    plan = await _plan(
        session, user,
        [DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "Report"})],
    )
    action = (await PlanService.actions(session, plan.id))[0]
    assert plan.expires_at is not None
    assert 14 <= (plan.expires_at.replace(tzinfo=timezone.utc) - plan.created_at.replace(tzinfo=timezone.utc)).total_seconds() <= 16
    assert action.expires_at.replace(tzinfo=timezone.utc) == plan.expires_at.replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_mixed_plan_has_no_auto_expiry(session, user) -> None:
    plan = await _plan(session, user, [
        DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "New"}),
        DecisionTaskDeleteAction(operation="delete", resource="task", target_id=uuid.uuid4(), payload={}),
    ])
    assert plan.expires_at is None
    assert all(action.expires_at is None for action in await PlanService.actions(session, plan.id))


@pytest.mark.asyncio
async def test_confirming_one_action_executes_only_that_action(session, user) -> None:
    plan = await _plan(session, user, [
        DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "One"}),
        DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "Two"}),
    ])
    actions = await PlanService.actions(session, plan.id)
    _, approved = await PlanService.approve_action(session, plan, actions[0].id)
    assert approved
    await PlanService.execute_action(session, actions[0].id)
    statuses = [item.status for item in await PlanService.actions(session, plan.id)]
    assert statuses == [ActionStatus.completed, ActionStatus.pending]
    assert len(await TaskService.list(session, user)) == 1


@pytest.mark.asyncio
async def test_partial_failure_preserves_success(session, user) -> None:
    plan = await _plan(session, user, [
        DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "Created"}),
        DecisionTaskDeleteAction(operation="delete", resource="task", target_id=uuid.uuid4(), payload={}),
    ])
    action_ids = await PlanService.approve_all(session, plan)
    for action_id in action_ids:
        await PlanService.execute_action(session, action_id)
    actions = await PlanService.actions(session, plan.id)
    assert [action.status for action in actions] == [ActionStatus.completed, ActionStatus.failed]
    await session.refresh(user)
    assert len(await TaskService.list(session, user)) == 1
    await session.refresh(plan)
    assert plan.status == PlanStatus.failed


@pytest.mark.asyncio
async def test_repeated_approval_is_idempotent(session, user) -> None:
    plan = await _plan(
        session, user,
        [DecisionTaskCreateAction(operation="create", resource="task", payload={"title": "Once"})],
    )
    action = (await PlanService.actions(session, plan.id))[0]
    _, first = await PlanService.approve_action(session, plan, action.id)
    _, second = await PlanService.approve_action(session, plan, action.id)
    assert first is True
    assert second is False


@pytest.mark.asyncio
async def test_langgraph_persists_plan_behind_run_agent(session, user, monkeypatch) -> None:
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    current = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text="create a task",
        status=MessageStatus.processing,
    )
    session.add(current)
    await session.flush()

    async def decision(_text, **_kwargs):
        return '{"reply":"planned","reads":[],"mutations":[{"operation":"create","resource":"task","payload":{"title":"Graph task"}}],"clarification":null}'

    monkeypatch.setattr(agent, "_complete", decision)
    result = await run_agent(
        "create a task",
        AgentRunContext(session, user.id, conversation.id, current.id),
    )
    payload = json.loads(result.result)
    assert result.state == "completed"
    assert payload["reply"] == "planned"
    assert await PlanService.get_owned(session, uuid.UUID(payload["plan_id"]), user.id)


@pytest.mark.asyncio
async def test_agent_sends_the_entire_conversation_history(session, user, monkeypatch) -> None:
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    previous = []
    for sequence in range(1, 13):
        previous.append(AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=sequence,
            input_text=f"user-{sequence}",
            status=MessageStatus.completed,
            result=json.dumps({"reply": f"assistant-{sequence}", "reads": []}),
        ))
    current = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=13,
        input_text="current",
        status=MessageStatus.processing,
    )
    session.add_all([*previous, current])
    await session.flush()
    captured = []

    async def decision(_text, **kwargs):
        captured.extend(kwargs["history"])
        return '{"reply":"ok","reads":[],"mutations":[],"clarification":null}'

    monkeypatch.setattr(agent, "_complete", decision)
    result = await run_agent(
        current.input_text,
        AgentRunContext(session, user.id, conversation.id, current.id),
    )

    assert result.state == "completed"
    assert len(captured) == 24
    assert captured[0] == {"role": "user", "content": "user-1"}
    assert captured[-1]["role"] == "assistant"
    assert "assistant-12" in captured[-1]["content"]


@pytest.mark.asyncio
async def test_agent_reloads_referenced_task_into_owner_scoped_context(
    session, user, monkeypatch
) -> None:
    task = Task(
        owner_id=user.id,
        title="Подготовить доклад на PyCon про tagless final",
        description="Не менять",
        status="open",
    )
    foreign = User(email="foreign-context@example.test", password_hash="x")
    session.add_all([task, foreign])
    await session.flush()
    foreign_task = Task(owner_id=foreign.id, title="Чужая задача", status="open")
    session.add(foreign_task)
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    previous = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text="Какие задачи мне нужно сделать за следующий месяц",
        status=MessageStatus.completed,
        result=json.dumps(
            {
                "reply": "Вот задачи",
                "reads": [
                    {
                        "resource": "task",
                        "id": str(task.id),
                        "data": {"title": "Устаревшее название"},
                    },
                    {
                        "resource": "task",
                        "id": str(foreign_task.id),
                        "data": {"title": "Утёкшее чужое название"},
                    },
                ],
            },
            ensure_ascii=False,
        ),
    )
    current = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=2,
        input_text='Поменяй название конференции: она называется "pythonn"',
        status=MessageStatus.processing,
    )
    session.add_all([previous, current])
    await session.flush()
    captured: list[dict] = []

    async def decision(_text, **kwargs):
        captured.extend(kwargs["resource_context"])
        return '{"reply":"ok","reads":[],"mutations":[],"clarification":null}'

    monkeypatch.setattr(agent, "_complete", decision)
    await run_agent(
        current.input_text,
        AgentRunContext(session, user.id, conversation.id, current.id),
    )

    assert captured == [
        {
            "resource": "task",
            "id": str(task.id),
            "data": {
                "id": str(task.id),
                "title": "Подготовить доклад на PyCon про tagless final",
                "description": "Не менять",
                "deadline": None,
                "estimated_minutes": None,
                "status": "open",
            },
        }
    ]


@pytest.mark.asyncio
async def test_agent_reloads_targets_referenced_by_previous_plans(
    session, user, monkeypatch
) -> None:
    task = Task(owner_id=user.id, title="Доклад на PyCon", status="open")
    conversation = Conversation(owner_id=user.id)
    session.add_all([task, conversation])
    await session.flush()
    previous = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text="Измени срок доклада",
        status=MessageStatus.needs_confirmation,
    )
    current = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=2,
        input_text="А теперь исправь конференцию",
        status=MessageStatus.processing,
    )
    session.add_all([previous, current])
    await session.flush()
    plan = await PlanService.create(
        session,
        owner_id=user.id,
        conversation_id=conversation.id,
        source_message_id=previous.id,
        mutations=[
            DecisionTaskUpdateAction(
                operation="update",
                resource="task",
                target_id=task.id,
                payload={"deadline": "2026-10-19T18:00:00+03:00"},
            )
        ],
    )
    previous.result = json.dumps({"reply": "План готов", "plan_id": str(plan.id)})
    await session.flush()
    captured: list[dict] = []

    async def decision(_text, **kwargs):
        captured.extend(kwargs["resource_context"])
        return '{"reply":"ok","reads":[],"mutations":[],"clarification":null}'

    monkeypatch.setattr(agent, "_complete", decision)
    await run_agent(
        current.input_text,
        AgentRunContext(session, user.id, conversation.id, current.id),
    )

    assert [(item["resource"], item["id"]) for item in captured] == [
        ("task", str(task.id))
    ]
    assert captured[0]["data"]["title"] == "Доклад на PyCon"


@pytest.mark.asyncio
async def test_task_title_update_preserves_other_fields(session, user) -> None:
    task = Task(
        owner_id=user.id,
        title="Подготовить доклад на PyCon про tagless final",
        description="Слайды и демонстрация",
        estimated_minutes=120,
        status="open",
    )
    session.add(task)
    await session.commit()
    original_description = task.description
    original_estimate = task.estimated_minutes

    plan = await _plan(
        session,
        user,
        [
            DecisionTaskUpdateAction(
                operation="update",
                resource="task",
                target_id=task.id,
                payload={"title": "Подготовить доклад на pythonn про tagless final"},
            )
        ],
    )
    action = (await PlanService.actions(session, plan.id))[0]
    await PlanService.approve_action(session, plan, action.id)
    await PlanService.execute_action(session, action.id)
    await session.refresh(task)

    assert task.title == "Подготовить доклад на pythonn про tagless final"
    assert task.description == original_description
    assert task.estimated_minutes == original_estimate
