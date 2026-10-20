import { useEffect, useMemo } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "cn";
import { formatHistoryTime, localDateKey } from "../../libs/format";
import type { CalendarEntry, DayHover } from "../../types";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthFormat = new Intl.DateTimeFormat("ru-RU", { month: "long" });
const dayFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" });

type CalendarDay = { date: Date; key: string };

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function shiftMonth(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
}

function buildDays(month: Date): CalendarDay[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const days: CalendarDay[] = [];

  for (let date = start; date <= end; date = addDays(date, 1)) {
    days.push({ date, key: localDateKey(date) });
  }
  return days;
}

function entryTime(entry: CalendarEntry): string {
  if (!entry.startsAt) return "";
  const time = formatHistoryTime(entry.startsAt);
  return time === "00:00" ? "" : time;
}

export function MonthCalendar({
  fullscreen = false,
  month,
  occupied,
  entriesByDate,
  onMonthChange,
  onRangeChange,
  onOpenDate,
  onDayHover,
  onExpand,
}: {
  fullscreen?: boolean;
  month: Date;
  occupied: Set<string>;
  entriesByDate: Map<string, CalendarEntry[]>;
  onMonthChange: (month: Date) => void;
  onRangeChange: (range: { from: string; to: string }) => void;
  onOpenDate: (date: string) => void;
  onDayHover: (hover: DayHover | null, date: string | null) => void;
  onExpand?: () => void;
}) {
  const days = useMemo(() => buildDays(month), [month]);
  const today = localDateKey(new Date());
  const title = `${monthFormat.format(month)} ${month.getFullYear()}`;

  useEffect(() => {
    if (!days.length) return;
    const from = startOfDay(days[0].date);
    const to = startOfDay(addDays(days[days.length - 1].date, 1));
    onRangeChange({ from: from.toISOString(), to: to.toISOString() });
  }, [days, onRangeChange]);

  function showPreview(cell: HTMLElement, date: string) {
    const rect = cell.getBoundingClientRect();
    onDayHover(
      {
        date,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 316)),
        y:
          rect.bottom + 260 < window.innerHeight
            ? rect.bottom + 6
            : Math.max(8, rect.top - 254),
      },
      date,
    );
  }

  return (
    <div
      className={cn(
        "planner-calendar flex min-h-0 flex-1 flex-col overflow-hidden bg-card",
        fullscreen && "calendar-full",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-3 sm:px-4">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Предыдущий месяц"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Следующий месяц"
            onClick={() => onMonthChange(shiftMonth(month, 1))}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
        <h2
          className="min-w-0 flex-1 truncate font-heading text-base font-semibold tracking-tight first-letter:uppercase"
          aria-live="polite"
        >
          {title}
        </h2>
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            fullscreen && "mr-8",
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              const now = new Date();
              onMonthChange(new Date(now.getFullYear(), now.getMonth(), 1, 12));
            }}
          >
            Сегодня
          </Button>
          {onExpand && (
            <TooltipProvider delayDuration={80}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Развернуть календарь"
                    onClick={onExpand}
                  >
                    <Maximize2Icon aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Развернуть календарь</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-7 border-b border-border/70 bg-muted/25">
        {weekdays.map((weekday) => (
          <div
            key={weekday}
            className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground"
          >
            {weekday}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-7 gap-px bg-border/70"
        style={{
          gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))`,
        }}
      >
        {days.map(({ date, key }) => {
          const entries = entriesByDate.get(key) || [];
          const isCurrentMonth =
            date.getMonth() === month.getMonth() &&
            date.getFullYear() === month.getFullYear();
          const isToday = key === today;
          const hasEntries = occupied.has(key);
          const visibleEntries = isCurrentMonth ? entries.slice(0, 3) : [];
          const hiddenCount = isCurrentMonth
            ? entries.length - visibleEntries.length
            : 0;

          return (
            <div
              key={key}
              data-date={key}
              className={cn(
                "relative flex min-h-0 cursor-pointer flex-col gap-1 overflow-hidden p-1.5 transition-colors sm:p-2",
                isCurrentMonth ? "bg-card" : "bg-muted/25",
                isToday
                  ? "bg-accent/15 hover:bg-accent/20"
                  : "hover:bg-muted/40",
                hasEntries && "calendar-day-occupied",
              )}
              onClick={() => onOpenDate(key)}
              onMouseEnter={(event) => {
                if (hasEntries) showPreview(event.currentTarget, key);
              }}
              onMouseLeave={() => onDayHover(null, key)}
            >
              <div className="flex items-start justify-between gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="p-0"
                  aria-label={`Открыть дела на ${dayFormat.format(date)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenDate(key);
                  }}
                >
                  <span
                    className={cn(
                      "grid size-6 place-items-center rounded-md text-xs font-medium tabular-nums",
                      isCurrentMonth
                        ? "text-foreground/80"
                        : "text-muted-foreground/60",
                      isToday && "bg-accent text-accent-foreground",
                    )}
                  >
                    {date.getDate()}
                  </span>
                </Button>
                {hiddenCount > 0 && (
                  <span className="pt-1 text-[10px] leading-none tabular-nums text-muted-foreground">
                    +{hiddenCount}
                  </span>
                )}
              </div>

              {isCurrentMonth && entries.length > 0 && (
                <div className="mt-auto flex gap-1 lg:hidden">
                  {entries.slice(0, 3).map((entry) => (
                    <span
                      key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
                      className={cn(
                        "size-1.5 rounded-full",
                        entry.resource === "event"
                          ? "bg-chart-2"
                          : "bg-primary",
                      )}
                    />
                  ))}
                </div>
              )}

              {visibleEntries.length > 0 && (
                <div className="hidden min-h-0 flex-1 content-start gap-1 overflow-hidden lg:grid">
                  {visibleEntries.map((entry) => (
                    <div
                      key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          entry.resource === "event"
                            ? "bg-chart-2"
                            : "bg-primary",
                        )}
                      />
                      {entryTime(entry) && (
                        <span
                          className={cn(
                            "shrink-0 text-[10px] leading-4 tabular-nums text-muted-foreground",
                            !fullscreen && "hidden 2xl:inline",
                          )}
                        >
                          {entryTime(entry)}
                        </span>
                      )}
                      <span className="truncate text-[11px] leading-4 text-foreground/85">
                        {entry.title}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
