import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getEvents,
  getOccurrences,
  getTasks,
  getUserPreferences,
  updateUserPreferences,
} from "../../api";
import { localDateKey } from "../format";
import { collectPages } from "../pagination";
import {
  occurrencesToEntries,
  partitionOccurrenceEntries,
} from "../planner-data";
import type {
  CalendarEntry,
  CalendarOccurrence,
  Event,
  Task,
} from "../../types";

function legacyOccurrences(
  tasks: Task[],
  events: Event[],
): CalendarOccurrence[] {
  return [
    ...tasks
      .filter((item) => item.deadline)
      .map((item) => ({
        resource: "task" as const,
        series_id: item.id,
        occurrence_key: `legacy-${item.id}`,
        original_at: item.deadline!,
        scheduled_at: item.deadline!,
        recurring: false,
        data: item,
      })),
    ...events.map((item) => ({
      resource: "event" as const,
      series_id: item.id,
      occurrence_key: `legacy-${item.id}`,
      original_at: item.starts_at,
      scheduled_at: item.starts_at,
      recurring: false,
      data: item,
    })),
  ];
}

export function useCalendarData({
  revision,
  onError,
}: {
  revision: number;
  onError: (message: string) => void;
}) {
  const [upcomingDays, setUpcomingDays] = useState(7);
  const [undatedTasks, setUndatedTasks] = useState<Task[]>([]);
  const [overviewOccurrences, setOverviewOccurrences] = useState<
    CalendarOccurrence[]
  >([]);
  const [overviewCursor, setOverviewCursor] = useState<string | null>(null);
  const [calendarOccurrences, setCalendarOccurrences] = useState<
    CalendarOccurrence[]
  >([]);
  const [visibleRange, setVisibleRange] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadOverview = useCallback(async (days: number) => {
    const now = new Date(),
      end = new Date(now.getTime() + days * 86_400_000);
    const undated = await collectPages((offset) =>
      getTasks({ offset, status: "open", deadlinePresence: "undated" }),
    );
    try {
      const occurrences = await getOccurrences({
        from: "1970-01-01T00:00:00.000Z",
        to: end.toISOString(),
        limit: 100,
      });
      setOverviewOccurrences(occurrences.items);
      setOverviewCursor(occurrences.next_cursor);
    } catch {
      const [dated, events] = await Promise.all([
        collectPages((offset) =>
          getTasks({
            offset,
            status: "open",
            deadlinePresence: "dated",
            deadlineTo: end.toISOString(),
          }),
        ),
        collectPages((offset) =>
          getEvents({
            offset,
            startsAtFrom: now.toISOString(),
            startsAtTo: end.toISOString(),
          }),
        ),
      ]);
      setOverviewOccurrences(legacyOccurrences(dated, events));
      setOverviewCursor(null);
    }
    setUndatedTasks(undated);
  }, []);

  const loadCalendar = useCallback(
    async (range: { from: string; to: string }) => {
      try {
        const first = await getOccurrences({
          from: range.from,
          to: range.to,
          limit: 100,
        });
        const result = [...first.items];
        let cursor = first.next_cursor;
        while (cursor) {
          const page = await getOccurrences({
            from: range.from,
            to: range.to,
            limit: 100,
            cursor,
          });
          result.push(...page.items);
          cursor = page.next_cursor;
        }
        setCalendarOccurrences(result);
      } catch {
        const [tasks, events] = await Promise.all([
          collectPages((offset) =>
            getTasks({
              offset,
              status: "open",
              deadlinePresence: "dated",
              deadlineFrom: range.from,
              deadlineTo: range.to,
            }),
          ),
          collectPages((offset) =>
            getEvents({
              offset,
              startsAtFrom: range.from,
              startsAtTo: range.to,
            }),
          ),
        ]);
        setCalendarOccurrences(legacyOccurrences(tasks, events));
      }
    }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadOverview(upcomingDays),
        ...(visibleRange ? [loadCalendar(visibleRange)] : []),
      ]);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadCalendar, loadOverview, onError, upcomingDays, visibleRange]);

  useEffect(() => {
    void getUserPreferences()
      .then((preferences) => setUpcomingDays(preferences.upcoming_days))
      .catch((error) => onError((error as Error).message));
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const loadMoreOverview = useCallback(async () => {
    if (!overviewCursor) return;
    try {
      const now = new Date(),
        end = new Date(now.getTime() + upcomingDays * 86_400_000),
        page = await getOccurrences({
          from: "1970-01-01T00:00:00.000Z",
          to: end.toISOString(),
          limit: 100,
          cursor: overviewCursor,
        });
      setOverviewOccurrences((items) => [...items, ...page.items]);
      setOverviewCursor(page.next_cursor);
    } catch (error) {
      onError((error as Error).message);
    }
  }, [onError, overviewCursor, upcomingDays]);

  const changeHorizon = useCallback(
    async (value: number) => {
      setUpcomingDays(value);
      try {
        await updateUserPreferences({ upcoming_days: value });
        await loadOverview(value);
      } catch (error) {
        onError((error as Error).message);
      }
    },
    [loadOverview, onError],
  );

  const updateVisibleRange = useCallback(
    (range: { from: string; to: string }) =>
      setVisibleRange((current) =>
        current?.from === range.from && current.to === range.to
          ? current
          : range,
      ),
    [],
  );

  const entries = useMemo(
    () => occurrencesToEntries(calendarOccurrences),
    [calendarOccurrences],
  );
  const occupied = useMemo(
    () => new Set(entries.map((entry) => localDateKey(entry.startsAt))),
    [entries],
  );
  const entriesByDate = useMemo(() => {
    const result = new Map<string, CalendarEntry[]>();
    entries.forEach((entry) => {
      const key = localDateKey(entry.startsAt);
      result.set(key, [...(result.get(key) || []), entry]);
    });
    return result;
  }, [entries]);
  const overview = useMemo(
    () =>
      partitionOccurrenceEntries(
        overviewOccurrences,
        undatedTasks,
        new Date(),
        upcomingDays,
      ),
    [overviewOccurrences, undatedTasks, upcomingDays],
  );
  const undatedEntries = useMemo<CalendarEntry[]>(
    () =>
      overview.undated.map((task) => ({
        id: task.id,
        resource: "task",
        title: task.title,
        startsAt: "",
        durationMinutes: task.estimated_minutes,
        task,
      })),
    [overview.undated],
  );
  const overviewTotal =
    overview.overdue.length + overview.upcoming.length + undatedEntries.length;

  return {
    upcomingDays,
    loading,
    occupied,
    entriesByDate,
    overview,
    undatedEntries,
    overviewTotal,
    overviewCursor,
    loadMoreOverview,
    changeHorizon,
    updateVisibleRange,
    refresh,
  };
}
