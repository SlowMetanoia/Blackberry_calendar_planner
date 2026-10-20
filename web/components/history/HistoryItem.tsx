import { Undo2Icon } from "lucide-react";
import {
  operationSchedule,
  operationWords,
  stringField,
  undoWords,
} from "../../libs/calendar-view";
import { formatHistoryTime } from "../../libs/format";
import type { CalendarOperation } from "../../types";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { HistoryItemPreview } from "./HistoryItemPreview";

const operationTone: Record<
  CalendarOperation["operation"],
  { dot: string; label: string }
> = {
  create: { dot: "bg-primary", label: "text-foreground/70" },
  update: { dot: "bg-chart-2", label: "text-foreground/70" },
  delete: { dot: "bg-destructive", label: "text-destructive" },
};

export function HistoryItem({
  item,
  undo,
}: {
  item: CalendarOperation;
  undo: (id: string) => void;
}) {
  const data = item.after || item.before || {},
    title = stringField(data, "title") || item.target_id,
    scheduled = operationSchedule(item.resource, data),
    tone = operationTone[item.operation];

  return (
    <TooltipProvider delayDuration={80}>
      <Tooltip>
        <TooltipTrigger asChild>
          <article
            className={`history-item ${item.operation} group relative grid min-h-11 grid-cols-[2.5rem_auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md px-1.5 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring`}
            tabIndex={0}
            aria-label={`${operationWords[item.operation]}: ${title}${scheduled ? `. ${scheduled}` : ""}`}
          >
            <time
              dateTime={item.created_at}
              className="pt-px text-[11px] leading-4 tabular-nums text-muted-foreground"
            >
              {formatHistoryTime(item.created_at)}
            </time>
            <span
              aria-hidden="true"
              className={`mt-[7px] size-1.5 rounded-full ${tone.dot}`}
            />
            <span className="grid min-w-0 gap-0.5">
              <strong className="truncate text-xs font-semibold">{title}</strong>
              <small className="truncate text-[11px] text-muted-foreground">
                <span className={tone.label}>
                  {operationWords[item.operation]}
                </span>
                {scheduled ? `, ${scheduled}` : ""}
              </small>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Отменить ${undoWords[item.operation]}`}
              onClick={(event) => {
                event.stopPropagation();
                undo(item.id);
              }}
            >
              <Undo2Icon aria-hidden="true" />
            </Button>
          </article>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={10}
          showArrow={false}
          className="block max-w-none bg-transparent p-0 text-foreground shadow-none"
        >
          <HistoryItemPreview item={item} title={title} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
