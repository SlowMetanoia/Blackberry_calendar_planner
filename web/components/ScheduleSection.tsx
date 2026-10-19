import {
  formatDuration,
  formatHistoryTime,
  localDateKey,
} from "../libs/format";
import type { CalendarEntry } from "../types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { EntryDetails } from "./EntryDetails";

function dayMonth(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(value);
}

function dayHeading(date: string): { lead: string; rest: string } {
  const value = new Date(`${date}T12:00:00`),
    today = localDateKey(new Date()),
    tomorrow = localDateKey(new Date(Date.now() + 86_400_000));
  if (date === today) return { lead: "Сегодня", rest: dayMonth(value) };
  if (date === tomorrow) return { lead: "Завтра", rest: dayMonth(value) };
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short" })
    .format(value)
    .replace(".", "");
  return {
    lead: weekday.charAt(0).toUpperCase() + weekday.slice(1),
    rest: dayMonth(value),
  };
}

function entryInfo(entry: CalendarEntry): string {
  const duration = entry.durationMinutes
      ? formatDuration(entry.durationMinutes)
      : null,
    detail =
      entry.resource === "event"
        ? [entry.event?.location, duration]
        : [duration];
  return [entry.resource === "event" ? "событие" : "задача", ...detail]
    .filter(Boolean)
    .join(", ");
}

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

export function ScheduleSection({
  title,
  entries,
  onOpen,
  overdue = false,
}: {
  title: string;
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
  overdue?: boolean;
}) {
  if (!entries.length) return null;
  const groups = new Map<string, CalendarEntry[]>();
  entries.forEach((entry) => {
    const key = localDateKey(entry.startsAt);
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  return (
    <section className="grid gap-1.5">
      <h3 className="flex items-baseline gap-1.5 px-2 text-xs font-semibold">
        <span className={overdue ? "text-destructive" : "text-foreground"}>
          {title}
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">
          {entries.length}
        </span>
      </h3>
      <div className="grid gap-2.5">
        {[...groups.entries()].map(([date, items]) => {
          const heading = dayHeading(date);
          return (
            <div className="grid" key={date}>
              <h4 className="flex items-baseline gap-1.5 px-2 pb-1 text-[11px] leading-none">
                <span className="font-semibold text-foreground">
                  {heading.lead}
                </span>
                <span className="text-muted-foreground">{heading.rest}</span>
              </h4>
              <ScheduleList entries={items} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
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
          <button
            type="button"
            className="group flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => onOpen(entry)}
          >
            <span className="w-10 shrink-0 pt-px text-[11px] leading-4 font-medium tabular-nums text-muted-foreground">
              {entry.startsAt ? formatHistoryTime(entry.startsAt) : "—"}
            </span>
            <span
              aria-hidden="true"
              className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
                entry.resource === "event" ? "bg-chart-2" : "bg-primary"
              }`}
            />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <strong className="truncate text-xs font-semibold">
                {entry.title}
              </strong>
              <small className="truncate text-[11px] font-normal text-muted-foreground">
                {entryInfo(entry)}
              </small>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          align="start"
          sideOffset={10}
          showArrow={false}
          className="block max-w-none bg-transparent p-0 text-foreground shadow-none"
        >
          <div className="w-80 rounded-xl bg-popover p-3 shadow-lg ring-1 ring-border">
            <EntryDetails entry={entry} />
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
