import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Event, Task, User


def normalize_datetime(value: datetime | None, user: User) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo(user.timezone))
    return value.astimezone(timezone.utc)


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
    datetime_fields: set[str] = set()

    @classmethod
    async def create(cls, session: AsyncSession, user: User, data: dict):
        obj = cls.model(owner_id=user.id, **_normalize_payload(data, user, cls.datetime_fields))
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        return obj

    @classmethod
    async def list(cls, session: AsyncSession, user: User):
        query = select(cls.model).where(cls.model.owner_id == user.id)
        return list((await session.scalars(query)).all())

    @classmethod
    async def page(cls, session: AsyncSession, user: User, *, limit: int, offset: int):
        base = cls.model.owner_id == user.id
        items = list((await session.scalars(
            select(cls.model).where(base).offset(offset).limit(limit)
        )).all())
        total = await session.scalar(select(func.count()).select_from(cls.model).where(base))
        return items, int(total or 0)

    @classmethod
    async def get(cls, session: AsyncSession, user: User, ident: uuid.UUID):
        query = select(cls.model).where(cls.model.id == ident, cls.model.owner_id == user.id)
        return await session.scalar(query)

    @classmethod
    async def update(cls, session: AsyncSession, user: User, ident: uuid.UUID, data: dict):
        obj = await cls.get(session, user, ident)
        if obj is None:
            return None
        for key, value in _normalize_payload(data, user, cls.datetime_fields).items():
            setattr(obj, key, value)
        await session.commit()
        await session.refresh(obj)
        return obj

    @classmethod
    async def delete(cls, session: AsyncSession, user: User, ident: uuid.UUID):
        obj = await cls.get(session, user, ident)
        if obj is None:
            return False
        await session.delete(obj)
        await session.commit()
        return True


class TaskService(ResourceService):
    model = Task
    datetime_fields = {"deadline"}


class EventService(ResourceService):
    model = Event
    datetime_fields = {"starts_at"}
