import { useEffect, useMemo, useState } from "react";
import { getOccurrences, getTasks } from "../../api";
import type { CalendarEntry } from "../../types";
import { collectPages } from "../pagination";
import { occurrencesToEntries, toCalendarEntries } from "../planner-data";
import { useSessionStore } from "../stores";

const HORIZON_DAYS = 7;

export type UpcomingTask = {
  entry: CalendarEntry;
  deadline: number;
  overdue: boolean;
};

// Occurrences carry the key of each recurring task instance, so actions can
// target a single occurrence; plain tasks remain the fallback for old APIs.
async function loadOpenTasks(days: number): Promise<CalendarEntry[]> {
  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  try {
    const page = await getOccurrences({
      resource: "task",
      status: "open",
      from: "1970-01-01T00:00:00.000Z",
      to: horizon,
      limit: 100,
    });
    return occurrencesToEntries(page.items);
  } catch {
    const tasks = await collectPages((offset) =>
      getTasks({ offset, status: "open", deadlinePresence: "dated" }),
    );
    return toCalendarEntries(tasks, []);
  }
}

export function useUpcomingTasks(days = HORIZON_DAYS) {
  const revision = useSessionStore((state) => state.calendarRevision);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const result = await loadOpenTasks(days);
        if (!cancelled) setEntries(result);
      } catch {
        if (!cancelled) {
          setEntries([]);
          setError("Не удалось загрузить задачи.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, days]);

  const items = useMemo<UpcomingTask[]>(() => {
    const now = Date.now();
    const horizon = now + days * 86_400_000;
    return entries
      .map((entry) => ({ entry, deadline: Date.parse(entry.startsAt) }))
      .filter(
        (item) =>
          item.entry.task?.status === "open" &&
          Number.isFinite(item.deadline) &&
          item.deadline < horizon,
      )
      .sort(
        (left, right) =>
          left.deadline - right.deadline ||
          left.entry.title.localeCompare(right.entry.title, "ru"),
      )
      .map((item) => ({ ...item, overdue: item.deadline < now }));
  }, [entries, days]);

  return { items, loading, error };
}
