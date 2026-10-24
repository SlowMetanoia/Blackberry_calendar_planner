import { formatDuration } from "../../libs/format";
import {
  useWeekOccupancy,
  type WeekOccupancyDay,
} from "../../libs/hooks/use-week-occupancy";

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

export function WeekHeatmap() {
  const { days, totalMinutes, rangeLabel, loading, error } = useWeekOccupancy();
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

      <div
        role="img"
        aria-label={`Занятость по дням. ${summary}`}
        className="grid grid-cols-7 gap-1"
      >
        {days.map((day) => (
          <div
            key={day.key}
            className={`flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md ${
              HEAT_CELL[busyLevel(day.busyMinutes)]
            } ${day.isToday ? "ring-1 ring-[#b7a5c5]" : ""}`}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
              {day.weekday}
            </span>
            <span className="text-[12px] font-semibold tabular-nums">
              {day.dayNumber}
            </span>
          </div>
        ))}
      </div>

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
