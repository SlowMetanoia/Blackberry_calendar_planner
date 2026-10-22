import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.calendar import CalendarCommandService, CalendarMutation
from planner.collisions import collision_report, overlaps
from planner.db import Base
from planner.models import Event, User
from planner.occurrences import OccurrenceService
from planner.voice import speech_text_for_payload


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as value:
        yield value
    await engine.dispose()


@pytest.fixture
async def user(session):
    value = User(email="collision@test.example", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


@pytest.mark.parametrize(
    "a,ad,b,bd,expected",
    [
        (15, 60, 16, 60, False),
        (15, 120, 16, 60, True),
        (15, 120, 16, None, True),
        (15, 60, 16, None, False),
        (15, None, 15, None, True),
        (15, None, 16, None, False),
    ],
)
def test_overlap_boundaries_and_unknown_duration(a, ad, b, bd, expected):
    def at(hour):
        return datetime(2026, 10, 25, hour, tzinfo=UTC)

    assert overlaps(at(a), ad, at(b), bd) is expected


def test_overlap_uses_absolute_time_across_dst_and_midnight():
    assert overlaps(
        datetime.fromisoformat("2026-10-25T02:30:00+02:00"),
        120,
        datetime.fromisoformat("2026-10-25T02:30:00+01:00"),
        None,
    )
    assert overlaps(
        datetime.fromisoformat("2026-10-25T23:30:00Z"),
        120,
        datetime.fromisoformat("2026-10-26T00:30:00Z"),
        30,
    )


@pytest.mark.asyncio
async def test_report_uses_final_batch_and_owner_scope(session, user):
    other = User(email="other@collision.test", password_hash="x")
    session.add(other)
    await session.flush()
    payload = {
        "title": "Политех",
        "starts_at": datetime(2026, 10, 25, 15, tzinfo=UTC),
        "duration_minutes": 120,
    }
    await CalendarCommandService.execute(
        session, other, [CalendarMutation("create", "event", payload)], origin="rest"
    )
    operations = await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation("create", "event", payload),
            CalendarMutation(
                "create", "event", {**payload, "title": "Пара", "duration_minutes": None}
            ),
        ],
        origin="agent",
    )
    report = await collision_report(session, user, operations)
    assert len(report.groups) == 1
    assert len(report.groups[0].occurrences) == 1
    assert report.groups[0].occurrences[0].kind == "point"
    assert report.groups[0].occurrences[0].first["data"]["title"] in {"Политех", "Пара"}


async def create(session, user, title, start, duration=None, **extra):
    return await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "create",
                "event",
                {"title": title, "starts_at": start, "duration_minutes": duration, **extra},
            )
        ],
        origin="rest",
    )


@pytest.mark.asyncio
async def test_long_event_before_window_and_noop_schedule_update(session, user):
    start = datetime(2026, 10, 25, 15, tzinfo=UTC)
    await create(session, user, "Long", start - timedelta(days=3), 5 * 24 * 60)
    ops = await create(session, user, "Point", start)
    assert len((await collision_report(session, user, ops)).groups) == 1
    renamed = await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "update", "event", {"title": "New name", "starts_at": start}, ops[0].target_id
            )
        ],
        origin="rest",
    )
    assert not (await collision_report(session, user, renamed)).groups


@pytest.mark.asyncio
async def test_recurring_pagination_cancelled_and_moved_occurrences(session, user):
    start = datetime(2026, 10, 25, 15, tzinfo=UTC)
    rule = {"frequency": "daily", "interval": 1, "end": {"kind": "never"}}
    existing = await create(session, user, "Daily", start, 60, recurrence=rule)
    created = await create(
        session, user, "Other daily", start + timedelta(minutes=30), 60, recurrence=rule
    )
    report = await collision_report(session, user, created)
    assert len(report.groups) == 1
    assert len(report.groups[0].occurrences) == 365
    page = await OccurrenceService.page(
        session,
        user,
        resource="event",
        series_id=existing[0].target_id,
        from_datetime=start,
        to_datetime=start + timedelta(days=1),
    )
    key = page.items[0].occurrence_key
    await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "delete", "event", {}, existing[0].target_id, scope="occurrence", occurrence_key=key
            )
        ],
        origin="rest",
    )
    assert len((await collision_report(session, user, created)).groups[0].occurrences) == 364
    moved = await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation(
                "update",
                "event",
                {"starts_at": start + timedelta(minutes=45)},
                created[0].target_id,
                scope="occurrence",
                occurrence_key=report.groups[0].occurrences[0].first["occurrence_key"],
            )
        ],
        origin="rest",
    )
    assert not (await collision_report(session, user, moved)).groups


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["warn", "hide", "failure", "invalid_reference"])
async def test_agent_receives_saved_collisions_and_controls_notifications(
    session, user, monkeypatch, mode
):
    from test_react_agent import runtime_context, tool_call

    from planner import agent

    start = datetime(2026, 10, 25, 15, tzinfo=UTC)
    await create(session, user, "Политех", start, 120)
    context = await runtime_context(session, user)
    calls = []

    async def complete(messages, tools):
        calls.append(tools)
        if len(calls) == 1:
            return tool_call(
                "commit",
                "commit_calendar_command",
                {
                    "reply": "Создана пара",
                    "mutations": [
                        {
                            "operation": "create",
                            "resource": "event",
                            "payload": {"title": "Пара", "starts_at": start.isoformat()},
                        }
                    ],
                },
            )
        result = json.loads(messages[-2]["content"])
        assert result["ok"] and len(result["collision_report"]["groups"]) == 1
        assert [tool["function"]["name"] for tool in tools] == ["finish_collision_response"]
        if mode == "failure":
            raise RuntimeError("model unavailable")
        notice = {
            "collision_id": result["collision_report"]["groups"][0]["id"],
            "text": "Возможно пересечение в 18:00.",
        }
        if mode == "invalid_reference":
            notice["collision_id"] = "invented"
        return tool_call(
            "respond",
            "finish_collision_response",
            {"reply": "Пара сохранена", "collision_notices": [] if mode == "hide" else [notice]},
        )

    monkeypatch.setattr(agent, "_complete_react", complete)
    result = await agent.run_agent("Запиши пару", context)
    payload = json.loads(result.result)
    assert result.state == "completed"
    assert len(calls) == 2
    assert len(payload["operations"]) == 1
    assert bool(payload["collision_notices"]) == (mode != "hide")
    speech = speech_text_for_payload(payload, user.timezone)
    if mode == "warn":
        assert "Возможно пересечение" in speech
    # Successful changes survive a subsequent rollback and failed response generation.
    await session.rollback()
    assert len((await session.scalars(select(Event))).all()) == 2
