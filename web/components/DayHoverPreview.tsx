import type { CalendarEntry } from "../types";
import { EntryDetails } from "./EntryDetails";

export function DayHoverPreview({
  date,
  entries,
  x,
  y,
}: {
  date: string;
  entries: CalendarEntry[];
  x: number;
  y: number;
}) {
  const label = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00`));
  return (
    <div
      className="day-hover-preview"
      role="tooltip"
      style={{ left: Math.max(8, x), top: y }}
    >
      <b>{label}</b>
      {entries.slice(0, 4).map((entry) => (
        <EntryDetails
          entry={entry}
          brief
          key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
        />
      ))}
      {entries.length > 4 && <small>Ещё {entries.length - 4}</small>}
    </div>
  );
}
