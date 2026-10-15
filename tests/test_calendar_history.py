import json
import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import agent
from planner.agent import AgentRunContext, run_agent
from planner.calendar import (
    CalendarCommandService,
    CalendarHistoryCorrupt,
    CalendarMutation,
    CalendarTargetNotFound,
    UndoConflict,
)
from planner.db import Base
from planner.models import AgentMessage, CalendarOperation, Conversation, MessageStatus, Task, User
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


@pytest.mark.asyncio
async def test_cud_records_snapshots_changes_and_sequence(session, user):
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Draft", "status": "open"})],
            origin="rest",
        )
    )[0]
    updated = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("update", "task", {"title": "Final"}, created.target_id)],
            origin="rest",
        )
    )[0]
    deleted = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("delete", "task", {}, created.target_id)],
            origin="rest",
        )
    )[0]
    assert [created.sequence, updated.sequence, deleted.sequence] == [1, 2, 3]
    assert created.before_state is None and created.after_state["title"] == "Draft"
    assert updated.changes["title"] == {"before": "Draft", "after": "Final"}
    assert deleted.before_state["title"] == "Final" and deleted.after_state is None


@pytest.mark.asyncio
async def test_multi_action_command_is_atomic(session, user):
    with pytest.raises(CalendarTargetNotFound):
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation("create", "task", {"title": "Must roll back"}),
                CalendarMutation("delete", "task", {}, uuid.uuid4()),
            ],
            origin="agent",
        )
    assert await TaskService.list(session, user) == []
    assert (await session.scalars(CalendarOperation.__table__.select())).all() == []


@pytest.mark.asyncio
async def test_command_id_is_idempotent(session, user):
    command_id = uuid.uuid4()
    first = await CalendarCommandService.execute(
        session,
        user,
        [CalendarMutation("create", "task", {"title": "Once"})],
        origin="agent",
        command_id=command_id,
    )
    second = await CalendarCommandService.execute(
        session,
        user,
        [CalendarMutation("create", "task", {"title": "Twice"})],
        origin="agent",
        command_id=command_id,
    )
    assert second[0].id == first[0].id
    assert [task.title for task in await TaskService.list(session, user)] == ["Once"]


@pytest.mark.asyncio
async def test_undo_is_compensating_and_itself_undoable(session, user):
    created = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "task", {"title": "Keep"})], origin="rest"
        )
    )[0]
    undo = await CalendarCommandService.undo(session, user, created.id)
    assert undo.operation == "delete" and undo.reverts_operation_id == created.id
    assert await TaskService.get(session, user, created.target_id) is None
    redo = await CalendarCommandService.undo(session, user, undo.id)
    assert redo.operation == "create" and redo.reverts_operation_id == undo.id
    assert (await TaskService.get(session, user, created.target_id)).title == "Keep"


@pytest.mark.asyncio
async def test_undo_rejects_changed_state(session, user):
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Original"})],
            origin="rest",
        )
    )[0]
    await CalendarCommandService.execute(
        session,
        user,
        [CalendarMutation("update", "task", {"title": "Changed"}, created.target_id)],
        origin="rest",
    )
    with pytest.raises(UndoConflict):
        await CalendarCommandService.undo(session, user, created.id)


@pytest.mark.asyncio
async def test_update_and_delete_undo_restore_prior_state(session, user):
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Before", "description": "Keep"})],
            origin="rest",
        )
    )[0]
    updated = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("update", "task", {"title": "After"}, created.target_id)],
            origin="rest",
        )
    )[0]
    await CalendarCommandService.undo(session, user, updated.id)
    restored = await TaskService.get(session, user, created.target_id)
    assert (restored.title, restored.description) == ("Before", "Keep")
    deleted = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("delete", "task", {}, created.target_id)],
            origin="rest",
        )
    )[0]
    await CalendarCommandService.undo(session, user, deleted.id)
    restored = await TaskService.get(session, user, created.target_id)
    assert (restored.title, restored.description) == ("Before", "Keep")


@pytest.mark.asyncio
async def test_operations_and_targets_are_owner_scoped(session, user):
    other = User(email="other@example.test", password_hash="x")
    session.add(other)
    await session.flush()
    created = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "task", {"title": "Private"})], origin="rest"
        )
    )[0]
    with pytest.raises(CalendarTargetNotFound):
        await CalendarCommandService.execute(
            session,
            other,
            [CalendarMutation("update", "task", {"title": "Stolen"}, created.target_id)],
            origin="rest",
        )
    with pytest.raises(CalendarTargetNotFound):
        await CalendarCommandService.undo(session, other, created.id)
    assert (await TaskService.get(session, user, created.target_id)).title == "Private"


@pytest.mark.asyncio
async def test_replay_rebuilds_projection(session, user):
    created = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "task", {"title": "Before"})], origin="rest"
        )
    )[0]
    await CalendarCommandService.execute(
        session,
        user,
        [CalendarMutation("update", "task", {"title": "After"}, created.target_id)],
        origin="rest",
    )
    await session.execute(Task.__table__.delete())
    await CalendarCommandService.replay(session, user)
    assert (await TaskService.get(session, user, created.target_id)).title == "After"


@pytest.mark.asyncio
async def test_replay_validates_history_before_deleting_projection(session, user):
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Still present"})],
            origin="rest",
        )
    )[0]
    await session.flush()
    created.after_state = {**created.after_state, "title": None}

    with pytest.raises(CalendarHistoryCorrupt):
        await CalendarCommandService.replay(session, user)

    assert (await TaskService.get(session, user, created.target_id)).title == "Still present"


@pytest.mark.asyncio
async def test_langgraph_executes_mutation_immediately(session, user, monkeypatch):
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    message = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text="create",
        status=MessageStatus.processing,
    )
    session.add(message)
    await session.flush()

    async def decision(_text, **_kwargs):
        return '{"reply":"Готово","reads":[],"mutations":[{"operation":"create","resource":"task","payload":{"title":"Graph task"}}],"clarification":null}'

    monkeypatch.setattr(agent, "_complete", decision)
    result = await run_agent(
        "create", AgentRunContext(session, user.id, conversation.id, message.id)
    )
    payload = json.loads(result.result)
    assert result.state == "completed"
    assert payload["operations"][0]["after"]["title"] == "Graph task"
    assert (await TaskService.list(session, user))[0].title == "Graph task"
