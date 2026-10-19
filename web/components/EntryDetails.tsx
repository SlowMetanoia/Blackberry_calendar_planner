import { CalendarDaysIcon, ListTodoIcon, RepeatIcon } from "lucide-react";
import { formatDuration, formatSchedule } from "../libs/format";
import type { CalendarEntry } from "../types";
import { Badge } from "./ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "./ui/item";

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
  const schedule = entry.startsAt
    ? formatSchedule(
        entry.startsAt,
        entry.resource === "event" ? entry.durationMinutes : null,
      )
    : "Без срока";

  return (
    <Item
      size="sm"
      className="items-start gap-2.5 border-0 bg-transparent px-0 py-0"
    >
      <ItemMedia className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground">
        {entry.resource === "task" ? (
          <ListTodoIcon aria-hidden="true" />
        ) : (
          <CalendarDaysIcon aria-hidden="true" />
        )}
      </ItemMedia>
      <ItemContent className="gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={entry.resource === "event" ? "secondary" : "outline"}>
            {entryKind(entry)}
          </Badge>
          {entry.recurring && (
            <Badge variant="ghost" className="gap-1 text-[10px]">
              <RepeatIcon aria-hidden="true" />
              повтор
            </Badge>
          )}
        </div>
        <ItemTitle className="text-sm leading-tight">{entry.title}</ItemTitle>
        <ItemDescription className="text-xs">{schedule}</ItemDescription>
        {!brief && (
          <div className="mt-0.5 grid gap-0.5 text-xs leading-relaxed text-muted-foreground">
            {entry.durationMinutes && (
              <span>
                {entry.resource === "event" ? "Длительность" : "Оценка"}:{" "}
                {formatDuration(entry.durationMinutes)}
              </span>
            )}
            {entry.event?.location && <span>Место: {entry.event.location}</span>}
            {entry.task?.status && (
              <span>
                Статус:{" "}
                {entry.task.status === "completed" ? "Выполнена" : "Открыта"}
              </span>
            )}
            {source?.description && <span>Описание: {source.description}</span>}
          </div>
        )}
      </ItemContent>
    </Item>
  );
}
