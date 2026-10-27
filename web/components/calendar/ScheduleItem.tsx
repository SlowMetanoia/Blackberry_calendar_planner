import { formatDuration, formatHistoryTime } from "../../libs/format";
import type { CalendarEntry } from "../../types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { TaskActions } from "../shared/TaskActions";
import { EntryDetails } from "./EntryDetails";

export function entryInfo(entry: CalendarEntry): string {
  const duration = entry.durationMinutes
      ? formatDuration(entry.durationMinutes)
      : null,
    detail =
      entry.resource === "event"
        ? [entry.event?.location, duration]
        : [duration];
  return [entry.resource === "event" ? "событие" : entry.resource === "reminder" ? "напоминание" : "задача", ...detail]
    .filter(Boolean)
    .join(", ");
}

export function ScheduleItem({
  entry,
  onOpen,
  taskActions = false,
}: {
  entry: CalendarEntry;
  onOpen: (entry: CalendarEntry) => void;
  taskActions?: boolean;
}) {
  return (
    <div className="group/task flex items-center gap-1">
      <TooltipProvider delayDuration={80}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="group flex min-h-11 w-full min-w-0 flex-1 items-start gap-2.5 rounded-md px-1.5 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0 sm:px-2 sm:py-1.5"
              onClick={() => onOpen(entry)}
            >
              <span className="w-9 shrink-0 pt-px text-[11px] leading-4 font-medium tabular-nums text-muted-foreground">
                {entry.startsAt ? formatHistoryTime(entry.startsAt) : "—"}
              </span>
              <span
                aria-hidden="true"
                className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
                  entry.resource === "event" ? "bg-chart-2" : entry.resource === "reminder" ? "bg-chart-4" : "bg-primary"
                }`}
              />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <strong className="truncate text-[13px] leading-snug font-medium">
                  {entry.title}
                </strong>
                <small className="truncate text-[11px] leading-snug font-normal text-muted-foreground">
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
      {taskActions &&
        entry.resource === "task" &&
        entry.task?.status === "open" && (
          <TaskActions entry={entry} className="text-muted-foreground" />
        )}
    </div>
  );
}
