import type { CalendarEntry } from "../../types";
import { ScheduleItem } from "./ScheduleItem";

export function ScheduleList({
  entries,
  onOpen,
  taskActions = false,
}: {
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
  taskActions?: boolean;
}) {
  return (
    <ul className="grid divide-y divide-border/60">
      {entries.map((entry) => (
        <li key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}>
          <ScheduleItem
            entry={entry}
            onOpen={onOpen}
            taskActions={taskActions}
          />
        </li>
      ))}
    </ul>
  );
}
