import { useEffect, useState } from "react";
import { getReminders } from "../../api";
import type { CalendarEntry } from "../../types";
import { addDays } from "../calendar-utils";
import { localDateKey } from "../format";
import { collectPages } from "../pagination";
import { occurrencesToEntries, reminderEntry } from "../planner-data";
import { useSessionStore } from "../stores";
import { loadOccurrencesInRange } from "./use-week-occupancy";

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

// Everything scheduled on one local day, independent of the calendar view.
export function useDayEntries(date: string | null) {
  const revision = useSessionStore((state) => state.calendarRevision);
  const setError = useSessionStore((state) => state.setError);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    if (!date) return;
    let cancelled = false;
    const from = new Date(`${date}T00:00:00`);
    const to = addDays(from, 1);
    void Promise.all([
      loadOccurrencesInRange(from, to),
      collectPages((offset) =>
        getReminders({
          offset,
          remindFrom: from.toISOString(),
          remindTo: to.toISOString(),
        }),
      ),
    ])
      .then(([occurrences, reminders]) => {
        if (cancelled) return;
        setEntries(
          [
            ...occurrencesToEntries(occurrences),
            ...reminders
              .filter((reminder) => reminder.status !== "cancelled")
              .map(reminderEntry),
          ]
            .filter((entry) => localDateKey(entry.startsAt) === date)
            .sort(
              (left, right) =>
                timestamp(left.startsAt) - timestamp(right.startsAt) ||
                left.title.localeCompare(right.title, "ru"),
            ),
        );
      })
      .catch((error) => {
        if (!cancelled) setError((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [date, revision, setError]);

  return entries;
}
