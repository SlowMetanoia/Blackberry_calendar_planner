import { useEffect, useMemo, useState } from "react";
import { getOccurrences } from "../../api";
import type { CalendarEntry, CalendarOccurrence } from "../../types";
import { localDateKey } from "../format";
import { occurrencesToEntries } from "../planner-data";
import { useSessionStore } from "../stores";

const DEFAULT_ENTRY_MINUTES = 30;
const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export type WeekOccupancyDay = {
  key: string;
  date: Date;
  weekday: string;
  dayNumber: number;
  isToday: boolean;
  busyMinutes: number;
  entries: CalendarEntry[];
};

export type WeekOccupancy = {
  days: WeekOccupancyDay[];
  totalMinutes: number;
  rangeLabel: string;
  loading: boolean;
  error: string;
};

export function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const weekday = start.getDay();
  start.setDate(start.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return start;
}

function entryMinutes(entry: CalendarEntry): number {
  const minutes = entry.durationMinutes;
  return minutes && minutes > 0 ? minutes : DEFAULT_ENTRY_MINUTES;
}

function formatRange(start: Date, end: Date): string {
  const last = new Date(end);
  last.setDate(last.getDate() - 1);
  const dayMonth = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  });
  if (
    start.getMonth() === last.getMonth() &&
    start.getFullYear() === last.getFullYear()
  ) {
    return `${start.getDate()}–${dayMonth.format(last)}`;
  }
  return `${dayMonth.format(start)} — ${dayMonth.format(last)}`;
}

function occupiedMinutes(entries: CalendarEntry[]): number {
  const intervals = entries
    .map((entry) => {
      const start = Date.parse(entry.startsAt);
      return { start, end: start + entryMinutes(entry) * 60_000 };
    })
    .filter(
      (interval) =>
        Number.isFinite(interval.start) && interval.end > interval.start,
    )
    .sort((left, right) => left.start - right.start);

  let total = 0;
  let windowStart: number | null = null;
  let windowEnd = 0;
  intervals.forEach((interval) => {
    if (windowStart === null) {
      windowStart = interval.start;
      windowEnd = interval.end;
      return;
    }
    if (interval.start <= windowEnd) {
      windowEnd = Math.max(windowEnd, interval.end);
      return;
    }
    total += windowEnd - windowStart;
    windowStart = interval.start;
    windowEnd = interval.end;
  });
  if (windowStart !== null) total += windowEnd - windowStart;
  return Math.round(total / 60_000);
}

async function loadWeekOccurrences(
  from: Date,
  to: Date,
): Promise<CalendarOccurrence[]> {
  const options = { from: from.toISOString(), to: to.toISOString(), limit: 100 };
  const first = await getOccurrences(options);
  const items = [...first.items];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await getOccurrences({ ...options, cursor });
    items.push(...page.items);
    cursor = page.next_cursor;
  }
  return items;
}

export function useWeekOccupancy(): WeekOccupancy {
  const revision = useSessionStore((state) => state.calendarRevision);
  const [weekStart] = useState(() => startOfWeek(new Date()));
  const [occurrences, setOccurrences] = useState<CalendarOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const weekEnd = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 7);
    return end;
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const items = await loadWeekOccurrences(weekStart, weekEnd);
        if (!cancelled) setOccurrences(items);
      } catch {
        if (!cancelled) {
          setOccurrences([]);
          setError("Не удалось загрузить занятость недели.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, weekEnd, weekStart]);

  const days = useMemo(() => {
    const grouped = new Map<string, CalendarEntry[]>();
    occurrencesToEntries(occurrences)
      .filter(
        (entry) =>
          entry.resource === "event" || entry.task?.status === "open",
      )
      .forEach((entry) => {
        const key = localDateKey(entry.startsAt);
        grouped.set(key, [...(grouped.get(key) ?? []), entry]);
      });

    const todayKey = localDateKey(new Date());
    return Array.from({ length: 7 }, (_, index): WeekOccupancyDay => {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + index);
      const key = localDateKey(date);
      const entries = (grouped.get(key) ?? []).sort(
        (left, right) =>
          Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
          left.title.localeCompare(right.title, "ru"),
      );
      return {
        key,
        date,
        weekday: WEEKDAY_LABELS[index],
        dayNumber: date.getDate(),
        isToday: key === todayKey,
        busyMinutes: occupiedMinutes(entries),
        entries,
      };
    });
  }, [occurrences, weekStart]);

  return {
    days,
    totalMinutes: days.reduce((total, day) => total + day.busyMinutes, 0),
    rangeLabel: formatRange(weekStart, weekEnd),
    loading,
    error,
  };
}
