import { CalendarClockIcon, ListTodoIcon } from "lucide-react";
import { localDateKey } from "../libs/format";
import type { CalendarEntry } from "../types";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { EntryDetails } from "./EntryDetails";

function entryLabel(entry: CalendarEntry): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.startsAt));
}

export function ScheduleSection({
  title,
  entries,
  onOpen,
}: {
  title: string;
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
}) {
  if (!entries.length) return null;
  const groups = new Map<string, CalendarEntry[]>();
  entries.forEach((entry) => {
    const key = localDateKey(entry.startsAt);
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  return (
    <section className="grid gap-2">
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </h3>
      {[...groups.entries()].map(([date, items]) => (
        <div className="grid gap-1.5" key={date}>
          <h4 className="px-1 text-[10px] font-medium text-muted-foreground capitalize">
            {new Intl.DateTimeFormat("ru-RU", {
              weekday: "short",
              day: "numeric",
              month: "short",
            }).format(new Date(`${date}T12:00:00`))}
          </h4>
          {items.map((entry) => (
            <ScheduleItem
              entry={entry}
              key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
              onOpen={onOpen}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

export function ScheduleItem({
  entry,
  onOpen,
}: {
  entry: CalendarEntry;
  onOpen: (entry: CalendarEntry) => void;
}) {
  return (
    <TooltipProvider delayDuration={80}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start gap-2.5 border-l-4 border-l-primary/65 bg-card px-2.5 py-2 text-left whitespace-normal shadow-none"
            onClick={() => onOpen(entry)}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {entry.resource === "event" ? (
                <CalendarClockIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <ListTodoIcon aria-hidden="true" className="size-3.5" />
              )}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <strong className="truncate text-xs font-semibold">
                {entry.title}
              </strong>
              <small className="truncate text-[10px] font-normal text-muted-foreground">
                {entry.startsAt
                  ? `${entryLabel(entry)} · ${entry.resource === "task" ? "задача" : "событие"}`
                  : "Задача без срока"}
              </small>
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          align="start"
          sideOffset={10}
          showArrow={false}
          className="block max-w-none bg-transparent p-0 text-foreground shadow-none"
        >
          <Card size="sm" className="w-80 p-3 shadow-xl ring-border">
            <CardContent className="px-0">
              <EntryDetails entry={entry} />
            </CardContent>
          </Card>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
