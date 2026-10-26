"""Shared reminder invariants for REST, agent commands and undo."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Event, Reminder, Task, User
from .services import normalize_datetime


async def resolve_reminder(
    session: AsyncSession, user: User, payload: dict, *, current: Reminder | None = None
) -> dict:
    values = dict(payload)
    resource = values.get("linked_resource", current.linked_resource if current else None)
    ident = values.get("linked_id", current.linked_id if current else None)
    offset = values.get(
        "relative_offset_minutes", current.relative_offset_minutes if current else None
    )
    if current is not None and current.status == "fired":
        raise ValueError("Сработавшее напоминание нельзя изменить; создайте новое")
    if resource and ident:
        model = {"task": Task, "event": Event}[resource]
        source = await session.scalar(
            select(model)
            .where(model.owner_id == user.id, model.id == uuid.UUID(str(ident)))
            .with_for_update()
        )
        if source is None:
            raise ValueError("Связанная запись не найдена")
        if (
            resource == "task"
            and source.status == "completed"
            and values.get("status", "active") == "active"
        ):
            raise ValueError("Задача уже выполнена")
        if offset is not None:
            anchor = source.deadline if resource == "task" else source.starts_at
            if anchor is None:
                raise ValueError("Для относительного напоминания необходим срок")
            values["remind_at"] = normalize_datetime(anchor, user) + timedelta(minutes=offset)
    elif offset is not None:
        raise ValueError("Относительное напоминание требует связанной записи")
    if (
        current is not None
        and values.get("relative_offset_minutes", 0) is None
        and current.relative_offset_minutes is not None
        and "remind_at" not in values
    ):
        values["remind_at"] = current.remind_at
    if current is not None and values.get("status") == "cancelled":
        values["cancelled_reason"] = "user"
        values["cancelled_at"] = datetime.now(UTC)
    elif current is not None and values.get("status") == "active":
        values["cancelled_reason"] = None
        values["cancelled_at"] = None
    return values
