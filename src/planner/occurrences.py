import base64
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    CalendarOccurrenceException,
    CalendarScheduleVersion,
    Event,
    Task,
    User,
)
from .recurrence import expand_recurrence
from .services import normalize_datetime


def aware_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def occurrence_key(version_id: uuid.UUID, original_at: datetime) -> str:
    raw = json.dumps([str(version_id), aware_utc(original_at).isoformat()], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def parse_occurrence_key(value: str) -> tuple[uuid.UUID, datetime]:
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        version, original = json.loads(raw)
        parsed = datetime.fromisoformat(original)
        if parsed.tzinfo is None:
            raise ValueError
        return uuid.UUID(version), parsed.astimezone(UTC)
    except Exception as exc:
        raise ValueError("invalid occurrence_key") from exc


@dataclass(frozen=True)
class CalendarOccurrence:
    resource: str
    series_id: uuid.UUID
    occurrence_key: str
    original_at: datetime
    scheduled_at: datetime
    recurring: bool
    data: dict[str, Any]


@dataclass(frozen=True)
class OccurrencePage:
    items: list[CalendarOccurrence]
    total: int
    has_more: bool
    next_cursor: str | None


def _cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode()).decode().rstrip("=")


def _offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        return int(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except Exception as exc:
        raise ValueError("invalid occurrence cursor") from exc


def occurrence_dict(item: CalendarOccurrence) -> dict[str, Any]:
    return {
        "resource": item.resource,
        "series_id": str(item.series_id),
        "occurrence_key": item.occurrence_key,
        "original_at": item.original_at.isoformat(),
        "scheduled_at": item.scheduled_at.isoformat(),
        "recurring": item.recurring,
        "data": json.loads(json.dumps(item.data, default=str)),
    }


class OccurrenceService:
    @classmethod
    async def _series_versions(
        cls, session: AsyncSession, user: User, resource: str, series_id: uuid.UUID
    ) -> list[CalendarScheduleVersion]:
        return list(
            (
                await session.scalars(
                    select(CalendarScheduleVersion)
                    .where(
                        CalendarScheduleVersion.owner_id == user.id,
                        CalendarScheduleVersion.resource == resource,
                        CalendarScheduleVersion.series_id == series_id,
                    )
                    .order_by(CalendarScheduleVersion.active_from, CalendarScheduleVersion.id)
                )
            ).all()
        )

    @classmethod
    async def get(
        cls,
        session: AsyncSession,
        user: User,
        resource: str,
        series_id: uuid.UUID,
        key: str,
    ) -> CalendarOccurrence | None:
        version_id, original = parse_occurrence_key(key)
        model = Task if resource == "task" else Event
        row = await session.scalar(
            select(model).where(model.id == series_id, model.owner_id == user.id)
        )
        version = await session.get(CalendarScheduleVersion, version_id)
        if row is None or version is None or version.series_id != series_id:
            return None
        generated = expand_recurrence(
            aware_utc(version.anchor_at),
            version.recurrence,
            version.timezone,
            original - timedelta(seconds=1),
            original + timedelta(seconds=1),
        )
        if original not in generated:
            return None
        exception = await session.scalar(
            select(CalendarOccurrenceException).where(
                CalendarOccurrenceException.owner_id == user.id,
                CalendarOccurrenceException.resource == resource,
                CalendarOccurrenceException.series_id == series_id,
                CalendarOccurrenceException.occurrence_key == key,
            )
        )
        base = {
            column.name: getattr(row, column.name)
            for column in row.__table__.columns
            if column.name not in {"owner_id", "recurrence_version_id"}
        }
        if resource == "task" and row.recurrence is not None:
            base["status"] = "open"
        base.update(exception.patch if exception is not None else {})
        scheduled = (
            aware_utc(exception.effective_at)
            if exception is not None and exception.effective_at is not None
            else original
        )
        base["deadline" if resource == "task" else "starts_at"] = scheduled
        return CalendarOccurrence(
            resource, series_id, key, original, scheduled, version.recurrence is not None, base
        )

    @classmethod
    async def page(
        cls,
        session: AsyncSession,
        user: User,
        *,
        resource: str = "all",
        series_id: uuid.UUID | None = None,
        from_datetime: datetime | None = None,
        to_datetime: datetime | None = None,
        status: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
        include_cancelled: bool = False,
        descending: bool = False,
    ) -> OccurrencePage:
        now = datetime.now(UTC)
        start = (
            normalize_datetime(from_datetime, user)
            if from_datetime
            else (datetime(1970, 1, 1, tzinfo=UTC) if to_datetime is not None else now)
        )
        end = (
            normalize_datetime(to_datetime, user)
            if to_datetime
            else start + __import__("datetime").timedelta(days=366)
        )
        resources = [resource] if resource != "all" else ["task", "event"]
        result: list[CalendarOccurrence] = []
        for kind in resources:
            model = Task if kind == "task" else Event
            conditions = [model.owner_id == user.id]
            if series_id is not None:
                conditions.append(model.id == series_id)
            rows = list((await session.scalars(select(model).where(*conditions))).all())
            for row in rows:
                versions = await cls._series_versions(session, user, kind, row.id)
                if not versions:
                    anchor = row.deadline if kind == "task" else row.starts_at
                    if anchor is None:
                        continue
                    transient_id = row.recurrence_version_id or uuid.uuid5(
                        uuid.NAMESPACE_URL, f"{kind}:{row.id}"
                    )
                    versions = [
                        CalendarScheduleVersion(
                            id=transient_id,
                            owner_id=user.id,
                            resource=kind,
                            series_id=row.id,
                            anchor_at=anchor,
                            recurrence=row.recurrence,
                            timezone=row.recurrence_timezone or user.timezone,
                            active_from=anchor,
                            active_until=None,
                        )
                    ]
                exceptions = {
                    item.occurrence_key: item
                    for item in (
                        await session.scalars(
                            select(CalendarOccurrenceException).where(
                                CalendarOccurrenceException.owner_id == user.id,
                                CalendarOccurrenceException.resource == kind,
                                CalendarOccurrenceException.series_id == row.id,
                            )
                        )
                    ).all()
                }
                base = {
                    column.name: getattr(row, column.name)
                    for column in row.__table__.columns
                    if column.name not in {"owner_id"}
                }
                if kind == "task" and row.recurrence is not None:
                    base["status"] = "open"
                emitted: set[str] = set()
                for version in versions:
                    lower = max(aware_utc(version.active_from), aware_utc(start))
                    upper = aware_utc(end)
                    if version.active_until is not None:
                        upper = min(upper, aware_utc(version.active_until))
                    if lower >= upper:
                        continue
                    dates = expand_recurrence(
                        aware_utc(version.anchor_at),
                        version.recurrence,
                        version.timezone,
                        lower,
                        upper,
                    )
                    for original in dates:
                        key = occurrence_key(version.id, original)
                        emitted.add(key)
                        exception = exceptions.get(key)
                        if exception is not None and exception.cancelled and not include_cancelled:
                            continue
                        data = dict(base)
                        data.update(exception.patch if exception is not None else {})
                        scheduled = (
                            aware_utc(exception.effective_at)
                            if exception is not None and exception.effective_at is not None
                            else original
                        )
                        schedule_field = "deadline" if kind == "task" else "starts_at"
                        data[schedule_field] = scheduled
                        if not (aware_utc(start) <= scheduled < aware_utc(end)):
                            continue
                        if status is not None and data.get("status") != status:
                            continue
                        result.append(
                            CalendarOccurrence(
                                resource=kind,
                                series_id=row.id,
                                occurrence_key=key,
                                original_at=original,
                                scheduled_at=scheduled,
                                recurring=version.recurrence is not None,
                                data=data,
                            )
                        )
                for key, exception in exceptions.items():
                    if key in emitted or exception.cancelled or exception.effective_at is None:
                        continue
                    scheduled = aware_utc(exception.effective_at)
                    if not (aware_utc(start) <= scheduled < aware_utc(end)):
                        continue
                    data = dict(base)
                    data.update(exception.patch or {})
                    data["deadline" if kind == "task" else "starts_at"] = scheduled
                    if status is not None and data.get("status") != status:
                        continue
                    result.append(
                        CalendarOccurrence(
                            kind,
                            row.id,
                            key,
                            aware_utc(exception.original_at),
                            scheduled,
                            row.recurrence is not None,
                            data,
                        )
                    )
        result.sort(
            key=lambda item: (item.scheduled_at, item.resource, str(item.series_id)),
            reverse=descending,
        )
        offset = _offset(cursor)
        items = result[offset : offset + limit]
        next_offset = offset + len(items)
        return OccurrencePage(
            items=items,
            total=len(result),
            has_more=next_offset < len(result),
            next_cursor=_cursor(next_offset) if next_offset < len(result) else None,
        )

    @classmethod
    async def preview(
        cls,
        session: AsyncSession,
        user: User,
        *,
        resource: str,
        series_id: uuid.UUID,
        limit: int = 5,
        now: datetime | None = None,
    ) -> OccurrencePage:
        """Return the next occurrences, or the latest ones for an ended series."""
        boundary = aware_utc(now or datetime.now(UTC))
        future = await cls.page(
            session,
            user,
            resource=resource,
            series_id=series_id,
            from_datetime=boundary,
            to_datetime=boundary + timedelta(days=366 * 100),
            limit=limit,
        )
        if future.items:
            return future
        past = await cls.page(
            session,
            user,
            resource=resource,
            series_id=series_id,
            from_datetime=datetime(1900, 1, 1, tzinfo=UTC),
            to_datetime=boundary,
            limit=limit,
            descending=True,
        )
        return OccurrencePage(
            items=list(reversed(past.items)),
            total=past.total,
            has_more=past.has_more,
            next_cursor=past.next_cursor,
        )
