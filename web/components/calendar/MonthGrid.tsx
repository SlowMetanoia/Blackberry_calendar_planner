import { cn } from "cn";
import { formatHistoryTime } from "../../libs/format";
import type { CalendarEntry, DayHover } from "../../types";
import { Button } from "../ui/button";
import type { CalendarDay } from "../../libs/calendar-utils";
import { weekdays } from "../../libs/calendar-utils";
import { useHorizontalSwipe } from "../../libs/hooks/use-horizontal-swipe";

const dayFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" });

function canHover(): boolean {
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function entryTime(entry: CalendarEntry): string {
  if (!entry.startsAt) return "";
  const time = formatHistoryTime(entry.startsAt);
  return time === "00:00" ? "" : time;
}

export function MonthGrid({
  fullscreen = false,
  month,
  days,
  today,
  occupied,
  entriesByDate,
  onOpenDate,
  onNavigateMonth,
  onDayHover,
}: {
  fullscreen?: boolean;
  month: Date;
  days: CalendarDay[];
  today: string;
  occupied: Set<string>;
  entriesByDate: Map<string, CalendarEntry[]>;
  onOpenDate: (date: string) => void;
  onNavigateMonth: (direction: 1 | -1) => void;
  onDayHover: (hover: DayHover | null, date: string | null) => void;
}) {
  const swipe = useHorizontalSwipe(onNavigateMonth);

  function openDate(date: string) {
    if (swipe.shouldIgnoreClick()) return;
    onOpenDate(date);
  }

  function showPreview(cell: HTMLElement, date: string) {
    if (!canHover()) return;
    const { left, right, top, bottom } = cell.getBoundingClientRect();
    onDayHover({ date, anchor: { left, right, top, bottom } }, date);
  }

  return (
    <>
      <div className="grid shrink-0 grid-cols-7 border-b border-border/70 bg-muted/25">
        {weekdays.map((weekday) => (
          <div
            key={weekday}
            className="px-1 py-1.5 text-center text-[11px] font-medium text-muted-foreground sm:px-2 sm:text-left"
          >
            {weekday}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 touch-pan-y grid-cols-7 gap-px bg-border/70"
        style={{
          gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))`,
        }}
        onTouchStart={swipe.onTouchStart}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
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
                "relative flex min-h-0 cursor-pointer flex-col gap-1 overflow-hidden p-1 transition-colors active:bg-muted/60 sm:p-2",
                isCurrentMonth ? "bg-card" : "bg-muted/25",
                isToday
                  ? "bg-accent/15 hover:bg-accent/20"
                  : "hover:bg-muted/40",
                hasEntries && "calendar-day-occupied",
              )}
              onClick={() => openDate(key)}
              onMouseEnter={(event) => {
                if (hasEntries) showPreview(event.currentTarget, key);
              }}
              onMouseLeave={() => onDayHover(null, key)}
            >
              <div className="flex items-start justify-between gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 p-0 sm:size-6"
                  aria-label={`Открыть дела на ${dayFormat.format(date)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openDate(key);
                  }}
                >
                  <span
                    className={cn(
                      "grid size-7 place-items-center rounded-md text-[13px] font-medium tabular-nums sm:size-6 sm:text-xs",
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
                <div className="mt-auto flex flex-wrap gap-1 pl-0.5 lg:hidden">
                  {entries.slice(0, 4).map((entry) => (
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
    </>
  );
}
