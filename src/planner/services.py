import uuid
from datetime import UTC, datetime
from typing import ClassVar
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Event, Reminder, Task, User


def normalize_datetime(value: datetime | None, user: User) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo(user.timezone))
    return value.astimezone(UTC)


def _normalize_payload(data: dict, user: User, datetime_fields: set[str]) -> dict:
    result = dict(data)
    for field in datetime_fields & result.keys():
        value = result[field]
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        result[field] = normalize_datetime(value, user)
    return result


class ResourceService:
    model = Task
    datetime_fields: ClassVar[set[str]] = set()

    @classmethod
    def _range_conditions(
        cls,
        user: User,
        from_datetime: datetime | None,
        to_datetime: datetime | None,
    ) -> list:
        if not cls.datetime_fields:
            return []
        column = getattr(cls.model, next(iter(cls.datetime_fields)))
        conditions = []
        if from_datetime is not None:
            conditions.append(column >= normalize_datetime(from_datetime, user))
        if to_datetime is not None:
            conditions.append(column < normalize_datetime(to_datetime, user))
        return conditions

    @classmethod
    async def list(
        cls,
        session: AsyncSession,
        user: User,
        *,
        from_datetime: datetime | None = None,
        to_datetime: datetime | None = None,
    ):
        conditions = [
            cls.model.owner_id == user.id,
            *cls._range_conditions(user, from_datetime, to_datetime),
        ]
        order_column = getattr(cls.model, next(iter(cls.datetime_fields)), cls.model.id)
        query = select(cls.model).where(*conditions).order_by(order_column, cls.model.id)
        return list((await session.scalars(query)).all())

    @classmethod
    async def page(
        cls,
        session: AsyncSession,
        user: User,
        *,
        limit: int,
        offset: int,
        from_datetime: datetime | None = None,
        to_datetime: datetime | None = None,
    ):
        conditions = [
            cls.model.owner_id == user.id,
            *cls._range_conditions(user, from_datetime, to_datetime),
        ]
        order_column = getattr(cls.model, next(iter(cls.datetime_fields)), cls.model.id)
        items = list(
            (
                await session.scalars(
                    select(cls.model)
                    .where(*conditions)
                    .order_by(order_column, cls.model.id)
                    .offset(offset)
                    .limit(limit)
                )
            ).all()
        )
        total = await session.scalar(select(func.count()).select_from(cls.model).where(*conditions))
        return items, int(total or 0)

    @classmethod
    async def get(cls, session: AsyncSession, user: User, ident: uuid.UUID):
        query = select(cls.model).where(cls.model.id == ident, cls.model.owner_id == user.id)
        return await session.scalar(query)


class TaskService(ResourceService):
    model = Task
    datetime_fields: ClassVar[set[str]] = {"deadline"}

    @classmethod
    async def page(
        cls,
        session: AsyncSession,
        user: User,
        *,
        limit: int,
        offset: int,
        from_datetime: datetime | None = None,
        to_datetime: datetime | None = None,
        status: str | None = None,
        deadline_presence: str = "any",
    ):
        conditions = [
            cls.model.owner_id == user.id,
            *cls._range_conditions(user, from_datetime, to_datetime),
        ]
        if status is not None:
            conditions.append(cls.model.status == status)
        if deadline_presence == "dated":
            conditions.append(cls.model.deadline.is_not(None))
        elif deadline_presence == "undated":
            conditions.append(cls.model.deadline.is_(None))
        items = list(
            (
                await session.scalars(
                    select(cls.model)
                    .where(*conditions)
                    .order_by(cls.model.deadline.asc().nulls_last(), cls.model.id)
                    .offset(offset)
                    .limit(limit)
                )
            ).all()
        )
        total = await session.scalar(select(func.count()).select_from(cls.model).where(*conditions))
        return items, int(total or 0)


class EventService(ResourceService):
    model = Event
    datetime_fields: ClassVar[set[str]] = {"starts_at"}


class ReminderService(ResourceService):
    model = Reminder
    datetime_fields: ClassVar[set[str]] = {"remind_at"}
