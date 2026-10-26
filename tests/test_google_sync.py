from datetime import UTC, datetime, timedelta

import pytest
from google_fake import FakeGoogleCalendar
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.calendar import CalendarCommandService, CalendarMutation
from planner.config import Settings
from planner.db import Base
from planner.google_sync import GoogleCalendarSync
from planner.models import CalendarOperation, Event, GoogleAccount, GoogleEventLink, User
from planner.occurrences import OccurrenceService

MOSCOW = "Europe/Moscow"
START = datetime(2030, 3, 4, 7, 0, tzinfo=UTC)  # Monday 10:00 in Moscow


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
    value = User(email="owner@example.test", password_hash="x", timezone=MOSCOW)
    session.add(value)
    await session.flush()
    session.add(
        GoogleAccount(
            user_id=value.id,
            subject="google-sub",
            email="owner@example.test",
            calendar_enabled=True,
            pushed_sequence=0,
        )
    )
    await session.commit()
    return value


@pytest.fixture
def google():
    return FakeGoogleCalendar()


async def sync(session, user, google):
    account = await session.get(GoogleAccount, user.id)
    result = await GoogleCalendarSync(
        session, user, account, google, Settings(llm_required=False), "access"
    ).run()
    await session.commit()
    return result


async def execute(session, user, *mutations):
    operations = await CalendarCommandService.execute(session, user, list(mutations), origin="rest")
    await session.commit()
    return operations


async def events(session, user) -> list[Event]:
    return list((await session.scalars(select(Event).where(Event.owner_id == user.id))).all())


async def test_local_event_is_pushed_once(session, user, google):
    await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "event",
            {"title": "Врач", "starts_at": START, "duration_minutes": 30, "location": "Каб. 5"},
        ),
    )

    result = await sync(session, user, google)
    [master] = google.masters()

    assert result.pushed == 1
    assert master["summary"] == "Врач"
    assert master["location"] == "Каб. 5"
    assert master["start"] == {"dateTime": "2030-03-04T10:00:00+03:00", "timeZone": MOSCOW}
    assert master["end"]["dateTime"] == "2030-03-04T10:30:00+03:00"

    google.calls.clear()
    await sync(session, user, google)
    assert google.writes() == []


async def test_google_event_is_imported_without_echo(session, user, google):
    google.g_create(
        summary="Созвон",
        start={"dateTime": "2030-03-05T12:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T12:45:00+03:00", "timeZone": MOSCOW},
    )

    result = await sync(session, user, google)
    [event] = await events(session, user)
    origins = list((await session.scalars(select(CalendarOperation.origin))).all())

    assert result.imported == 1
    assert event.title == "Созвон"
    assert event.duration_minutes == 45
    assert origins == ["google"]
    google.calls.clear()
    await sync(session, user, google)
    assert google.writes() == []
    assert len(await events(session, user)) == 1


async def test_updates_flow_in_both_directions(session, user, google):
    created = google.g_create(
        summary="Планёрка",
        start={"dateTime": "2030-03-05T09:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T09:30:00+03:00", "timeZone": MOSCOW},
    )
    await sync(session, user, google)

    google.g_update(created["id"], summary="Планёрка команды")
    await sync(session, user, google)
    [event] = await events(session, user)
    assert event.title == "Планёрка команды"

    await execute(
        session,
        user,
        CalendarMutation("update", "event", {"title": "Планёрка отдела"}, event.id),
    )
    await sync(session, user, google)
    assert google.items[created["id"]]["summary"] == "Планёрка отдела"
    assert len(google.masters()) == 1


async def test_deletions_flow_in_both_directions(session, user, google):
    remote = google.g_create(
        summary="Удалю в Google",
        start={"dateTime": "2030-03-05T09:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T09:30:00+03:00", "timeZone": MOSCOW},
    )
    [local_op] = await execute(
        session,
        user,
        CalendarMutation("create", "event", {"title": "Удалю тут", "starts_at": START}),
    )
    await sync(session, user, google)
    assert len(google.masters()) == 2

    google.g_cancel(remote["id"])
    await execute(session, user, CalendarMutation("delete", "event", {}, local_op.target_id))
    await sync(session, user, google)

    assert await events(session, user) == []
    assert google.masters() == []
    assert (await session.scalars(select(GoogleEventLink))).all() == []


async def test_recurring_series_with_exceptions_is_pushed(session, user, google):
    [created] = await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "event",
            {
                "title": "Йога",
                "starts_at": START,
                "duration_minutes": 60,
                "recurrence": {"frequency": "weekly", "weekdays": ["MO"]},
            },
        ),
    )
    page = await OccurrenceService.page(
        session, user, resource="event", from_datetime=START, to_datetime=START + timedelta(days=15)
    )
    moved, cancelled = page.items[1], page.items[2]
    await execute(
        session,
        user,
        CalendarMutation(
            "update",
            "event",
            {"starts_at": moved.original_at + timedelta(hours=2)},
            created.target_id,
            scope="occurrence",
            occurrence_key=moved.occurrence_key,
        ),
        CalendarMutation(
            "delete",
            "event",
            {},
            created.target_id,
            scope="occurrence",
            occurrence_key=cancelled.occurrence_key,
        ),
    )

    await sync(session, user, google)
    [master] = google.masters()
    moved_item = google.items[f"{master['id']}_20300311T070000Z"]
    cancelled_item = google.items[f"{master['id']}_20300318T070000Z"]

    assert master["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    assert moved_item["start"]["dateTime"] == "2030-03-11T12:00:00+03:00"
    assert cancelled_item["status"] == "cancelled"
    google.calls.clear()
    await sync(session, user, google)
    assert google.writes() == []


async def test_google_instance_override_becomes_an_occurrence_exception(session, user, google):
    master = google.g_create(
        summary="Бассейн",
        start={"dateTime": "2030-03-04T10:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-04T11:00:00+03:00", "timeZone": MOSCOW},
        recurrence=["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    )
    await sync(session, user, google)

    google.g_instance(
        master["id"],
        {"dateTime": "2030-03-11T10:00:00+03:00", "timeZone": MOSCOW},
        summary="Бассейн (перенос)",
        start={"dateTime": "2030-03-12T10:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-12T11:00:00+03:00", "timeZone": MOSCOW},
    )
    google.g_instance(
        master["id"],
        {"dateTime": "2030-03-18T10:00:00+03:00", "timeZone": MOSCOW},
        status="cancelled",
    )
    await sync(session, user, google)
    page = await OccurrenceService.page(
        session, user, resource="event", from_datetime=START, to_datetime=START + timedelta(days=22)
    )

    assert [(item.scheduled_at, item.data["title"]) for item in page.items] == [
        (START, "Бассейн"),
        (START + timedelta(days=8), "Бассейн (перенос)"),
        (START + timedelta(days=21), "Бассейн"),
    ]
    google.calls.clear()
    await sync(session, user, google)
    assert google.writes() == []


async def test_google_whole_series_edit_replaces_the_linked_version(session, user, google):
    master = google.g_create(
        summary="Английский",
        start={"dateTime": "2030-03-04T10:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-04T11:00:00+03:00", "timeZone": MOSCOW},
        recurrence=["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    )
    await sync(session, user, google)

    google.g_update(
        master["id"],
        start={"dateTime": "2030-03-03T18:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-03T19:00:00+03:00", "timeZone": MOSCOW},
        recurrence=["RRULE:FREQ=WEEKLY;BYDAY=SU"],
    )
    google.calls.clear()
    await sync(session, user, google)
    page = await OccurrenceService.page(
        session,
        user,
        resource="event",
        from_datetime=START - timedelta(days=7),
        to_datetime=START + timedelta(days=14),
    )

    assert [item.scheduled_at for item in page.items] == [
        datetime(2030, 3, 3, 15, 0, tzinfo=UTC),
        datetime(2030, 3, 10, 15, 0, tzinfo=UTC),
        datetime(2030, 3, 17, 15, 0, tzinfo=UTC),
    ]
    assert google.writes() == []
    assert len(google.masters()) == 1


async def test_newer_local_edit_wins_over_older_google_edit(session, user, google):
    created = google.g_create(
        summary="Отчёт",
        start={"dateTime": "2030-03-05T09:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T09:30:00+03:00", "timeZone": MOSCOW},
    )
    await sync(session, user, google)
    [event] = await events(session, user)

    google.g_update(created["id"], updated=datetime(2000, 1, 1, tzinfo=UTC), summary="Старое")
    await execute(session, user, CalendarMutation("update", "event", {"title": "Новое"}, event.id))
    await sync(session, user, google)

    await session.refresh(event)
    assert event.title == "Новое"
    assert google.items[created["id"]]["summary"] == "Новое"


async def test_unsupported_recurrence_is_skipped(session, user, google):
    google.g_create(
        summary="Сложное",
        start={"dateTime": "2030-03-05T09:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T09:30:00+03:00", "timeZone": MOSCOW},
        recurrence=["RRULE:FREQ=MONTHLY;BYDAY=MO,TU"],
    )

    result = await sync(session, user, google)

    assert result.skipped == 1
    assert await events(session, user) == []


async def test_expired_sync_token_falls_back_to_full_sync(session, user, google):
    google.g_create(
        summary="Один раз",
        start={"dateTime": "2030-03-05T09:00:00+03:00", "timeZone": MOSCOW},
        end={"dateTime": "2030-03-05T09:30:00+03:00", "timeZone": MOSCOW},
    )
    await sync(session, user, google)
    google.expire_tokens = True

    await sync(session, user, google)

    assert len(await events(session, user)) == 1
    assert ("list", "full") in google.calls[1:]


async def test_reconnect_adopts_previously_pushed_events(session, user, google):
    await execute(
        session,
        user,
        CalendarMutation("create", "event", {"title": "Своё", "starts_at": START}),
    )
    await sync(session, user, google)
    for link in (await session.scalars(select(GoogleEventLink))).all():
        await session.delete(link)
    account = await session.get(GoogleAccount, user.id)
    account.sync_token = None
    account.pushed_sequence = 0
    await session.commit()

    await sync(session, user, google)

    assert len(google.masters()) == 1
    assert len(await events(session, user)) == 1


async def test_local_this_and_following_edit_splits_the_google_series(session, user, google):
    [created] = await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "event",
            {
                "title": "Курс",
                "starts_at": START,
                "duration_minutes": 60,
                "recurrence": {"frequency": "weekly", "weekdays": ["MO"]},
            },
        ),
    )
    await sync(session, user, google)
    page = await OccurrenceService.page(
        session, user, resource="event", from_datetime=START, to_datetime=START + timedelta(days=15)
    )
    third = page.items[2]
    await execute(
        session,
        user,
        CalendarMutation(
            "update",
            "event",
            {"starts_at": third.original_at + timedelta(hours=1)},
            created.target_id,
            effective_from_occurrence_key=third.occurrence_key,
        ),
    )

    await sync(session, user, google)
    masters = sorted(google.masters(), key=lambda item: item["start"]["dateTime"])

    assert [item["start"]["dateTime"] for item in masters] == [
        "2030-03-04T10:00:00+03:00",
        "2030-03-18T11:00:00+03:00",
    ]
    assert masters[0]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20300311T070000Z"]
    assert masters[1]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


async def test_all_day_event_roundtrips_as_all_day(session, user, google):
    created = google.g_create(
        summary="Отпуск",
        start={"date": "2030-03-04"},
        end={"date": "2030-03-07"},
    )
    await sync(session, user, google)
    [event] = await events(session, user)
    assert event.starts_at.replace(tzinfo=UTC) == datetime(2030, 3, 3, 21, 0, tzinfo=UTC)
    assert event.duration_minutes == 3 * 24 * 60

    await execute(
        session, user, CalendarMutation("update", "event", {"title": "Отпуск!"}, event.id)
    )
    await sync(session, user, google)

    assert google.items[created["id"]]["start"] == {"date": "2030-03-04"}
    assert google.items[created["id"]]["end"] == {"date": "2030-03-07"}


async def test_local_edit_keeps_google_only_fields(session, user, google):
    created = google.g_create(
        summary="Планёрка",
        start={"dateTime": "2030-03-04T10:00:00+03:00"},
        end={"dateTime": "2030-03-04T11:00:00+03:00"},
        attendees=[{"email": "colleague@example.com"}],
        conferenceData={"entryPoints": [{"uri": "https://meet.example/abc"}]},
    )
    await sync(session, user, google)
    [event] = await events(session, user)

    await execute(session, user, CalendarMutation("update", "event", {"title": "Ретро"}, event.id))
    await sync(session, user, google)

    saved = google.items[created["id"]]
    assert saved["summary"] == "Ретро"
    assert saved["attendees"] == [{"email": "colleague@example.com"}]
    assert "conferenceData" in saved
    [(_, body)] = google.bodies
    assert "attendees" not in body and "conferenceData" not in body


async def test_birthday_edit_sends_only_fields_google_accepts(session, user, google):
    created = google.g_create(
        summary="С днем рождения!",
        eventType="birthday",
        start={"date": "2030-11-03"},
        end={"date": "2030-11-04"},
        recurrence=["RRULE:FREQ=YEARLY"],
    )
    await sync(session, user, google)
    [event] = await events(session, user)

    await execute(
        session,
        user,
        CalendarMutation(
            "update", "event", {"title": "ДР Маши", "description": "Купить торт"}, event.id
        ),
    )
    await sync(session, user, google)

    assert google.items[created["id"]]["summary"] == "ДР Маши"
    assert [set(body) for _, body in google.bodies] == [{"summary"}]
    account = await session.get(GoogleAccount, user.id)
    assert account.pushed_sequence == 2


async def test_rejected_update_does_not_block_other_changes(session, user, google):
    first = google.g_create(
        summary="Первое",
        start={"dateTime": "2030-03-04T10:00:00+03:00"},
        end={"dateTime": "2030-03-04T11:00:00+03:00"},
    )
    await sync(session, user, google)
    [imported] = await events(session, user)
    google.reject_updates.add(first["id"])

    await execute(
        session,
        user,
        CalendarMutation("update", "event", {"title": "Не примут"}, imported.id),
        CalendarMutation("create", "event", {"title": "Второе", "starts_at": START}),
    )
    result = await sync(session, user, google)

    assert result.skipped == 1
    assert sorted(item["summary"] for item in google.masters()) == ["Второе", "Первое"]
    account = await session.get(GoogleAccount, user.id)
    assert account.pushed_sequence == 3


async def test_linked_reminders_become_google_notifications(session, user, google):
    [created] = await execute(
        session,
        user,
        CalendarMutation("create", "event", {"title": "Врач", "starts_at": START}),
    )
    await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "reminder",
            {
                "title": "Скоро врач",
                "linked_resource": "event",
                "linked_id": created.target_id,
                "relative_offset_minutes": -30,
            },
        ),
        CalendarMutation(
            "create",
            "reminder",
            {
                "title": "Завтра врач",
                "linked_resource": "event",
                "linked_id": created.target_id,
                "relative_offset_minutes": -1440,
            },
        ),
    )
    await sync(session, user, google)
    [master] = google.masters()
    assert master["reminders"] == {
        "useDefault": False,
        "overrides": [
            {"method": "popup", "minutes": 30},
            {"method": "popup", "minutes": 1440},
        ],
    }

    reminders = (
        await session.scalars(
            select(CalendarOperation.target_id).where(CalendarOperation.resource == "reminder")
        )
    ).all()
    await execute(
        session,
        user,
        *[CalendarMutation("delete", "reminder", {}, target) for target in reminders],
    )
    await sync(session, user, google)

    assert google.items[master["id"]]["reminders"] == {"useDefault": True}


async def test_reminders_of_recurring_events_stay_local(session, user, google):
    [created] = await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "event",
            {"title": "Зарядка", "starts_at": START, "recurrence": {"frequency": "daily"}},
        ),
    )
    await execute(
        session,
        user,
        CalendarMutation(
            "create",
            "reminder",
            {
                "title": "Скоро зарядка",
                "linked_resource": "event",
                "linked_id": created.target_id,
                "relative_offset_minutes": -10,
            },
        ),
    )
    await sync(session, user, google)

    [master] = google.masters()
    assert "reminders" not in master


async def test_full_resync_learns_event_types_of_linked_events(session, user, google):
    created = google.g_create(
        summary="С днем рождения!",
        eventType="birthday",
        start={"date": "2030-11-03"},
        end={"date": "2030-11-04"},
    )
    await sync(session, user, google)
    link = await session.scalar(select(GoogleEventLink))
    link.event_type = "default"  # links created before event types were tracked
    account = await session.get(GoogleAccount, user.id)
    account.sync_token = None
    await session.commit()

    await sync(session, user, google)

    assert (await session.scalar(select(GoogleEventLink))).event_type == "birthday"
    assert google.items[created["id"]]["summary"] == "С днем рождения!"
