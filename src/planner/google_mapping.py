"""Pure conversions between planner events and Google Calendar event resources."""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import ValidationError

from .recurrence import WEEKDAYS, expand_recurrence
from .schemas import MAX_TEXT_LENGTH, RecurrenceRule

UNTITLED = "Без названия"
FREQUENCIES = {"DAILY": "daily", "WEEKLY": "weekly", "MONTHLY": "monthly", "YEARLY": "yearly"}
ALLOWED_RRULE_KEYS = {
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYMONTHDAY",
    "BYMONTH",
    "COUNT",
    "UNTIL",
    "WKST",
}
NTH_ORDINALS = {1, 2, 3, 4, -1}


class UnsupportedGoogleEvent(ValueError):
    """The Google event cannot be represented by the planner model."""


@dataclass(frozen=True)
class GoogleEventFields:
    title: str
    description: str | None
    location: str | None
    starts_at: datetime
    duration_minutes: int | None
    recurrence: dict[str, Any] | None
    recurrence_timezone: str | None
    all_day: bool

    def payload(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "description": self.description,
            "location": self.location,
            "starts_at": self.starts_at,
            "duration_minutes": self.duration_minutes,
            "recurrence": self.recurrence,
            "recurrence_timezone": self.recurrence_timezone,
        }


def zone_or_default(name: str | None, default: str) -> str:
    if name:
        try:
            ZoneInfo(name)
            return name
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return default


def _utc_basic(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _sorted_weekdays(days: list[str]) -> list[str]:
    return sorted(days, key=WEEKDAYS.__getitem__)


def rrule_from_recurrence(
    rule: RecurrenceRule | dict,
    anchor: datetime,
    timezone: str,
    *,
    active_until: datetime | None = None,
    all_day: bool = False,
) -> str:
    """Return the RRULE line for a planner recurrence, optionally cut at a version boundary."""
    parsed = RecurrenceRule.model_validate(rule)
    zone = ZoneInfo(timezone)
    parts = [f"FREQ={parsed.frequency.upper()}"]
    if parsed.interval > 1:
        parts.append(f"INTERVAL={parsed.interval}")
    if parsed.weekdays:
        parts.append(f"BYDAY={','.join(_sorted_weekdays(parsed.weekdays))}")
    if parsed.monthly is not None:
        if parsed.monthly.kind == "day_of_month":
            parts.append(f"BYMONTHDAY={parsed.monthly.day}")
        elif parsed.monthly.kind == "last_day":
            parts.append("BYMONTHDAY=-1")
        else:
            parts.append(f"BYDAY={parsed.monthly.ordinal}{parsed.monthly.weekday}")
    if active_until is not None:
        occurrences = expand_recurrence(anchor, parsed, timezone, anchor, active_until)
        if not occurrences:
            raise ValueError("schedule version has no occurrences")
        last = occurrences[-1]
        parts.append(
            f"UNTIL={last.astimezone(zone).strftime('%Y%m%d')}"
            if all_day
            else f"UNTIL={_utc_basic(last)}"
        )
    elif parsed.end.kind == "count":
        parts.append(f"COUNT={parsed.end.count}")
    elif parsed.end.kind == "until" and parsed.end.until is not None:
        if all_day:
            parts.append(f"UNTIL={parsed.end.until.strftime('%Y%m%d')}")
        else:
            end_of_day = datetime.combine(parsed.end.until, time(23, 59, 59), tzinfo=zone)
            parts.append(f"UNTIL={_utc_basic(end_of_day)}")
    return "RRULE:" + ";".join(parts)


def _parse_until(value: str, timezone: str) -> date:
    try:
        if "T" not in value:
            return datetime.strptime(value, "%Y%m%d").date()
        if value.endswith("Z"):
            moment = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            return moment.astimezone(ZoneInfo(timezone)).date()
        return datetime.strptime(value, "%Y%m%dT%H%M%S").date()
    except ValueError as exc:
        raise UnsupportedGoogleEvent(f"invalid UNTIL: {value}") from exc


def _split_ordinal(value: str) -> tuple[int | None, str]:
    weekday = value[-2:]
    if weekday not in WEEKDAYS:
        raise UnsupportedGoogleEvent(f"invalid BYDAY: {value}")
    prefix = value[:-2]
    if not prefix:
        return None, weekday
    try:
        return int(prefix), weekday
    except ValueError as exc:
        raise UnsupportedGoogleEvent(f"invalid BYDAY: {value}") from exc


def recurrence_from_rrule(
    lines: list[str], anchor: datetime, timezone: str
) -> dict[str, Any] | None:
    """Parse Google recurrence lines into a planner rule; EXDATE lines are handled separately."""
    rules = [line for line in lines if line.upper().startswith("RRULE:")]
    others = [line for line in lines if not line.upper().startswith(("RRULE:", "EXDATE"))]
    if others or len(rules) > 1:
        raise UnsupportedGoogleEvent("only a single RRULE is supported")
    if not rules:
        return None
    params: dict[str, str] = {}
    for part in rules[0].split(":", 1)[1].split(";"):
        if not part:
            continue
        key, _, value = part.partition("=")
        params[key.upper()] = value.upper()
    unknown = params.keys() - ALLOWED_RRULE_KEYS
    if unknown:
        raise UnsupportedGoogleEvent(f"unsupported RRULE parts: {sorted(unknown)}")
    frequency = FREQUENCIES.get(params.get("FREQ", ""))
    if frequency is None:
        raise UnsupportedGoogleEvent(f"unsupported FREQ: {params.get('FREQ')}")
    try:
        interval = int(params.get("INTERVAL", "1"))
    except ValueError as exc:
        raise UnsupportedGoogleEvent("invalid INTERVAL") from exc
    local_anchor = anchor.astimezone(ZoneInfo(timezone))
    byday = [item for item in params.get("BYDAY", "").split(",") if item]
    bymonthday = [item for item in params.get("BYMONTHDAY", "").split(",") if item]
    bymonth = [item for item in params.get("BYMONTH", "").split(",") if item]
    rule: dict[str, Any] = {"frequency": frequency, "interval": interval}

    if frequency == "daily" and byday:
        if interval != 1 or bymonthday or bymonth:
            raise UnsupportedGoogleEvent("daily BYDAY rules are not supported")
        rule["frequency"] = frequency = "weekly"
    if frequency in {"daily", "weekly"} and (bymonthday or bymonth):
        raise UnsupportedGoogleEvent("BYMONTH/BYMONTHDAY need a monthly or yearly rule")
    if frequency == "weekly" and byday:
        parsed_days = [_split_ordinal(item) for item in byday]
        if any(ordinal is not None for ordinal, _day in parsed_days):
            raise UnsupportedGoogleEvent("weekly BYDAY cannot have ordinals")
        rule["weekdays"] = _sorted_weekdays([day for _ordinal, day in parsed_days])
    if frequency == "monthly":
        if bymonth or (byday and bymonthday) or len(byday) > 1 or len(bymonthday) > 1:
            raise UnsupportedGoogleEvent("complex monthly rules are not supported")
        if byday:
            ordinal, weekday = _split_ordinal(byday[0])
            if ordinal not in NTH_ORDINALS:
                raise UnsupportedGoogleEvent("monthly BYDAY needs an ordinal of 1-4 or -1")
            rule["monthly"] = {"kind": "nth_weekday", "ordinal": ordinal, "weekday": weekday}
        elif bymonthday:
            day = int(bymonthday[0])
            if day == -1:
                rule["monthly"] = {"kind": "last_day"}
            elif 1 <= day <= 31:
                rule["monthly"] = {"kind": "day_of_month", "day": day}
            else:
                raise UnsupportedGoogleEvent("unsupported BYMONTHDAY")
    if frequency == "yearly":
        if byday or len(bymonth) > 1 or len(bymonthday) > 1:
            raise UnsupportedGoogleEvent("complex yearly rules are not supported")
        if bymonth and int(bymonth[0]) != local_anchor.month:
            raise UnsupportedGoogleEvent("yearly BYMONTH must match the event start")
        if bymonthday and int(bymonthday[0]) != local_anchor.day:
            raise UnsupportedGoogleEvent("yearly BYMONTHDAY must match the event start")
    if "COUNT" in params and "UNTIL" in params:
        raise UnsupportedGoogleEvent("COUNT and UNTIL cannot be combined")
    if "COUNT" in params:
        try:
            rule["end"] = {"kind": "count", "count": int(params["COUNT"])}
        except ValueError as exc:
            raise UnsupportedGoogleEvent("invalid COUNT") from exc
    elif "UNTIL" in params:
        rule["end"] = {"kind": "until", "until": _parse_until(params["UNTIL"], timezone)}
    try:
        return RecurrenceRule.model_validate(rule).model_dump(mode="json")
    except ValidationError as exc:
        raise UnsupportedGoogleEvent("recurrence is outside the planner limits") from exc


def exdates_from_recurrence(lines: list[str], timezone: str) -> list[datetime]:
    """Return EXDATE moments (UTC) from Google recurrence lines."""
    result: list[datetime] = []
    for line in lines:
        if not line.upper().startswith("EXDATE"):
            continue
        head, _, values = line.partition(":")
        zone_name = timezone
        for param in head.split(";")[1:]:
            key, _, value = param.partition("=")
            if key.upper() == "TZID":
                zone_name = zone_or_default(value, timezone)
        zone = ZoneInfo(zone_name)
        for raw in values.split(","):
            raw = raw.strip()
            try:
                if raw.endswith("Z"):
                    result.append(datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC))
                elif "T" in raw:
                    local = datetime.strptime(raw, "%Y%m%dT%H%M%S").replace(tzinfo=zone)
                    result.append(local.astimezone(UTC))
                else:
                    local = datetime.combine(datetime.strptime(raw, "%Y%m%d").date(), time())
                    result.append(local.replace(tzinfo=zone).astimezone(UTC))
            except ValueError:
                continue
    return result


def _parse_google_datetime(value: dict[str, Any], timezone: str) -> datetime:
    parsed = datetime.fromisoformat(value["dateTime"])
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(timezone))
    return parsed.astimezone(UTC)


def _local_midnight(day: date, timezone: str) -> datetime:
    return datetime.combine(day, time(), tzinfo=ZoneInfo(timezone)).astimezone(UTC)


def _optional_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped[:limit] if stripped else None


def google_start(item: dict[str, Any], default_timezone: str) -> tuple[datetime, str, bool]:
    """Return the event start (UTC), its timezone and whether it is all-day."""
    start = item.get("start") or {}
    if "date" in start:
        day = date.fromisoformat(start["date"])
        return _local_midnight(day, default_timezone), default_timezone, True
    if "dateTime" not in start:
        raise UnsupportedGoogleEvent("event has no start")
    timezone = zone_or_default(start.get("timeZone"), default_timezone)
    return _parse_google_datetime(start, timezone), timezone, False


def original_start(item: dict[str, Any], default_timezone: str) -> datetime:
    """Return the original (series-generated) start of a recurring instance."""
    value = item.get("originalStartTime") or {}
    if "date" in value:
        return _local_midnight(date.fromisoformat(value["date"]), default_timezone)
    if "dateTime" not in value:
        raise UnsupportedGoogleEvent("instance has no originalStartTime")
    return _parse_google_datetime(value, zone_or_default(value.get("timeZone"), default_timezone))


def event_from_google(item: dict[str, Any], *, default_timezone: str) -> GoogleEventFields:
    starts_at, timezone, all_day = google_start(item, default_timezone)
    end = item.get("end") or {}
    duration: int | None
    if all_day:
        days = 1
        if "date" in end:
            days = (
                date.fromisoformat(end["date"]) - date.fromisoformat(item["start"]["date"])
            ).days
        duration = max(days, 1) * 24 * 60
    elif "dateTime" in end:
        seconds = (_parse_google_datetime(end, timezone) - starts_at).total_seconds()
        duration = round(seconds / 60) if seconds >= 60 else None
    else:
        duration = None
    recurrence = None
    lines = item.get("recurrence") or []
    if lines:
        recurrence = recurrence_from_rrule(lines, starts_at, timezone)
    return GoogleEventFields(
        title=(_optional_text(item.get("summary"), 500) or UNTITLED),
        description=_optional_text(item.get("description"), MAX_TEXT_LENGTH),
        location=_optional_text(item.get("location"), 500),
        starts_at=starts_at,
        duration_minutes=duration,
        recurrence=recurrence,
        recurrence_timezone=timezone if recurrence is not None else None,
        all_day=all_day,
    )


def can_be_all_day(starts_at: datetime, duration_minutes: int | None, timezone: str) -> bool:
    local = starts_at.astimezone(ZoneInfo(timezone))
    return (
        duration_minutes is not None
        and duration_minutes % (24 * 60) == 0
        and local.time() == time()
    )


def google_time_range(
    starts_at: datetime,
    duration_minutes: int | None,
    timezone: str,
    *,
    all_day: bool,
) -> tuple[dict[str, str], dict[str, str]]:
    zone = ZoneInfo(timezone)
    local = starts_at.astimezone(zone)
    if all_day:
        days = max((duration_minutes or 0) // (24 * 60), 1)
        return (
            {"date": local.date().isoformat()},
            {"date": (local.date() + timedelta(days=days)).isoformat()},
        )
    end = local + timedelta(minutes=duration_minutes or 0)
    return (
        {"dateTime": local.isoformat(), "timeZone": timezone},
        {"dateTime": end.isoformat(), "timeZone": timezone},
    )


def instance_id(
    google_event_id: str, original_at: datetime, timezone: str, *, all_day: bool
) -> str:
    if all_day:
        return f"{google_event_id}_{original_at.astimezone(ZoneInfo(timezone)):%Y%m%d}"
    return f"{google_event_id}_{_utc_basic(original_at)}"
