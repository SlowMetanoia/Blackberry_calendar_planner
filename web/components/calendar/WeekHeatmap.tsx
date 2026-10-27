import { formatDuration, formatHistoryTime } from "../../libs/format";
import {
  useWeekOccupancy,
  type WeekOccupancyDay,
} from "../../libs/hooks/use-week-occupancy";
import { useUiStore } from "../../libs/stores";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const HEAT_CELL = [
  "bg-[#272638] text-[#c8c4cf]/65",
  "bg-[#3b3552] text-[#d8d2df]/80",
  "bg-[#504568] text-[#e4ddea]",
  "bg-[#665575] text-[#f0eaf4]",
  "bg-[#7d6a89] text-white",
];

const HEAT_SWATCH = [
  "bg-[#272638]",
  "bg-[#3b3552]",
  "bg-[#504568]",
  "bg-[#665575]",
  "bg-[#7d6a89]",
];

const dayFormatter = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

function busyLevel(minutes: number): number {
  if (minutes <= 0) return 0;
  if (minutes < 60) return 1;
  if (minutes < 180) return 2;
  if (minutes < 360) return 3;
  return 4;
}

function dayLabel(day: WeekOccupancyDay): string {
  const label = dayFormatter.format(day.date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function busyLabel(minutes: number): string {
  return minutes > 0 ? formatDuration(minutes) : "свободно";
}

function shortDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} мин`;
  if (!rest) return `${hours} ч`;
  return `${hours} ч ${rest} мин`;
}

const PREVIEW_LIMIT = 6;

function DayPreview({ day }: { day: WeekOccupancyDay }) {
  const shown = day.entries.slice(0, PREVIEW_LIMIT);
  return (
    <div className="grid w-64 gap-2 rounded-xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-border">
      <div className="flex items-baseline justify-between gap-2">
        <strong className="truncate text-[13px] font-semibold">
          {dayLabel(day)}
        </strong>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {busyLabel(day.busyMinutes)}
        </span>
      </div>
      {shown.length ? (
        <ul className="grid gap-1">
          {shown.map((entry) => (
            <li
              key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
              className="flex min-w-0 items-baseline gap-2 text-[12px]"
            >
              <span className="w-9 shrink-0 tabular-nums text-muted-foreground">
                {formatHistoryTime(entry.startsAt)}
              </span>
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                  entry.resource === "event" ? "bg-chart-2" : "bg-primary"
                }`}
              />
              <span className="truncate">{entry.title}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted-foreground">Дел нет</p>
      )}
      {day.entries.length > shown.length && (
        <small className="text-[11px] text-muted-foreground">
          Ещё {day.entries.length - shown.length}
        </small>
      )}
    </div>
  );
}

export function WeekHeatmap() {
  const { days, totalMinutes, rangeLabel, loading, error } = useWeekOccupancy();
  const openDay = useUiStore((state) => state.openDay);
  const summary = days
    .map((day) => `${dayLabel(day)}: ${busyLabel(day.busyMinutes)}`)
    .join("; ");

  return (
    <section aria-label="Занятость недели" className="grid gap-2">
      <div className="grid min-w-0 gap-0.5">
        <h3 className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/40">
          Занятость недели
        </h3>
        <p className="truncate text-[11.5px] text-sidebar-foreground/50">
          {loading
            ? "Загружаем…"
            : error ||
              `${rangeLabel} · ${
                totalMinutes ? shortDuration(totalMinutes) : "свободно"
              }`}
        </p>
      </div>

      <TooltipProvider delayDuration={120}>
        <div
          role="group"
          aria-label={`Занятость по дням. ${summary}`}
          className="grid grid-cols-7 gap-1"
        >
          {days.map((day) => (
            <Tooltip key={day.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${dayLabel(day)}: ${busyLabel(day.busyMinutes)}. Открыть день`}
                  onClick={() => openDay(day.key)}
                  className={`flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md transition-[filter] outline-none hover:brightness-125 focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 ${
                    HEAT_CELL[busyLevel(day.busyMinutes)]
                  } ${day.isToday ? "ring-1 ring-[#b7a5c5]" : ""}`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                    {day.weekday}
                  </span>
                  <span className="text-[12px] font-semibold tabular-nums">
                    {day.dayNumber}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                showArrow={false}
                className="block max-w-none bg-transparent p-0 text-foreground shadow-none"
              >
                <DayPreview day={day} />
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>

      <div className="flex items-center justify-end gap-1 text-[10px] text-sidebar-foreground/35">
        <span>меньше</span>
        {HEAT_SWATCH.map((className) => (
          <span key={className} className={`size-2 rounded-[2px] ${className}`} />
        ))}
        <span>больше</span>
      </div>
    </section>
  );
}
