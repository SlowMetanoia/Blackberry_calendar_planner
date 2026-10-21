import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import notifier
from planner.models import Notification, Reminder, User


@pytest.mark.skipif(
    not os.getenv("REMINDER_TEST_DATABASE_URL"), reason="requires isolated PostgreSQL"
)
async def test_parallel_notifiers_create_one_inbox_record(monkeypatch):
    engine = create_async_engine(os.environ["REMINDER_TEST_DATABASE_URL"])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(notifier, "SessionLocal", factory)
    async with factory() as session:
        user = User(
            email=f"concurrent-{uuid.uuid4()}@example.com", password_hash="x", timezone="UTC"
        )
        session.add(user)
        await session.flush()
        reminder = Reminder(
            owner_id=user.id, title="Concurrent", remind_at=datetime.now(UTC) - timedelta(days=1)
        )
        session.add(reminder)
        await session.commit()
        await asyncio.gather(*(notifier.process_due_reminders({}) for _ in range(4)))
        await session.refresh(reminder)
        assert reminder.status == "fired"
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.reminder_id == reminder.id)
            )
            == 1
        )
    await engine.dispose()
