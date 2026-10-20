import { formatDuration, formatHistoryTime } from "../../libs/format";
import type { CalendarEntry } from "../../types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { EntryDetails } from "./EntryDetails";

export function entryInfo(entry: CalendarEntry): string {
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
