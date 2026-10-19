import calendar
import itertools
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from dateutil.relativedelta import relativedelta

from .schemas import MonthlyPattern, RecurrenceRule

WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def _aware_local(value: datetime, zone: ZoneInfo) -> datetime:
    candidate = value.replace(tzinfo=zone, fold=0)
    roundtrip = candidate.astimezone(UTC).astimezone(zone)
    if roundtrip.replace(tzinfo=None) != value:
        return roundtrip
    return candidate


def _month_day(year: int, month: int, day: int) -> int:
    return min(day, calendar.monthrange(year, month)[1])


def _add_months(year: int, month: int, amount: int) -> tuple[int, int]:
    shifted = date(year, month, 1) + relativedelta(months=amount)
    return shifted.year, shifted.month


def _monthly_date(year: int, month: int, pattern: MonthlyPattern, anchor_day: int) -> date:
    last = calendar.monthrange(year, month)[1]
    if pattern.kind == "last_day":
        return date(year, month, last)
    if pattern.kind == "day_of_month":
        return date(year, month, _month_day(year, month, pattern.day or anchor_day))
    weekday = WEEKDAYS[pattern.weekday or "MO"]
    if pattern.ordinal == -1:
        day = last - (date(year, month, last).weekday() - weekday) % 7
    else:
        first = 1 + (weekday - date(year, month, 1).weekday()) % 7
        day = min(first + 7 * ((pattern.ordinal or 1) - 1), last)
    return date(year, month, day)


def _local_candidates(anchor: datetime, rule: RecurrenceRule):
    current = anchor
    if rule.frequency == "daily":
        while True:
            yield current
            current += timedelta(days=rule.interval)
    elif rule.frequency == "weekly":
        weekdays = sorted(
            WEEKDAYS[item] for item in (rule.weekdays or [list(WEEKDAYS)[anchor.weekday()]])
        )
        week_start = anchor.date() - timedelta(days=anchor.weekday())
        week = 0
        while True:
            for weekday in weekdays:
                candidate_date = week_start + timedelta(weeks=week * rule.interval, days=weekday)
                candidate = datetime.combine(candidate_date, anchor.time())
                if candidate >= anchor:
                    yield candidate
            week += 1
    elif rule.frequency == "monthly":
        pattern = rule.monthly or MonthlyPattern(kind="day_of_month", day=anchor.day)
        index = 0
        while True:
            year, month = _add_months(anchor.year, anchor.month, index * rule.interval)
            candidate = datetime.combine(
                _monthly_date(year, month, pattern, anchor.day), anchor.time()
            )
            if candidate >= anchor:
                yield candidate
            index += 1
    else:
        index = 0
        while True:
            year = anchor.year + index * rule.interval
            candidate = datetime(
                year,
                anchor.month,
                _month_day(year, anchor.month, anchor.day),
                anchor.hour,
                anchor.minute,
                anchor.second,
                anchor.microsecond,
            )
            yield candidate
            index += 1


def expand_recurrence(
    anchor: datetime,
    rule: RecurrenceRule | dict | None,
    timezone: str,
    range_from: datetime,
    range_to: datetime,
    *,
    limit: int | None = None,
) -> list[datetime]:
    if range_from.tzinfo is None or range_to.tzinfo is None or anchor.tzinfo is None:
        raise ValueError("recurrence datetimes must be timezone-aware")
    if range_from >= range_to:
        return []
    parsed = RecurrenceRule.model_validate(rule) if rule is not None else None
    if parsed is None:
        value = anchor.astimezone(UTC)
        return [value] if range_from.astimezone(UTC) <= value < range_to.astimezone(UTC) else []
    zone = ZoneInfo(timezone)
    local_anchor = anchor.astimezone(zone).replace(tzinfo=None)
    until = parsed.end.until
    count = parsed.end.count
    result: list[datetime] = []
    normalized_from = range_from.astimezone(UTC)
    normalized_to = range_to.astimezone(UTC)
    candidates = _local_candidates(local_anchor, parsed)
    if count is not None:
        candidates = itertools.islice(candidates, count)
    for local in candidates:
        if until is not None and local.date() > until:
            break
        value = _aware_local(local, zone).astimezone(UTC)
        if value >= normalized_to:
            break
        if value >= normalized_from:
            result.append(value)
            if limit is not None and len(result) >= limit:
                break
    return result
