from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.agent import parse_decision
from planner.db import Base
from planner.main import list_conversations
from planner.models import AgentMessage, Conversation, Event, MessageStatus, Task, User
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


def test_read_envelope_accepts_strict_half_open_time_range() -> None:
    decision = parse_decision(
        '{"reply":"ok","reads":['
        '{"operation":"list","resource":"event","time_range":{'
        '"from":"2026-10-15T00:00:00+03:00","to":"2026-10-16T00:00:00+03:00"}},'
        '{"operation":"list","resource":"task","time_range":{'
        '"from":"2026-10-15T00:00:00+03:00","to":"2026-10-16T00:00:00+03:00"}}],'
        '"mutations":[],"clarification":null}'
    )
    assert decision.reads[0].time_range.from_datetime.isoformat() == "2026-10-15T00:00:00+03:00"
    assert decision.reads[1].time_range.to_datetime.isoformat() == "2026-10-16T00:00:00+03:00"


@pytest.mark.parametrize(
    "time_range",
    [
        '{"from":"2026-10-16T00:00:00+03:00","to":"2026-10-15T00:00:00+03:00"}',
        '{"from":"2026-10-15T00:00:00","to":"2026-10-16T00:00:00+03:00"}',
    ],
)
def test_read_envelope_rejects_invalid_time_range(time_range: str) -> None:
    raw = (
        '{"reply":"ok","reads":[{"operation":"list","resource":"event","time_range":'
        f"{time_range}"
        '}],"mutations":[],"clarification":null}'
    )
    with pytest.raises(ValueError):
        parse_decision(raw)


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
