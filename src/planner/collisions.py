"""Time overlap facts, without deciding whether two activities are incompatible."""

import hashlib
from bisect import bisect_left
from datetime import UTC, datetime, timedelta

from dateutil.relativedelta import relativedelta
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .collision_types import CollisionGroup, CollisionPair, CollisionReport
from .models import CalendarOccurrenceException, CalendarOperation, Event, User
from .occurrences import (
    CalendarOccurrence,
    OccurrenceService,
    aware_utc,
    occurrence_dict,
    parse_occurrence_key,
)
from .recurrence import expand_recurrence

SCHEDULE_FIELDS = {"starts_at", "duration_minutes", "recurrence", "recurrence_timezone"}


def schedule_changed(operation: CalendarOperation) -> bool:
    if operation.operation == "create":
        return True
    for field in SCHEDULE_FIELDS.intersection(operation.changes):
        change = operation.changes[field]
        before, after = change["before"], change["after"]
        if field == "starts_at" and before and after:
            before = aware_utc(datetime.fromisoformat(str(before)))
            after = aware_utc(datetime.fromisoformat(str(after)))
        if before != after:
            return True
    return False


def overlaps(a: datetime, ad: int | None, b: datetime, bd: int | None) -> bool:
    a, b = aware_utc(a), aware_utc(b)
    if ad is None and bd is None:
        return a == b
    if ad is None:
        return b <= a < b + timedelta(minutes=bd)
    if bd is None:
        return a <= b < a + timedelta(minutes=ad)
    return a < b + timedelta(minutes=bd) and b < a + timedelta(minutes=ad)


async def _first_series_start(
    session: AsyncSession, user: User, operation: CalendarOperation, lower: datetime
) -> datetime | None:
    versions = await OccurrenceService._series_versions(session, user, "event", operation.target_id)
    exceptions = list(
        (
            await session.scalars(
                select(CalendarOccurrenceException).where(
                    CalendarOccurrenceException.owner_id == user.id,
                    CalendarOccurrenceException.resource == "event",
                    CalendarOccurrenceException.series_id == operation.target_id,
                )
            )
        ).all()
    )
    by_original = {(item.version_id, aware_utc(item.original_at)): item for item in exceptions}
    candidates = [
        aware_utc(item.effective_at)
        for item in exceptions
        if not item.cancelled
        and item.effective_at is not None
        and aware_utc(item.original_at) >= lower
        and aware_utc(item.effective_at) >= lower
    ]
    for version in versions:
        start = max(lower, aware_utc(version.active_from))
        end = (
            aware_utc(version.active_until)
            if version.active_until
            else datetime.max.replace(tzinfo=UTC)
        )
        if start >= end:
            continue
        # At most N exceptions can hide the first N original dates.
        for original in expand_recurrence(
            aware_utc(version.anchor_at),
            version.recurrence,
            version.timezone,
            start,
            end,
            limit=len(exceptions) + 1,
        ):
            exception = by_original.get((version.id, original))
            if exception is not None and exception.cancelled:
                continue
            scheduled = (
                aware_utc(exception.effective_at)
                if exception is not None and exception.effective_at
                else original
            )
            if scheduled >= lower:
                candidates.append(scheduled)
    return min(candidates) if candidates else None


async def collision_report(
    session: AsyncSession, user: User, operations: list[CalendarOperation]
) -> CollisionReport:
    affected = [
        op
        for op in operations
        if op.resource == "event" and op.after_state is not None and schedule_changed(op)
    ]
    if not affected:
        return CollisionReport()
    windows = []
    now = datetime.now(UTC)
    for op in affected:
        after = op.after_state
        start = aware_utc(datetime.fromisoformat(str(after["starts_at"])))
        boundary = start
        if op.effective_from_occurrence_key:
            boundary = parse_occurrence_key(op.effective_from_occurrence_key)[1]
            start = max(start, boundary)
        elif after.get("recurrence") and op.operation != "create" and op.scope != "occurrence":
            start = max(start, now)
            boundary = start
        if after.get("recurrence") and op.scope != "occurrence":
            first_start = await _first_series_start(session, user, op, start)
            if first_start is None:
                continue
            start = first_start
        end = (
            start + relativedelta(years=1)
            if after.get("recurrence") and op.scope != "occurrence"
            else start + timedelta(minutes=after.get("duration_minutes") or 0, microseconds=1)
        )
        windows.append((op, start, end, boundary))
    if not windows:
        return CollisionReport()
    lower = min(w[1] for w in windows)
    upper = max(w[2] for w in windows)
    # Include intervals anchored before the window, including duration overrides.
    durations = list(
        (
            await session.scalars(select(Event.duration_minutes).where(Event.owner_id == user.id))
        ).all()
    )
    patches = (
        await session.scalars(
            select(CalendarOccurrenceException).where(
                CalendarOccurrenceException.owner_id == user.id,
                CalendarOccurrenceException.resource == "event",
            )
        )
    ).all()
    durations.extend((item.patch or {}).get("duration_minutes") for item in patches)
    lookback = timedelta(minutes=max((d for d in durations if d is not None), default=0))
    items = []
    cursor = None
    while True:
        page = await OccurrenceService.page(
            session,
            user,
            resource="event",
            from_datetime=lower - lookback,
            to_datetime=upper,
            limit=100,
            cursor=cursor,
        )
        items.extend(page.items)
        if not page.has_more:
            break
        cursor = page.next_cursor

    def touched(item: CalendarOccurrence) -> bool:
        for op, start, end, boundary in windows:
            if item.series_id != op.target_id:
                continue
            if op.scope == "occurrence":
                if item.occurrence_key == op.occurrence_key:
                    return True
            elif start <= item.scheduled_at < end and item.original_at >= boundary:
                return True
        return False

    groups: dict[str, list[CollisionPair]] = {}
    seen = set()
    scheduled_times = [item.scheduled_at for item in items]
    for first in items:
        if not touched(first):
            continue
        first_end = first.scheduled_at + timedelta(minutes=first.data.get("duration_minutes") or 0)
        earliest = bisect_left(scheduled_times, first.scheduled_at - lookback)
        for second in items[earliest:]:
            if second.scheduled_at > first_end:
                break
            if first.occurrence_key == second.occurrence_key:
                continue
            pair_key = tuple(sorted((first.occurrence_key, second.occurrence_key)))
            if pair_key in seen or not overlaps(
                first.scheduled_at,
                first.data.get("duration_minutes"),
                second.scheduled_at,
                second.data.get("duration_minutes"),
            ):
                continue
            seen.add(pair_key)
            series = sorted((str(first.series_id), str(second.series_id)))
            group_id = hashlib.sha256(":".join(series).encode()).hexdigest()[:24]
            groups.setdefault(group_id, []).append(
                CollisionPair(
                    first=occurrence_dict(first),
                    second=occurrence_dict(second),
                    kind="point"
                    if None
                    in (first.data.get("duration_minutes"), second.data.get("duration_minutes"))
                    else "interval",
                )
            )
    return CollisionReport(
        checked_from=lower.isoformat(),
        checked_to=upper.isoformat(),
        groups=[CollisionGroup(id=key, occurrences=value) for key, value in groups.items()],
    )
