import json
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.db import Base
from planner.main import (
    _message_response,
    get_user_preferences,
    list_conversations,
    update_user_preferences,
)
from planner.models import AgentMessage, Conversation, Event, MessageStatus, Task, User
from planner.schemas import UserPreferencesUpdate
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
    value = User(email="reader@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


@pytest.mark.asyncio
async def test_services_filter_owner_scoped_half_open_ranges(session, user) -> None:
    other = User(email="other-reader@example.test", password_hash="x", timezone="UTC")
    session.add(other)
    await session.flush()
    start = datetime(2026, 10, 14, 21, tzinfo=UTC)
    end = datetime(2026, 10, 15, 21, tzinfo=UTC)
    session.add_all(
        [
            Event(owner_id=user.id, title="boundary start", starts_at=start),
            Event(
                owner_id=user.id, title="inside", starts_at=datetime(2026, 10, 15, 9, tzinfo=UTC)
            ),
            Event(owner_id=user.id, title="boundary end", starts_at=end),
            Event(
                owner_id=other.id, title="foreign", starts_at=datetime(2026, 10, 15, 9, tzinfo=UTC)
            ),
            Task(owner_id=user.id, title="dated", deadline=datetime(2026, 10, 15, 8, tzinfo=UTC)),
            Task(owner_id=user.id, title="undated", deadline=None),
        ]
    )
    await session.commit()

    events = await EventService.list(session, user, from_datetime=start, to_datetime=end)
    tasks = await TaskService.list(session, user, from_datetime=start, to_datetime=end)

    assert [item.title for item in events] == ["boundary start", "inside"]
    assert [item.title for item in tasks] == ["dated"]


@pytest.mark.asyncio
async def test_task_service_filters_status_and_deadline_presence(session, user) -> None:
    other = User(email="other-filter@example.test", password_hash="x")
    session.add(other)
    await session.flush()
    session.add_all(
        [
            Task(
                owner_id=user.id,
                title="open dated",
                deadline=datetime(2026, 10, 16, 8, tzinfo=UTC),
                status="open",
            ),
            Task(
                owner_id=user.id,
                title="completed dated",
                deadline=datetime(2026, 10, 16, 9, tzinfo=UTC),
                status="completed",
            ),
            Task(owner_id=user.id, title="open undated", deadline=None, status="open"),
            Task(owner_id=other.id, title="foreign undated", deadline=None, status="open"),
        ]
    )
    await session.commit()

    dated, dated_total = await TaskService.page(
        session,
        user,
        limit=100,
        offset=0,
        status="open",
        deadline_presence="dated",
    )
    undated, undated_total = await TaskService.page(
        session,
        user,
        limit=100,
        offset=0,
        status="open",
        deadline_presence="undated",
    )

    assert dated_total == 1
    assert [item.title for item in dated] == ["open dated"]
    assert undated_total == 1
    assert [item.title for item in undated] == ["open undated"]


@pytest.mark.asyncio
async def test_user_preferences_default_and_partial_update(session, user) -> None:
    current = await get_user_preferences(user=user)
    assert current.timezone == "Europe/Moscow"
    assert current.upcoming_days == 7
    assert current.open_air_silence_ms == 1500
    assert current.open_air_active_timeout_seconds == 15
    assert current.voice_output_enabled is False
    assert current.tts_voice == "kseniya"
    assert current.tts_speed == 1.0
    assert current.open_air_default is False

    updated = await update_user_preferences(
        data=UserPreferencesUpdate(
            upcoming_days=14,
            open_air_silence_ms=2000,
            open_air_active_timeout_seconds=30,
        ),
        user=user,
        session=session,
    )
    assert updated.timezone == "Europe/Moscow"
    assert updated.upcoming_days == 14
    assert updated.open_air_silence_ms == 2000
    assert updated.open_air_active_timeout_seconds == 30
    assert user.upcoming_days == 14
    assert user.open_air_silence_ms == 2000
    assert user.open_air_active_timeout_seconds == 30


@pytest.mark.asyncio
async def test_conversation_list_is_owner_scoped_and_uses_first_phrase(session, user) -> None:
    other = User(email="other-conversation@example.test", password_hash="x")
    session.add(other)
    await session.flush()
    older = Conversation(
        owner_id=user.id,
        last_activity_at=datetime(2026, 10, 13, 8, tzinfo=UTC),
    )
    recent = Conversation(
        owner_id=user.id,
        last_activity_at=datetime(2026, 10, 14, 9, tzinfo=UTC),
    )
    foreign = Conversation(owner_id=other.id)
    session.add_all([older, recent, foreign])
    await session.flush()
    session.add_all(
        [
            AgentMessage(
                owner_id=user.id,
                conversation_id=older.id,
                sequence=1,
                input_text="Старая сессия",
                status=MessageStatus.completed,
            ),
            AgentMessage(
                owner_id=user.id,
                conversation_id=recent.id,
                sequence=1,
                input_text="Первая фраза новой сессии",
                status=MessageStatus.completed,
            ),
            AgentMessage(
                owner_id=user.id,
                conversation_id=recent.id,
                sequence=2,
                input_text="Не использовать как заголовок",
                status=MessageStatus.completed,
            ),
            AgentMessage(
                owner_id=other.id,
                conversation_id=foreign.id,
                sequence=1,
                input_text="Чужая сессия",
                status=MessageStatus.completed,
            ),
        ]
    )
    await session.commit()

    page = await list_conversations(limit=100, offset=0, user=user, session=session)

    assert page.total == 2
    assert [item.id for item in page.items] == [recent.id, older.id]
    assert page.items[0].preview == "Первая фраза новой сессии"


@pytest.mark.asyncio
async def test_legacy_message_reads_become_deduplicated_display_items(session, user) -> None:
    conversation = Conversation(owner_id=user.id)
    session.add(conversation)
    await session.flush()
    item = {
        "resource": "task",
        "id": "5f1264ac-738f-4d1f-a64b-206469187de7",
        "data": {"title": "Старая карточка"},
    }
    message = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation.id,
        sequence=1,
        input_text="Покажи задачу",
        status=MessageStatus.completed,
        result=json.dumps({"reply": "Вот задача", "reads": [item, item], "operations": []}),
    )
    session.add(message)
    await session.flush()

    response = await _message_response(message, session)

    assert len(response.display_items) == 1
    assert response.display_items[0].data["title"] == "Старая карточка"
