from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from planner.recurrence import expand_recurrence
from planner.schemas import RecurrenceRule, TaskCreate


def utc(year: int, month: int, day: int, hour: int = 9) -> datetime:
    return datetime(year, month, day, hour, tzinfo=UTC)


def test_daily_interval_and_count() -> None:
    rule = RecurrenceRule(frequency="daily", interval=2, end={"kind": "count", "count": 3})
    assert expand_recurrence(utc(2026, 1, 1), rule, "UTC", utc(2026, 1, 1), utc(2026, 1, 10)) == [
        utc(2026, 1, 1),
        utc(2026, 1, 3),
        utc(2026, 1, 5),
    ]


def test_weekly_multiple_weekdays() -> None:
    rule = RecurrenceRule(
        frequency="weekly",
        weekdays=["MO", "WE"],
        end={"kind": "count", "count": 4},
    )
    assert expand_recurrence(utc(2026, 1, 5), rule, "UTC", utc(2026, 1, 1), utc(2026, 1, 20)) == [
        utc(2026, 1, 5),
        utc(2026, 1, 7),
        utc(2026, 1, 12),
        utc(2026, 1, 14),
    ]


def test_month_day_clamps_to_last_day() -> None:
    rule = RecurrenceRule(
        frequency="monthly",
        monthly={"kind": "day_of_month", "day": 31},
        end={"kind": "count", "count": 3},
    )
    assert expand_recurrence(utc(2026, 1, 31), rule, "UTC", utc(2026, 1, 1), utc(2026, 5, 1)) == [
        utc(2026, 1, 31),
        utc(2026, 2, 28),
        utc(2026, 3, 31),
    ]


def test_monthly_last_day_and_nth_weekday() -> None:
    last_day = RecurrenceRule(
        frequency="monthly",
        monthly={"kind": "last_day"},
        end={"kind": "count", "count": 3},
    )
    assert expand_recurrence(
        utc(2026, 1, 31), last_day, "UTC", utc(2026, 1, 1), utc(2026, 5, 1)
    ) == [utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31)]

    second_tuesday = RecurrenceRule(
        frequency="monthly",
        monthly={"kind": "nth_weekday", "ordinal": 2, "weekday": "TU"},
        end={"kind": "count", "count": 3},
    )
    assert expand_recurrence(
        utc(2026, 1, 1), second_tuesday, "UTC", utc(2026, 1, 1), utc(2026, 5, 1)
    ) == [utc(2026, 1, 13), utc(2026, 2, 10), utc(2026, 3, 10)]


def test_until_is_inclusive() -> None:
    rule = RecurrenceRule(
        frequency="daily",
        end={"kind": "until", "until": "2026-01-03"},
    )
    assert expand_recurrence(utc(2026, 1, 1), rule, "UTC", utc(2026, 1, 1), utc(2026, 1, 10)) == [
        utc(2026, 1, 1),
        utc(2026, 1, 2),
        utc(2026, 1, 3),
    ]


def test_dst_keeps_wall_time_and_moves_nonexistent_time_forward() -> None:
    rule = RecurrenceRule(frequency="daily", end={"kind": "count", "count": 3})
    # 02:30 does not exist in New York on 8 March 2026 and becomes 03:30.
    values = expand_recurrence(
        datetime(2026, 3, 7, 7, 30, tzinfo=UTC),
        rule,
        "America/New_York",
        datetime(2026, 3, 7, tzinfo=UTC),
        datetime(2026, 3, 11, tzinfo=UTC),
    )
    assert values == [
        datetime(2026, 3, 7, 7, 30, tzinfo=UTC),
        datetime(2026, 3, 8, 7, 30, tzinfo=UTC),
        datetime(2026, 3, 9, 6, 30, tzinfo=UTC),
    ]


def test_yearly_leap_day_clamps() -> None:
    rule = RecurrenceRule(frequency="yearly", end={"kind": "count", "count": 3})
    assert expand_recurrence(utc(2024, 2, 29), rule, "UTC", utc(2024, 1, 1), utc(2027, 1, 1)) == [
        utc(2024, 2, 29),
        utc(2025, 2, 28),
        utc(2026, 2, 28),
    ]


def test_recurrence_task_requires_deadline() -> None:
    with pytest.raises(ValidationError):
        TaskCreate(title="Без даты", recurrence={"frequency": "daily"})
