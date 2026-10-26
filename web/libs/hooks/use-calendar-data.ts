import { useEffect, useMemo } from "react";
import { localDateKey } from "../format";
import {
  occurrencesToEntries,
  partitionOccurrenceEntries,
} from "../planner-data";
import { useCalendarStore, useSessionStore } from "../stores";
import type { CalendarEntry } from "../../types";

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

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
  const reminders = useCalendarStore((state) => state.reminders);
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

  useEffect(() => {
    const update = () => void refresh();
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [refresh]);

  const reminderEntries = useMemo<CalendarEntry[]>(() => reminders
    .filter(item => item.status !== "cancelled")
    .map(reminder => ({id:reminder.id,resource:"reminder",title:reminder.title,startsAt:reminder.remind_at,durationMinutes:null,reminder})), [reminders]);

  const entries = useMemo(
    () =>
      [...occurrencesToEntries(calendarOccurrences), ...reminderEntries].sort(
        (left, right) =>
          timestamp(left.startsAt) - timestamp(right.startsAt) ||
          left.title.localeCompare(right.title, "ru"),
      ),
    [calendarOccurrences, reminderEntries],
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
    () => {
      const result = partitionOccurrenceEntries(
        overviewOccurrences,
        undatedTasks,
        new Date(),
        upcomingDays,
      );
      const end = Date.now() + upcomingDays * 86400000;
      result.upcoming.push(...reminderEntries.filter(item => item.reminder?.status === "active" && timestamp(item.startsAt) < end));
      result.upcoming.sort((left,right)=>timestamp(left.startsAt)-timestamp(right.startsAt));
      return result;
    },
    [overviewOccurrences, undatedTasks, upcomingDays, reminderEntries],
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
