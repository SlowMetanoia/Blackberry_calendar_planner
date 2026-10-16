from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.calendar import CalendarCommandService, CalendarMutation
from planner.db import Base
from planner.models import CalendarSearchDocument, CalendarSearchIndexState, User
from planner.search import CalendarRetriever, SearchCursorStale


def vector(x: float, y: float = 0.0) -> list[float]:
    return [x, y, *([0.0] * 766)]


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
    value = User(email="search@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


@pytest.mark.asyncio
async def test_calendar_command_updates_search_projection_and_generation(session, user):
    operation = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Французский язык",
                        "description": "Занятие с преподавателем",
                        "starts_at": datetime(2026, 10, 20, 8, 30, tzinfo=UTC),
                    },
                )
            ],
            origin="rest",
        )
    )[0]

    document = await session.get(CalendarSearchDocument, (user.id, "event", operation.target_id))
    state = await session.get(CalendarSearchIndexState, user.id)

    assert document.normalized_title == "французский язык"
    assert document.normalized_description == "занятие с преподавателем"
    assert document.embedding is None
    assert state.requested_generation == 1
    assert state.completed_generation == 0
    assert state.status == "pending"


@pytest.mark.asyncio
async def test_retriever_combines_match_channels_and_finds_typo(session, user):
    operation = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Французский",
                        "description": "Урок иностранного языка",
                        "starts_at": datetime(2026, 10, 20, 8, 30, tzinfo=UTC),
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    document = await session.get(CalendarSearchDocument, (user.id, "event", operation.target_id))
    document.embedding = vector(1)
    document.embedding_model = "test-model"
    document.embedding_content_hash = document.content_hash
    await session.flush()

    page = await CalendarRetriever.search_ready(
        session,
        user,
        query="французкий",
        query_embedding=vector(1),
        embedding_model="test-model",
        index_generation=1,
        fuzzy_threshold=0.5,
        semantic_threshold=0.5,
    )

    assert page.total == 1
    assert page.items[0]["id"] == str(operation.target_id)
    assert {item["kind"] for item in page.items[0]["matches"]} == {"fuzzy", "semantic"}


@pytest.mark.asyncio
async def test_retriever_uses_threshold_pages_instead_of_top_ten(session, user):
    for number in range(12):
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": f"Отчёт проекта {number}"})],
            origin="rest",
        )
    state = await session.get(CalendarSearchIndexState, user.id)

    first = await CalendarRetriever.search_ready(
        session,
        user,
        query="отчёт",
        query_embedding=vector(0, 1),
        embedding_model="test-model",
        index_generation=state.requested_generation,
        page_size=5,
    )
    second = await CalendarRetriever.search_ready(
        session,
        user,
        query="отчёт",
        query_embedding=vector(0, 1),
        embedding_model="test-model",
        index_generation=state.requested_generation,
        page_size=5,
        cursor=first.next_cursor,
    )

    assert first.total == 12
    assert len(first.items) == len(second.items) == 5
    assert first.has_more is second.has_more is True
    assert {item["id"] for item in first.items}.isdisjoint({item["id"] for item in second.items})

    with pytest.raises(SearchCursorStale):
        await CalendarRetriever.search_ready(
            session,
            user,
            query="отчёт",
            query_embedding=vector(0, 1),
            embedding_model="test-model",
            index_generation=state.requested_generation + 1,
            page_size=5,
            cursor=first.next_cursor,
        )


@pytest.mark.asyncio
async def test_retriever_is_owner_scoped(session, user):
    other = User(email="other-search@example.test", password_hash="x")
    session.add(other)
    await session.flush()
    await CalendarCommandService.execute(
        session,
        other,
        [CalendarMutation("create", "task", {"title": "Секретный отчёт"})],
        origin="rest",
    )

    page = await CalendarRetriever.search_ready(
        session,
        user,
        query="секретный",
        query_embedding=vector(1),
        embedding_model="test-model",
        index_generation=0,
    )

    assert page.items == []
    assert page.total == 0


@pytest.mark.asyncio
async def test_retriever_rejects_malformed_cursor(session, user):
    with pytest.raises(SearchCursorStale):
        await CalendarRetriever.search_ready(
            session,
            user,
            query="отчёт",
            query_embedding=vector(1),
            embedding_model="test-model",
            index_generation=0,
            cursor="%%%not-a-cursor%%%",
        )


@pytest.mark.asyncio
async def test_retriever_normalizes_yo_and_marks_exact_title(session, user):
    operation = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Отчёт"})],
            origin="rest",
        )
    )[0]

    page = await CalendarRetriever.search_ready(
        session,
        user,
        query="  ОТЧЕТ ",
        query_embedding=vector(0, 1),
        embedding_model="test-model",
        index_generation=1,
        resource="task",
    )

    assert page.total == 1
    assert page.items[0]["id"] == str(operation.target_id)
    assert {match["kind"] for match in page.items[0]["matches"]} >= {
        "exact",
        "substring",
    }


@pytest.mark.asyncio
async def test_retriever_searches_description_with_half_open_time_filter(session, user):
    included = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Занятие",
                        "description": "Урок иностранного языка в центре",
                        "starts_at": datetime(2026, 10, 20, 8, 30, tzinfo=UTC),
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "create",
                "event",
                {
                    "title": "Другое занятие",
                    "description": "Тоже урок языка",
                    "starts_at": datetime(2026, 10, 21, 8, 30, tzinfo=UTC),
                },
            )
        ],
        origin="rest",
    )

    page = await CalendarRetriever.search_ready(
        session,
        user,
        query="иностранного языка",
        query_embedding=vector(0, 1),
        embedding_model="test-model",
        index_generation=2,
        resource="event",
        from_datetime=datetime(2026, 10, 20, 0, 0, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 21, 0, 0, tzinfo=UTC),
    )

    assert [item["id"] for item in page.items] == [str(included.target_id)]
    assert any(
        match["kind"] == "substring" and match["field"] == "description"
        for match in page.items[0]["matches"]
    )
