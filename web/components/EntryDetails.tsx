import { formatDuration, formatSchedule } from "../libs/format";
import type { CalendarEntry } from "../types";

function entryKind(entry: CalendarEntry): string {
  return entry.resource === "task" ? "Задача" : "Событие";
}

export function EntryDetails({
  entry,
  brief = false,
}: {
  entry: CalendarEntry;
  brief?: boolean;
}) {
  const source = entry.task || entry.event;
  return (
    <div className="entry-details">
      <span className="entry-kind">{entryKind(entry)}</span>
      <strong>{entry.title}</strong>
      <span>
        {entry.startsAt
          ? formatSchedule(
              entry.startsAt,
              entry.resource === "event" ? entry.durationMinutes : null,
            )
          : "Без срока"}
      </span>
      {!brief && entry.durationMinutes && (
        <span>
          {entry.resource === "event" ? "Длительность" : "Оценка"}:{" "}
          {formatDuration(entry.durationMinutes)}
        </span>
      )}
      {!brief && entry.event?.location && (
        <span>Место: {entry.event.location}</span>
      )}
      {!brief && entry.task?.status && (
        <span>
          Статус: {entry.task.status === "completed" ? "Выполнена" : "Открыта"}
        </span>
      )}
      {!brief && source?.description && (
        <span>Описание: {source.description}</span>
      )}
    </div>
  );
}
