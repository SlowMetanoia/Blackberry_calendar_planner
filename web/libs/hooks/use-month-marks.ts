import { useEffect, useMemo, useState } from "react";
import type { CalendarOccurrence, Task } from "../../types";
import { addDays, buildMonthDays } from "../calendar-utils";
import { localDateKey } from "../format";
import { useSessionStore } from "../stores";
import { loadOccurrencesInRange } from "./use-week-occupancy";

function isActive(item: CalendarOccurrence): boolean {
  return item.resource === "event" || (item.data as Task).status === "open";
}

// Days of the displayed month grid that have events or open tasks.
export function useMonthMarks(month: Date) {
  const revision = useSessionStore((state) => state.calendarRevision);
  const days = useMemo(() => buildMonthDays(month), [month]);
  const [marked, setMarked] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const from = new Date(days[0].date);
    from.setHours(0, 0, 0, 0);
    const to = addDays(days[days.length - 1].date, 1);
    to.setHours(0, 0, 0, 0);
    void loadOccurrencesInRange(from, to)
      .then((items) => {
        if (cancelled) return;
        setMarked(
          new Set(
            items
              .filter(isActive)
              .map((item) => localDateKey(item.scheduled_at)),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setMarked(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [days, revision]);

  return { days, marked };
}
