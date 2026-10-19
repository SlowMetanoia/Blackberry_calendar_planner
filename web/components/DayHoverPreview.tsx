import type { CalendarEntry } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
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
    <Card
      className="day-hover-preview fixed z-[110] w-[300px] max-w-[calc(100vw-16px)] gap-2 p-3 shadow-xl"
      role="tooltip"
      style={{ left: Math.max(8, x), top: y }}
    >
      <CardHeader className="gap-0 px-0">
        <CardTitle className="text-sm capitalize">{label}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-0">
        {entries.slice(0, 4).map((entry) => (
          <EntryDetails
            entry={entry}
            brief
            key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
          />
        ))}
        {entries.length > 4 && (
          <small className="text-xs text-muted-foreground">
            Ещё {entries.length - 4}
          </small>
        )}
      </CardContent>
    </Card>
  );
}
