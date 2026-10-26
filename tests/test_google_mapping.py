from datetime import UTC, datetime

import pytest

from planner.google_mapping import (
    UnsupportedGoogleEvent,
    event_from_google,
    google_time_range,
    instance_id,
    recurrence_from_rrule,
    rrule_from_recurrence,
)

MOSCOW = "Europe/Moscow"
ANCHOR = datetime(2026, 11, 2, 7, 0, tzinfo=UTC)  # Monday 10:00 in Moscow


@pytest.mark.parametrize(
    ("rule", "expected"),
    [
        ({"frequency": "daily"}, "RRULE:FREQ=DAILY"),
        ({"frequency": "daily", "interval": 3}, "RRULE:FREQ=DAILY;INTERVAL=3"),
        (
            {"frequency": "weekly", "weekdays": ["MO", "WE"]},
            "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
        ),
        (
            {"frequency": "monthly", "monthly": {"kind": "day_of_month", "day": 2}},
            "RRULE:FREQ=MONTHLY;BYMONTHDAY=2",
        ),
        (
            {
                "frequency": "monthly",
                "monthly": {"kind": "nth_weekday", "ordinal": -1, "weekday": "FR"},
            },
            "RRULE:FREQ=MONTHLY;BYDAY=-1FR",
        ),
        (
            {"frequency": "monthly", "monthly": {"kind": "last_day"}},
            "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1",
        ),
        (
            {"frequency": "yearly", "end": {"kind": "count", "count": 5}},
            "RRULE:FREQ=YEARLY;COUNT=5",
        ),
        (
            {"frequency": "daily", "end": {"kind": "until", "until": "2026-11-30"}},
            "RRULE:FREQ=DAILY;UNTIL=20261130T205959Z",
        ),
    ],
)
def test_service_recurrence_becomes_rrule(rule, expected):
    assert rrule_from_recurrence(rule, ANCHOR, MOSCOW) == expected


def test_truncated_version_ends_at_its_last_occurrence():
    rule = {"frequency": "daily", "end": {"kind": "count", "count": 30}}
    active_until = datetime(2026, 11, 5, 7, 0, tzinfo=UTC)

    assert (
        rrule_from_recurrence(rule, ANCHOR, MOSCOW, active_until=active_until)
        == "RRULE:FREQ=DAILY;UNTIL=20261104T070000Z"
    )


def test_all_day_until_is_a_date():
    rule = {"frequency": "weekly", "end": {"kind": "until", "until": "2026-12-01"}}
    midnight = datetime(2026, 11, 1, 21, 0, tzinfo=UTC)

    assert (
        rrule_from_recurrence(rule, midnight, MOSCOW, all_day=True)
        == "RRULE:FREQ=WEEKLY;UNTIL=20261201"
    )


@pytest.mark.parametrize(
    "rule",
    [
        {"frequency": "daily", "interval": 2},
        {"frequency": "weekly", "weekdays": ["TU", "TH"]},
        {"frequency": "monthly", "monthly": {"kind": "nth_weekday", "ordinal": 2, "weekday": "MO"}},
        {"frequency": "monthly", "monthly": {"kind": "last_day"}},
        {"frequency": "yearly", "end": {"kind": "count", "count": 3}},
        {"frequency": "daily", "end": {"kind": "until", "until": "2026-11-30"}},
    ],
)
def test_rrule_roundtrip(rule):
    line = rrule_from_recurrence(rule, ANCHOR, MOSCOW)
    parsed = recurrence_from_rrule([line], ANCHOR, MOSCOW)

    assert rrule_from_recurrence(parsed, ANCHOR, MOSCOW) == line


def test_rrule_parser_normalizes_google_defaults():
    parsed = recurrence_from_rrule(
        ["RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=MO"], ANCHOR, MOSCOW
    )

    assert parsed == {
        "frequency": "weekly",
        "interval": 1,
        "weekdays": ["MO"],
        "monthly": None,
        "end": {"kind": "never", "until": None, "count": None},
    }


@pytest.mark.parametrize(
    "lines",
    [
        ["RRULE:FREQ=HOURLY"],
        ["RRULE:FREQ=MONTHLY;BYDAY=MO,TU"],
        ["RRULE:FREQ=MONTHLY;BYDAY=5MO"],
        ["RRULE:FREQ=YEARLY;BYMONTH=1,7"],
        ["RRULE:FREQ=DAILY;BYHOUR=9"],
        ["RRULE:FREQ=DAILY", "RDATE:20261201T070000Z"],
    ],
)
def test_unrepresentable_rrules_are_rejected(lines):
    with pytest.raises(UnsupportedGoogleEvent):
        recurrence_from_rrule(lines, ANCHOR, MOSCOW)


def test_timed_google_event_maps_to_service_fields():
    fields = event_from_google(
        {
            "id": "abc",
            "summary": "  Стоматолог ",
            "description": "Карта",
            "location": "Поликлиника",
            "start": {"dateTime": "2026-11-02T10:00:00+03:00", "timeZone": MOSCOW},
            "end": {"dateTime": "2026-11-02T11:30:00+03:00", "timeZone": MOSCOW},
            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        },
        default_timezone="UTC",
    )

    assert fields.title == "Стоматолог"
    assert fields.starts_at == ANCHOR
    assert fields.duration_minutes == 90
    assert fields.recurrence_timezone == MOSCOW
    assert fields.recurrence["weekdays"] == ["MO"]
    assert not fields.all_day


def test_all_day_google_event_starts_at_local_midnight():
    fields = event_from_google(
        {
            "id": "abc",
            "start": {"date": "2026-11-02"},
            "end": {"date": "2026-11-04"},
        },
        default_timezone=MOSCOW,
    )

    assert fields.title == "Без названия"
    assert fields.starts_at == datetime(2026, 11, 1, 21, 0, tzinfo=UTC)
    assert fields.duration_minutes == 2 * 24 * 60
    assert fields.all_day
    assert fields.recurrence is None and fields.recurrence_timezone is None


def test_zero_length_event_has_unknown_duration():
    fields = event_from_google(
        {
            "id": "abc",
            "summary": "Звонок",
            "start": {"dateTime": "2026-11-02T07:00:00Z"},
            "end": {"dateTime": "2026-11-02T07:00:00Z"},
        },
        default_timezone=MOSCOW,
    )

    assert fields.duration_minutes is None


def test_google_time_range_for_timed_and_all_day_events():
    assert google_time_range(ANCHOR, 30, MOSCOW, all_day=False) == (
        {"dateTime": "2026-11-02T10:00:00+03:00", "timeZone": MOSCOW},
        {"dateTime": "2026-11-02T10:30:00+03:00", "timeZone": MOSCOW},
    )
    assert google_time_range(ANCHOR, None, MOSCOW, all_day=False)[1]["dateTime"] == (
        "2026-11-02T10:00:00+03:00"
    )
    midnight = datetime(2026, 11, 1, 21, 0, tzinfo=UTC)
    assert google_time_range(midnight, 1440, MOSCOW, all_day=True) == (
        {"date": "2026-11-02"},
        {"date": "2026-11-03"},
    )


def test_instance_ids_follow_google_format():
    assert instance_id("abc", ANCHOR, MOSCOW, all_day=False) == "abc_20261102T070000Z"
    midnight = datetime(2026, 11, 1, 21, 0, tzinfo=UTC)
    assert instance_id("abc", midnight, MOSCOW, all_day=True) == "abc_20261102"
