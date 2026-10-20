import { useEffect, useMemo } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "cn";
import { localDateKey } from "../../libs/format";
import type { CalendarEntry, DayHover } from "../../types";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import type { CalendarMode } from "./calendar-utils";
import {
  addDays,
  buildMonthDays,
  buildWeekDays,
  shiftMonth,
  startOfDay,
  withYearMonth,
} from "./calendar-utils";
import { MonthGrid } from "./MonthGrid";
import { WeekGrid } from "./WeekGrid";

const monthFormat = new Intl.DateTimeFormat("ru-RU", { month: "long" });
const monthNames = Array.from({ length: 12 }, (_, index) => {
  const name = monthFormat.format(new Date(2024, index, 1, 12));
  return name.charAt(0).toUpperCase() + name.slice(1);
});
const yearOptions = Array.from({ length: 201 }, (_, index) => 1900 + index);
const selectClassName =
  "h-10 cursor-pointer border-0 bg-transparent pl-1 pr-7 font-heading text-base font-semibold tracking-tight shadow-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-8 sm:text-sm";

export function Calendar({
  fullscreen = false,
  mode,
  anchor,
  occupied,
  entriesByDate,
  onModeChange,
  onAnchorChange,
  onRangeChange,
  onOpenDate,
  onOpenEntry,
  onDayHover,
  onExpand,
}: {
  fullscreen?: boolean;
  mode: CalendarMode;
  anchor: Date;
  occupied: Set<string>;
  entriesByDate: Map<string, CalendarEntry[]>;
  onModeChange: (mode: CalendarMode) => void;
  onAnchorChange: (anchor: Date) => void;
  onRangeChange: (range: { from: string; to: string }) => void;
  onOpenDate: (date: string, time?: string) => void;
  onOpenEntry: (entry: CalendarEntry) => void;
  onDayHover: (hover: DayHover | null, date: string | null) => void;
  onExpand?: () => void;
}) {
  const days = useMemo(
    () => (mode === "week" ? buildWeekDays(anchor) : buildMonthDays(anchor)),
    [anchor, mode],
  );
  const today = localDateKey(new Date());
  const monthLabel = monthNames[anchor.getMonth()];
  const years = useMemo(() => {
    const year = anchor.getFullYear();
    return yearOptions.includes(year)
      ? yearOptions
      : [...yearOptions, year].sort((left, right) => left - right);
  }, [anchor]);

  useEffect(() => {
    if (!days.length) return;
    const from = startOfDay(days[0].date);
    const to = startOfDay(addDays(days[days.length - 1].date, 1));
    onRangeChange({ from: from.toISOString(), to: to.toISOString() });
  }, [days, onRangeChange]);

  function step(direction: number) {
    onAnchorChange(
      mode === "week"
        ? addDays(anchor, direction * 7)
        : shiftMonth(anchor, direction),
    );
  }

  return (
    <div
      className={cn(
        "planner-calendar flex min-h-0 flex-1 flex-col overflow-hidden bg-card",
        fullscreen && "calendar-full",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border/70 px-2 py-2 sm:gap-x-2 sm:px-4">
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-9"
            aria-label={mode === "week" ? "Предыдущая неделя" : "Предыдущий месяц"}
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-9"
            aria-label={mode === "week" ? "Следующая неделя" : "Следующий месяц"}
            onClick={() => step(1)}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>

        <div className="order-3 flex w-full min-w-0 items-center sm:order-none sm:w-auto sm:flex-1">
          <span className="min-w-0 flex-1 sm:w-[9.5rem] sm:flex-none">
            <NativeSelect
              aria-label="Месяц"
              value={anchor.getMonth()}
              className={selectClassName}
              onChange={(event) => {
                onAnchorChange(
                  withYearMonth(
                    anchor,
                    anchor.getFullYear(),
                    Number(event.target.value),
                  ),
                );
              }}
            >
              {monthNames.map((name, index) => (
                <option value={index} key={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </span>
          <span className="w-[4.5rem] shrink-0 sm:w-[5.5rem]">
            <NativeSelect
              aria-label="Год"
              value={anchor.getFullYear()}
              className={selectClassName}
              onChange={(event) => {
                onAnchorChange(
                  withYearMonth(
                    anchor,
                    Number(event.target.value),
                    anchor.getMonth(),
                  ),
                );
              }}
            >
              {years.map((year) => (
                <option value={year} key={year}>
                  {year}
                </option>
              ))}
            </NativeSelect>
          </span>
          <span className="sr-only" aria-live="polite">
            {monthLabel} {anchor.getFullYear()}
          </span>
        </div>

        <div
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5",
            fullscreen && "mr-8",
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:h-9 max-sm:px-2 text-muted-foreground hover:text-foreground"
            onClick={() => onAnchorChange(new Date())}
          >
            Сегодня
          </Button>
          <div
            className="ml-0.5 flex items-center rounded-lg bg-muted/60 p-0.5 sm:ml-1"
            role="group"
            aria-label="Вид календаря"
          >
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-9 rounded-md px-2 text-xs sm:h-6 sm:px-2",
                mode === "month" && "bg-card text-foreground shadow-sm",
              )}
              aria-pressed={mode === "month"}
              onClick={() => onModeChange("month")}
            >
              Месяц
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-9 rounded-md px-2 text-xs sm:h-6 sm:px-2",
                mode === "week" && "bg-card text-foreground shadow-sm",
              )}
              aria-pressed={mode === "week"}
              onClick={() => onModeChange("week")}
            >
              Неделя
            </Button>
          </div>
          {onExpand && (
            <TooltipProvider delayDuration={80}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="max-sm:hidden"
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

      {mode === "week" ? (
        <WeekGrid
          days={days}
          today={today}
          entriesByDate={entriesByDate}
          onOpenDate={onOpenDate}
          onOpenEntry={onOpenEntry}
        />
      ) : (
        <MonthGrid
          fullscreen={fullscreen}
          month={anchor}
          days={days}
          today={today}
          occupied={occupied}
          entriesByDate={entriesByDate}
          onOpenDate={onOpenDate}
          onDayHover={onDayHover}
        />
      )}
    </div>
  );
}
