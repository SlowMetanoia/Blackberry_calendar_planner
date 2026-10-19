from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.calendar import CalendarCommandService, CalendarMutation, CalendarValidationError
from planner.db import Base
from planner.models import Task, User
from planner.occurrences import OccurrenceService


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
    value = User(email="occurrences@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


@pytest.mark.asyncio
async def test_recurring_event_is_one_series_with_many_occurrences(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Французский",
                        "starts_at": datetime(2026, 10, 20, 8, 30, tzinfo=UTC),
                        "recurrence": {
                            "frequency": "weekly",
                            "end": {"kind": "count", "count": 3},
                        },
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    page = await OccurrenceService.page(
        session,
        user,
        resource="event",
        from_datetime=datetime(2026, 10, 1, tzinfo=UTC),
        to_datetime=datetime(2026, 11, 30, tzinfo=UTC),
        limit=100,
    )
    assert page.total == 3
    assert {item.series_id for item in page.items} == {created.target_id}
    assert len({item.occurrence_key for item in page.items}) == 3


@pytest.mark.asyncio
async def test_preview_uses_last_five_dates_for_an_ended_series(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Завершившийся курс",
                        "starts_at": datetime(2025, 1, 1, 8, tzinfo=UTC),
                        "recurrence": {
                            "frequency": "daily",
                            "end": {"kind": "count", "count": 8},
                        },
                    },
                )
            ],
            origin="rest",
        )
    )[0]

    preview = await OccurrenceService.preview(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        now=datetime(2026, 1, 1, tzinfo=UTC),
    )

    assert [item.scheduled_at.day for item in preview.items] == [4, 5, 6, 7, 8]
    assert preview.total == 8
    assert preview.has_more is True


@pytest.mark.asyncio
async def test_update_cannot_make_an_undated_task_recurring(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Без срока"})],
            origin="rest",
        )
    )[0]

    with pytest.raises(CalendarValidationError):
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update",
                    "task",
                    {"recurrence": {"frequency": "daily"}},
                    created.target_id,
                )
            ],
            origin="rest",
        )


@pytest.mark.asyncio
async def test_completed_occurrence_does_not_complete_the_other_repeats(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "task",
                    {
                        "title": "Практика",
                        "deadline": datetime(2026, 10, 20, 8, 30, tzinfo=UTC),
                        "recurrence": {"frequency": "daily", "end": {"kind": "count", "count": 2}},
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    page = await OccurrenceService.page(
        session,
        user,
        resource="task",
        from_datetime=datetime(2026, 10, 19, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 23, tzinfo=UTC),
        limit=100,
    )
    await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "update",
                "task",
                {"status": "completed"},
                created.target_id,
                scope="occurrence",
                occurrence_key=page.items[0].occurrence_key,
            )
        ],
        origin="rest",
    )
    refreshed = await OccurrenceService.page(
        session,
        user,
        resource="task",
        from_datetime=datetime(2026, 10, 19, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 23, tzinfo=UTC),
        limit=100,
    )
    assert [item.data["status"] for item in refreshed.items] == ["completed", "open"]
    second = refreshed.items[1]
    await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "update",
                "task",
                {"status": "completed"},
                created.target_id,
                scope="occurrence",
                occurrence_key=second.occurrence_key,
            )
        ],
        origin="rest",
    )
    task = await session.get(Task, created.target_id)
    await session.refresh(task)
    assert task.status == "completed"


@pytest.mark.asyncio
async def test_moved_occurrence_enters_new_range_and_undo_restores_it(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Урок",
                        "starts_at": datetime(2026, 10, 20, 8, tzinfo=UTC),
                        "recurrence": {"frequency": "weekly"},
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    initial = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 21, tzinfo=UTC),
        limit=10,
    )
    moved_at = datetime(2026, 11, 1, 12, tzinfo=UTC)
    moved = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update",
                    "event",
                    {"starts_at": moved_at},
                    created.target_id,
                    scope="occurrence",
                    occurrence_key=initial.items[0].occurrence_key,
                )
            ],
            origin="rest",
        )
    )[0]
    destination = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 11, 1, tzinfo=UTC),
        to_datetime=datetime(2026, 11, 2, tzinfo=UTC),
        limit=10,
    )
    assert [item.scheduled_at for item in destination.items] == [moved_at]

    await CalendarCommandService.undo(session, user, moved.id)
    restored = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 21, tzinfo=UTC),
        limit=10,
    )
    assert len(restored.items) == 1


@pytest.mark.asyncio
async def test_replay_rebuilds_occurrence_exceptions(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "task",
                    {
                        "title": "Повтор",
                        "deadline": datetime(2026, 10, 20, 8, tzinfo=UTC),
                        "recurrence": {"frequency": "daily", "end": {"kind": "count", "count": 2}},
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    page = await OccurrenceService.page(
        session,
        user,
        resource="task",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 23, tzinfo=UTC),
        limit=10,
    )
    await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "update",
                "task",
                {"status": "completed"},
                created.target_id,
                scope="occurrence",
                occurrence_key=page.items[0].occurrence_key,
            )
        ],
        origin="rest",
    )
    await CalendarCommandService.replay(session, user)
    replayed = await OccurrenceService.page(
        session,
        user,
        resource="task",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 23, tzinfo=UTC),
        limit=10,
    )
    assert [item.data["status"] for item in replayed.items] == ["completed", "open"]


@pytest.mark.asyncio
async def test_series_schedule_edit_preserves_past_and_changes_future(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "create",
                    "event",
                    {
                        "title": "Серия",
                        "starts_at": datetime(2026, 10, 20, 8, tzinfo=UTC),
                        "recurrence": {"frequency": "daily", "end": {"kind": "count", "count": 4}},
                    },
                )
            ],
            origin="rest",
        )
    )[0]
    original = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 25, tzinfo=UTC),
        limit=10,
    )
    changed_operation = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update",
                    "event",
                    {"starts_at": datetime(2026, 10, 22, 10, tzinfo=UTC)},
                    created.target_id,
                    effective_from_occurrence_key=original.items[2].occurrence_key,
                )
            ],
            origin="rest",
        )
    )[0]
    changed = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 25, tzinfo=UTC),
        limit=10,
    )
    assert [item.scheduled_at for item in changed.items] == [
        datetime(2026, 10, 20, 8, tzinfo=UTC),
        datetime(2026, 10, 21, 8, tzinfo=UTC),
        datetime(2026, 10, 22, 10, tzinfo=UTC),
        datetime(2026, 10, 23, 10, tzinfo=UTC),
        datetime(2026, 10, 24, 10, tzinfo=UTC),
    ]
    await CalendarCommandService.undo(session, user, changed_operation.id)
    restored = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=created.target_id,
        from_datetime=datetime(2026, 10, 20, tzinfo=UTC),
        to_datetime=datetime(2026, 10, 25, tzinfo=UTC),
        limit=10,
    )
    assert [item.scheduled_at for item in restored.items] == [
        datetime(2026, 10, 20, 8, tzinfo=UTC),
        datetime(2026, 10, 21, 8, tzinfo=UTC),
        datetime(2026, 10, 22, 8, tzinfo=UTC),
        datetime(2026, 10, 23, 8, tzinfo=UTC),
    ]
