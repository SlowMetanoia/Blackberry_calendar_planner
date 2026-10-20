import { useEffect, useMemo } from "react";
import { localDateKey } from "../format";
import {
  occurrencesToEntries,
  partitionOccurrenceEntries,
} from "../planner-data";
import { useCalendarStore, useSessionStore } from "../stores";
import type { CalendarEntry } from "../../types";

export function useCalendarData() {
  const revision = useSessionStore((state) => state.calendarRevision);
  const upcomingDays = useCalendarStore((state) => state.upcomingDays);
  const undatedTasks = useCalendarStore((state) => state.undatedTasks);
  const overviewOccurrences = useCalendarStore(
    (state) => state.overviewOccurrences,
  );
  const overviewCursor = useCalendarStore((state) => state.overviewCursor);
  const calendarOccurrences = useCalendarStore(
    (state) => state.calendarOccurrences,
  );
  const loading = useCalendarStore((state) => state.loading);
  const refresh = useCalendarStore((state) => state.refresh);
  const loadMoreOverview = useCalendarStore(
    (state) => state.loadMoreOverview,
  );
  const changeHorizon = useCalendarStore((state) => state.changeHorizon);
  const updateVisibleRange = useCalendarStore(
    (state) => state.updateVisibleRange,
  );

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

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
