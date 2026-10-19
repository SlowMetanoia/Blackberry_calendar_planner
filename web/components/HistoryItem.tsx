import { Undo2Icon } from "lucide-react";
import {
  operationSchedule,
  operationWords,
  resourceMetadata,
  stringField,
  undoWords,
} from "../libs/calendar-view";
import { formatHistoryTime } from "../libs/format";
import type { CalendarOperation } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Separator } from "./ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { Changes } from "./Changes";
import { Metadata } from "./Metadata";

const operationTone: Record<CalendarOperation["operation"], string> = {
  create: "border-emerald-200/70 bg-emerald-50/70",
  update: "border-amber-200/80 bg-amber-50/75",
  delete: "border-rose-200/80 bg-rose-50/70",
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
    scheduled = operationSchedule(item.resource, data);

  return (
    <TooltipProvider delayDuration={80}>
      <Tooltip>
        <TooltipTrigger asChild>
          <article
            className={`history-item ${item.operation} group relative flex min-h-11 min-w-0 items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${operationTone[item.operation]}`}
            tabIndex={0}
            aria-label={`${operationWords[item.operation]}: ${title}${scheduled ? `. ${scheduled}` : ""}`}
          >
            <time
              dateTime={item.created_at}
              className="w-9 shrink-0 text-[10px] tabular-nums text-muted-foreground"
            >
              {formatHistoryTime(item.created_at)}
            </time>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-xs font-semibold">{title}</span>
              {scheduled && (
                <small className="truncate text-[9px] text-muted-foreground">
                  {scheduled}
                </small>
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="shrink-0 bg-card/80"
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
          <Card size="sm" className="w-80 shadow-xl ring-border">
            <CardHeader className="gap-1.5">
              <Badge
                variant={item.operation === "delete" ? "destructive" : "secondary"}
                className="w-fit"
              >
                {operationWords[item.operation]}
              </Badge>
              <CardTitle className="text-sm">{title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              <Metadata items={resourceMetadata(item.resource, data)} />
              {item.operation === "update" && (
                <>
                  <Separator />
                  <Changes changes={item.changes} />
                </>
              )}
            </CardContent>
            <CardFooter className="py-2 text-[11px] text-muted-foreground">
              Источник: {item.origin}
              {item.reverts_operation_id ? " · компенсирующая операция" : ""}
            </CardFooter>
          </Card>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
