import type { CalendarEntry } from "../../types";
import { ScheduleItem } from "./ScheduleItem";

export function ScheduleList({
  entries,
  onOpen,
}: {
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
}) {
  return (
    <ul className="grid divide-y divide-border/60">
      {entries.map((entry) => (
        <li key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}>
          <ScheduleItem entry={entry} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}
