import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import notifier
from planner.calendar import CalendarCommandService as Commands
from planner.calendar import CalendarMutation as Mutation
from planner.calendar import CalendarValidationError
from planner.db import Base
from planner.models import Notification, NotificationDelivery, PushSubscription, Reminder, User


@pytest.fixture
async def context(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(notifier, "SessionLocal", factory)
    async with factory() as session:
        user = User(email="reminder@example.com", password_hash="x", timezone="UTC")
        session.add(user)
        await session.commit()
        yield session, user, factory
    await engine.dispose()


async def create(session, user, resource, payload):
    return (
        await Commands.execute(
            session, user, [Mutation("create", resource, payload)], origin="agent"
        )
    )[0]


async def linked(context):
    session, user, _ = context
    event = await create(
        session, user, "event", {"title": "Lesson", "starts_at": "2030-01-01T10:00:00Z"}
    )
    operation = await create(
        session,
        user,
        "reminder",
        {
            "title": "Lesson reminder",
            "linked_resource": "event",
            "linked_id": str(event.target_id),
            "relative_offset_minutes": -60,
        },
    )
    return event, await session.get(Reminder, operation.target_id)


async def test_relative_reminder_tracks_agent_move_and_undo(context):
    session, user, _ = context
    event, reminder = await linked(context)
    assert reminder.remind_at.hour == 9
    move = (
        await Commands.execute(
            session,
            user,
            [Mutation("update", "event", {"starts_at": "2030-01-01T12:00:00Z"}, event.target_id)],
            origin="agent",
        )
    )[0]
    assert reminder.remind_at.hour == 11
    await Commands.undo(session, user, move.id)
    assert reminder.remind_at.hour == 9


async def test_reminder_update_and_cancel_have_history(context):
    session, user, _ = context
    _, reminder = await linked(context)
    changed = await Commands.execute(
        session,
        user,
        [Mutation("update", "reminder", {"title": "New title"}, reminder.id)],
        origin="rest",
    )
    assert changed[0].after_state["title"] == "New title"
    deletion = (
        await Commands.execute(
            session, user, [Mutation("delete", "reminder", {}, reminder.id)], origin="rest"
        )
    )[0]
    assert reminder.status == "cancelled"
    await Commands.undo(session, user, deletion.id)
    assert reminder.status == "active"


async def test_source_delete_undo_restores_only_automatically_cancelled(context):
    session, user, _ = context
    event, reminder = await linked(context)
    manual = await create(
        session,
        user,
        "reminder",
        {
            "title": "Manual",
            "remind_at": "2030-01-01T08:00:00Z",
            "linked_resource": "event",
            "linked_id": str(event.target_id),
        },
    )
    await Commands.execute(
        session, user, [Mutation("delete", "reminder", {}, manual.target_id)], origin="rest"
    )
    deleted = (
        await Commands.execute(
            session, user, [Mutation("delete", "event", {}, event.target_id)], origin="agent"
        )
    )[0]
    assert reminder.status == "cancelled"
    await Commands.undo(session, user, deleted.id)
    assert reminder.status == "active"
    assert (await session.get(Reminder, manual.target_id)).status == "cancelled"


async def test_foreign_link_rejected_atomically(context):
    session, user, _ = context
    with pytest.raises(CalendarValidationError):
        await create(
            session,
            user,
            "reminder",
            {
                "title": "No access",
                "remind_at": "2030-01-01T08:00:00Z",
                "linked_resource": "event",
                "linked_id": str(uuid.uuid4()),
            },
        )
    assert await session.scalar(select(func.count()).select_from(Reminder)) == 0


async def test_notifier_catches_up_once_and_read_deletion_does_not_refire(context):
    session, user, _ = context
    operation = await create(
        session, user, "reminder", {"title": "Overdue", "remind_at": "2000-01-01T00:00:00Z"}
    )
    await session.commit()
    assert await notifier.process_due_reminders({}) == 1
    assert await notifier.process_due_reminders({}) == 0
    await session.refresh(await session.get(Reminder, operation.target_id))
    assert (await session.get(Reminder, operation.target_id)).status == "fired"
    notice = await session.scalar(select(Notification))
    await session.delete(notice)
    await session.commit()
    assert await notifier.process_due_reminders({}) == 0


@pytest.mark.parametrize(
    "status,expected,active",
    [(410, "discarded", False), (400, "failed", True), (503, "pending", True)],
)
async def test_push_http_errors_and_subscription_expiry(
    context, monkeypatch, status, expected, active
):
    session, user, _ = context
    await create(session, user, "reminder", {"title": "Push", "remind_at": "2000-01-01T00:00:00Z"})
    subscription = PushSubscription(
        owner_id=user.id, endpoint="https://push.example.com/send", p256dh="key", auth="secret"
    )
    session.add(subscription)
    await session.commit()
    await notifier.process_due_reminders({})

    async def fail(*args):
        error = RuntimeError("must not leak subscription secrets")
        error.response = SimpleNamespace(status_code=status)
        raise error

    monkeypatch.setattr(notifier, "_send_web_push", fail)
    await notifier.deliver_pending_notifications({})
    delivery = await session.scalar(
        select(NotificationDelivery).execution_options(populate_existing=True)
    )
    await session.refresh(subscription)
    assert delivery.status == expected
    assert subscription.active is active
    assert "secret" not in (delivery.last_error or "")


async def test_push_expires_after_24_hours(context, monkeypatch):
    session, user, _ = context
    await create(session, user, "reminder", {"title": "Old", "remind_at": "2000-01-01T00:00:00Z"})
    session.add(
        PushSubscription(
            owner_id=user.id, endpoint="https://push.example.com/send", p256dh="key", auth="secret"
        )
    )
    await session.commit()
    await notifier.process_due_reminders({})
    notice = await session.scalar(select(Notification))
    notice.created_at = datetime.now(UTC) - timedelta(hours=25)
    await session.commit()
    calls = []

    async def send(*args):
        calls.append(args)

    monkeypatch.setattr(notifier, "_send_web_push", send)
    await notifier.deliver_pending_notifications({})
    assert calls == []
    assert (await session.scalar(select(NotificationDelivery))).status == "failed"


async def test_http_crud_is_owner_scoped_and_audited(context, monkeypatch):
    import httpx

    from planner import main
    from planner.db import get_session
    from planner.models import CalendarOperation
    from planner.security import current_user

    session, user, _ = context

    async def database():
        yield session

    async def schedule(*args):
        return None

    main.app.dependency_overrides[get_session] = database
    main.app.dependency_overrides[current_user] = lambda: user
    monkeypatch.setattr(main, "_schedule_index", schedule)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/reminders", json={"title": "API", "remind_at": "2030-01-01T09:00:00Z"}
            )
            assert response.status_code == 201, response.text
            ident = response.json()["id"]
            assert (
                await client.patch(f"/reminders/{ident}", json={"title": "Updated"})
            ).status_code == 200
            assert (await client.delete(f"/reminders/{ident}")).status_code == 204
            assert (await client.get(f"/reminders/{ident}")).json()["status"] == "cancelled"
            assert await session.scalar(select(func.count()).select_from(CalendarOperation)) == 3
            other = User(email="other-api@example.com", password_hash="x", timezone="UTC")
            session.add(other)
            await session.commit()
            main.app.dependency_overrides[current_user] = lambda: other
            assert (await client.get(f"/reminders/{ident}")).status_code == 404
            assert (await client.get("/reminders")).json()["items"] == []
    finally:
        main.app.dependency_overrides.clear()


async def test_completed_task_reopens_its_automatic_reminders(context):
    session, user, _ = context
    task = await create(
        session, user, "task", {"title": "Task", "deadline": "2030-01-01T10:00:00Z"}
    )
    operation = await create(
        session,
        user,
        "reminder",
        {
            "title": "Due",
            "linked_resource": "task",
            "linked_id": str(task.target_id),
            "relative_offset_minutes": -30,
        },
    )
    reminder = await session.get(Reminder, operation.target_id)
    await Commands.execute(
        session,
        user,
        [Mutation("update", "task", {"status": "completed"}, task.target_id)],
        origin="agent",
    )
    assert reminder.status == "cancelled"
    await Commands.execute(
        session,
        user,
        [Mutation("update", "task", {"status": "open"}, task.target_id)],
        origin="agent",
    )
    assert reminder.status == "active"


async def test_replay_preserves_inbox_and_does_not_resend(context):
    session, user, _ = context
    operation = await create(
        session, user, "reminder", {"title": "Replay", "remind_at": "2000-01-01T00:00:00Z"}
    )
    await session.commit()
    await notifier.process_due_reminders({})
    await session.refresh(await session.get(Reminder, operation.target_id))
    await Commands.replay(session, user)
    await session.commit()
    assert (await session.get(Reminder, operation.target_id)).status == "fired"
    assert await session.scalar(select(func.count()).select_from(Notification)) == 1
    assert await notifier.process_due_reminders({}) == 0


async def test_push_success_uses_single_outbox_row(context, monkeypatch):
    session, user, _ = context
    await create(
        session, user, "reminder", {"title": "Success", "remind_at": "2000-01-01T00:00:00Z"}
    )
    session.add(
        PushSubscription(
            owner_id=user.id,
            endpoint="https://fcm.googleapis.com/fcm/send/test",
            p256dh="key",
            auth="secret",
        )
    )
    await session.commit()
    await notifier.process_due_reminders({})
    calls = []

    async def send(subscription, notice):
        calls.append(notice.id)

    monkeypatch.setattr(notifier, "_send_web_push", send)
    assert await notifier.deliver_pending_notifications({}) == 1
    assert await notifier.deliver_pending_notifications({}) == 0
    assert len(calls) == 1


async def test_actionable_list_includes_overdue_but_not_completed_or_undated(context):
    from planner.agent_tools import ListTasksArgs, default_tool_registry

    session, user, _ = context
    for title, deadline, status in [
        ("Overdue", "2020-01-01T10:00:00Z", "open"),
        ("Done", "2020-01-01T11:00:00Z", "completed"),
        ("Undated", None, "open"),
    ]:
        await create(
            session, user, "task", {"title": title, "deadline": deadline, "status": status}
        )
    args = ListTasksArgs.model_validate(
        {"time_range": {"from": "2030-01-01T00:00:00Z", "to": "2030-01-08T00:00:00Z"}}
    )
    items = await default_tool_registry()["list_tasks"].executor(
        SimpleNamespace(session=session, owner_id=user.id), args, 100
    )
    assert [item["data"]["data"]["title"] for item in items] == ["Overdue"]
