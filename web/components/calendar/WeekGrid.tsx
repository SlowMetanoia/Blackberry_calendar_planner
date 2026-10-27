import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { formatHistoryTime } from "../../libs/format";
import { useMediaQuery } from "../../libs/hooks/use-media-query";
import type { CalendarEntry } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import type { CalendarDay } from "../../libs/calendar-utils";
import { weekdays } from "../../libs/calendar-utils";
import { useHorizontalSwipe } from "../../libs/hooks/use-horizontal-swipe";

const HOUR_HEIGHT = 48;
const DAY_MINUTES = 24 * 60;
const MIN_BLOCK_HEIGHT = 18;
// Narrower blocks turn titles into unreadable slivers, so overlapping entries
// beyond what fits collapse into a "+N" counter.
const MIN_LANE_WIDTH = 64;
const MIN_LANES = 2;
const MAX_LANES = 4;
const HOUR_SCALE_WIDTH = 48;
const SCROLLBAR_GUTTER = 10;

export function lanesForWidth(columnWidth: number): number {
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) return 3;
  return Math.max(
    MIN_LANES,
    Math.min(MAX_LANES, Math.floor(columnWidth / MIN_LANE_WIDTH)),
  );
}

// `active` re-attaches the observer when the mobile and desktop grids swap.
function useColumnWidth(days: number, gutter: number, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const update = () =>
      setWidth((element.clientWidth - HOUR_SCALE_WIDTH - gutter) / days);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [days, gutter, active]);
  return { ref, width };
}
const monthShortFormat = new Intl.DateTimeFormat("ru-RU", { month: "short" });
const mobileDayFormat = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

type PositionedEntry = {
  entry: CalendarEntry;
  key: string;
  start: number;
  end: number;
  column: number;
  columns: number;
};

type OverflowGroup = {
  key: string;
  start: number;
  end: number;
  column: number;
  columns: number;
  entries: CalendarEntry[];
};

export type WeekDayLayout = {
  items: PositionedEntry[];
  overflow: OverflowGroup[];
};

function assignLanes(
  cluster: PositionedEntry[],
  lanes: number,
): { placed: PositionedEntry[]; rest: PositionedEntry[]; used: number } {
  const columnEnds: number[] = [];
  const placed: PositionedEntry[] = [];
  const rest: PositionedEntry[] = [];
  cluster.forEach((item) => {
    let column = columnEnds.findIndex((end) => end <= item.start);
    if (column === -1 && columnEnds.length < lanes) {
      column = columnEnds.length;
      columnEnds.push(item.end);
    } else if (column !== -1) {
      columnEnds[column] = item.end;
    }
    if (column === -1) rest.push(item);
    else placed.push({ ...item, column });
  });
  return { placed, rest, used: columnEnds.length };
}

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function minutesOfDay(value: string): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 60 + date.getMinutes();
}

function entryBounds(entry: CalendarEntry): { start: number; end: number } | null {
  const start = minutesOfDay(entry.startsAt);
  if (start === null) return null;
  const duration = Math.max(entry.durationMinutes ?? 30, 15);
  return { start, end: Math.min(DAY_MINUTES, start + duration) };
}

export function layoutEntries(
  entries: CalendarEntry[],
  maxLanes = Number.POSITIVE_INFINITY,
): WeekDayLayout {
  const items = entries
    .map((entry) => {
      const bounds = entryBounds(entry);
      if (!bounds) return null;
      return {
        entry,
        key: `${entry.resource}:${entry.occurrenceKey || entry.id}`,
        start: bounds.start,
        end: bounds.end,
        column: 0,
        columns: 1,
      } satisfies PositionedEntry;
    })
    .filter((item): item is PositionedEntry => item !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const result: WeekDayLayout = { items: [], overflow: [] };
  let cluster: PositionedEntry[] = [];
  let clusterEnd = -1;

  function flush() {
    if (!cluster.length) return;
    let lanes = assignLanes(cluster, Number.POSITIVE_INFINITY);
    if (lanes.used > maxLanes) {
      // Keep the last lane for the counter of everything that did not fit.
      lanes = assignLanes(cluster, maxLanes - 1);
      const { rest } = lanes;
      result.overflow.push({
        key: `overflow:${rest[0].key}`,
        start: Math.min(...rest.map((item) => item.start)),
        end: Math.max(...rest.map((item) => item.end)),
        column: maxLanes - 1,
        columns: maxLanes,
        entries: rest.map((item) => item.entry),
      });
    }
    const columns = Math.min(lanes.used + (lanes.rest.length ? 1 : 0), maxLanes);
    lanes.placed.forEach((item) => result.items.push({ ...item, columns }));
    cluster = [];
    clusterEnd = -1;
  }

  items.forEach((item) => {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  });
  flush();
  return result;
}

function mobileDayLabel(day: CalendarDay): string {
  const label = mobileDayFormat.format(day.date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function entryBlockClass(entry: CalendarEntry): string {
  return entry.resource === "event"
    ? "border-chart-2 bg-chart-2/15 active:bg-chart-2/25"
    : entry.resource === "reminder" ? "border-chart-4 bg-chart-4/15 active:bg-chart-4/25"
    : "border-primary bg-primary/10 active:bg-primary/15";
}

function recordsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "записей";
  if (ones === 1) return "запись";
  if (ones >= 2 && ones <= 4) return "записи";
  return "записей";
}

function OverflowBlock({
  group,
  date,
  onOpenDate,
}: {
  group: OverflowGroup;
  date: string;
  onOpenDate: (date: string) => void;
}) {
  const height = (group.end - group.start) * (HOUR_HEIGHT / 60);
  const count = group.entries.length;
  return (
    <button
      type="button"
      aria-label={`Ещё ${count} ${recordsWord(count)} с ${clock(group.start)}, открыть день`}
      title={group.entries.map((entry) => entry.title).join("\n")}
      className="absolute z-10 flex items-start justify-center overflow-hidden rounded-md border border-dashed border-foreground/25 bg-muted px-1 py-0.5 text-[11px] font-semibold tabular-nums text-foreground/75 outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{
        top: (group.start / 60) * HOUR_HEIGHT + 1,
        height: Math.max(height - 2, MIN_BLOCK_HEIGHT),
        left: `calc(${(group.column / group.columns) * 100}% + 1px)`,
        width: `calc(${100 / group.columns}% - 2px)`,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpenDate(date);
      }}
    >
      +{count}
    </button>
  );
}

function HourScale({ className }: { className?: string }) {
  return (
    <div className={cn("relative", className)}>
      {Array.from({ length: 24 }, (_, hour) => (
        <span
          key={hour}
          className={cn(
            "absolute right-2 text-[10px] tabular-nums text-muted-foreground",
            hour > 0 && "-translate-y-1/2",
          )}
          style={{ top: hour * HOUR_HEIGHT }}
        >
          {clock(hour * 60)}
        </span>
      ))}
    </div>
  );
}

export function WeekGrid({
  days,
  today,
  entriesByDate,
  onOpenDate,
  onOpenEntry,
}: {
  days: CalendarDay[];
  today: string;
  entriesByDate: Map<string, CalendarEntry[]>;
  onOpenDate: (date: string, time?: string) => void;
  onOpenEntry: (entry: CalendarEntry) => void;
}) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const viewportRef = useRef<HTMLDivElement>(null);
  const mobileViewportRef = useRef<HTMLDivElement>(null);
  const [selectedKey, setSelectedKey] = useState(
    () => days.find((day) => day.key === today)?.key ?? days[0]?.key ?? "",
  );
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  const selectedIndex = Math.max(
    0,
    days.findIndex((day) => day.key === selectedKey),
  );
  const selectedDay = days[selectedIndex] ?? days[0];
  const selectedEntries = selectedDay
    ? entriesByDate.get(selectedDay.key) || []
    : [];
  const desktopColumns = useColumnWidth(7, SCROLLBAR_GUTTER, !isMobile);
  const mobileColumn = useColumnWidth(1, 0, isMobile && Boolean(selectedDay));
  const selectedLayout = layoutEntries(
    selectedEntries,
    lanesForWidth(mobileColumn.width),
  );

  useEffect(() => {
    setSelectedKey((current) =>
      days.some((day) => day.key === current)
        ? current
        : days.find((day) => day.key === today)?.key ?? days[0]?.key ?? "",
    );
  }, [days, today]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = new Date();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    viewport.scrollTop = Math.max(0, ((minutes - 90) / 60) * HOUR_HEIGHT);
  }, []);

  useEffect(() => {
    const viewport = mobileViewportRef.current;
    if (!viewport) return;
    const now = new Date();
    const startMinutes =
      selectedKey === today
        ? now.getHours() * 60 + now.getMinutes() - 90
        : 7 * 60;
    viewport.scrollTop = Math.max(0, (startMinutes / 60) * HOUR_HEIGHT - 20);
  }, [selectedKey, today]);

  function selectRelativeDay(offset: number) {
    const next = selectedIndex + offset;
    if (next < 0 || next >= days.length) return;
    setSelectedKey(days[next].key);
  }

  const mobileSwipe = useHorizontalSwipe(selectRelativeDay);

  function openSlot(event: MouseEvent<HTMLDivElement>, date: string) {
    if (mobileSwipe.shouldIgnoreClick()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = ((event.clientY - rect.top) / HOUR_HEIGHT) * 60;
    const snapped = Math.max(
      0,
      Math.min(23 * 60 + 30, Math.round(minutes / 30) * 30),
    );
    onOpenDate(date, clock(snapped));
  }

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          role="tablist"
          aria-label="Дни недели"
          className="flex shrink-0 border-b border-border/70 bg-card"
        >
          {days.map((day, index) => {
            const isToday = day.key === today;
            const isSelected = day.key === selectedKey;
            const entries = entriesByDate.get(day.key) || [];
            return (
              <button
                key={day.key}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-label={mobileDayLabel(day)}
                onClick={() => setSelectedKey(day.key)}
                className={cn(
                  "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:bg-muted/50",
                  isToday && !isSelected && "bg-accent/20 text-foreground",
                )}
              >
                <span className="text-[9px] font-medium uppercase tracking-wide opacity-70">
                  {weekdays[index]}
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {day.date.getDate()}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-1 rounded-full",
                    entries.length
                      ? isSelected
                        ? "bg-primary-foreground/80"
                        : "bg-primary"
                      : "bg-transparent",
                  )}
                />
              </button>
            );
          })}
        </div>

        {selectedDay && (
          <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/20 px-1.5">
            <button
              type="button"
              aria-label="Предыдущий день"
              disabled={selectedIndex === 0}
              onClick={() => selectRelativeDay(-1)}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeftIcon aria-hidden="true" className="size-4" />
            </button>
            <div className="grid min-w-0 flex-1 text-center">
              <span className="truncate text-[11.5px] font-medium">
                {mobileDayLabel(selectedDay)}
              </span>
              <span className="truncate text-[10px] text-muted-foreground">
                {selectedEntries.length
                  ? `${selectedEntries.length} в расписании`
                  : "Свободный день"}
              </span>
            </div>
            <button
              type="button"
              aria-label="Следующий день"
              disabled={selectedIndex === days.length - 1}
              onClick={() => selectRelativeDay(1)}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRightIcon aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}

        <div
          className="flex min-h-0 flex-1 touch-pan-y"
          onTouchStart={mobileSwipe.onTouchStart}
          onTouchEnd={mobileSwipe.onTouchEnd}
          onTouchCancel={mobileSwipe.onTouchCancel}
        >
          <ScrollArea
            className="min-h-0 flex-1"
            viewportRef={mobileViewportRef}
            viewportClassName="overscroll-contain"
          >
            {selectedDay && (
              <div
                ref={mobileColumn.ref}
                className="grid"
                style={{
                  gridTemplateColumns: "3rem minmax(0, 1fr)",
                  height: DAY_MINUTES * (HOUR_HEIGHT / 60),
                }}
              >
                <HourScale />

                <div
                  data-week-date={selectedDay.key}
                  className={cn(
                    "relative cursor-pointer border-l border-border/60",
                    selectedDay.key === today && "bg-accent/10",
                  )}
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${HOUR_HEIGHT}px)`,
                  }}
                  onClick={(event) => openSlot(event, selectedDay.key)}
                >
                  {selectedDay.key === today && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                      style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                    >
                      <span className="size-1.5 rounded-full bg-destructive" />
                      <span className="h-px flex-1 bg-destructive" />
                    </div>
                  )}

                  {selectedLayout.overflow.map((group) => (
                    <OverflowBlock
                      key={group.key}
                      group={group}
                      date={selectedDay.key}
                      onOpenDate={onOpenDate}
                    />
                  ))}
                  {selectedLayout.items.map(
                    ({ entry, key, start, end, column, columns }) => {
                      const height = (end - start) * (HOUR_HEIGHT / 60);
                      return (
                        <button
                          type="button"
                          key={key}
                          aria-label={`${entry.title}, ${clock(start)}–${clock(end)}`}
                          className={cn(
                            "absolute z-10 flex flex-col justify-start overflow-hidden rounded-md border-l-[3px] px-2 text-left text-xs leading-tight outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                            height < 26 ? "py-px" : "py-1",
                            entryBlockClass(entry),
                          )}
                          style={{
                            top: (start / 60) * HOUR_HEIGHT + 1,
                            height: Math.max(height - 2, MIN_BLOCK_HEIGHT),
                            left: `calc(${(column / columns) * 100}% + 2px)`,
                            width: `calc(${100 / columns}% - 4px)`,
                          }}
                          title={entry.title}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenEntry(entry);
                          }}
                        >
                          <span className="block truncate font-medium">
                            {entry.title}
                          </span>
                          {height >= 32 && (
                            <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
                              {formatHistoryTime(entry.startsAt)}–{clock(end)}
                            </span>
                          )}
                        </button>
                      );
                    },
                  )}
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-x-auto overscroll-x-contain">
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <div
            className="grid shrink-0 border-b border-border/70 bg-card"
            style={{
              gridTemplateColumns: "3rem repeat(7, minmax(0, 1fr)) 0.625rem",
            }}
          >
            <div />
            {days.map((day, index) => {
              const isToday = day.key === today;
              return (
                <div
                  key={day.key}
                  className={cn(
                    "border-l border-border/60 px-1 py-1.5 text-center",
                    isToday && "bg-accent/15",
                  )}
                >
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {weekdays[index]}
                  </div>
                  <div className="mt-0.5 flex items-center justify-center gap-0.5">
                    <span
                      className={cn(
                        "grid size-6 place-items-center rounded-md text-xs font-semibold tabular-nums",
                        isToday && "bg-accent text-accent-foreground",
                      )}
                    >
                      {day.date.getDate()}
                    </span>
                    {day.date.getDate() === 1 && (
                      <span className="text-[9px] font-normal text-muted-foreground">
                        {monthShortFormat.format(day.date)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div aria-hidden="true" />
          </div>

          <ScrollArea
            className="min-h-0 flex-1"
            viewportRef={viewportRef}
            viewportClassName="overscroll-contain"
          >
            <div
              ref={desktopColumns.ref}
              className="grid"
              style={{
                gridTemplateColumns: "3rem repeat(7, minmax(0, 1fr)) 0.625rem",
                height: DAY_MINUTES * (HOUR_HEIGHT / 60),
              }}
            >
              <HourScale />

              {days.map((day) => {
                const layout = layoutEntries(
                  entriesByDate.get(day.key) || [],
                  lanesForWidth(desktopColumns.width),
                );
                const isToday = day.key === today;
                return (
                  <div
                    key={day.key}
                    data-week-date={day.key}
                    className={cn(
                      "relative cursor-pointer border-l border-border/60",
                      isToday && "bg-accent/15",
                    )}
                    style={{
                      backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${HOUR_HEIGHT}px)`,
                    }}
                    onClick={(event) => openSlot(event, day.key)}
                  >
                    {isToday && (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                        style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                      >
                        <span className="size-1.5 rounded-full bg-destructive" />
                        <span className="h-px flex-1 bg-destructive" />
                      </div>
                    )}

                    {layout.overflow.map((group) => (
                      <OverflowBlock
                        key={group.key}
                        group={group}
                        date={day.key}
                        onOpenDate={onOpenDate}
                      />
                    ))}
                    {layout.items.map(
                      ({ entry, key, start, end, column, columns }) => {
                        const height = (end - start) * (HOUR_HEIGHT / 60);
                        const showTime = height >= 30;
                        return (
                          <button
                            type="button"
                            key={key}
                            aria-label={`${entry.title}, ${clock(start)}–${clock(end)}`}
                            className={cn(
                              "absolute z-10 overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left text-[11px] leading-tight outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                              entry.resource === "event"
                                ? "border-chart-2 bg-chart-2/15 hover:bg-chart-2/25"
                                : "border-primary bg-primary/10 hover:bg-primary/15",
                            )}
                            style={{
                              top: (start / 60) * HOUR_HEIGHT + 1,
                              height: Math.max(height - 2, MIN_BLOCK_HEIGHT),
                              left: `calc(${(column / columns) * 100}% + 1px)`,
                              width: `calc(${100 / columns}% - 2px)`,
                            }}
                            title={entry.title}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenEntry(entry);
                            }}
                          >
                            <span className="block truncate font-medium">
                              {entry.title}
                            </span>
                            {showTime && (
                              <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
                                {formatHistoryTime(entry.startsAt)}–{clock(end)}
                              </span>
                            )}
                          </button>
                        );
                      },
                    )}
                  </div>
                );
              })}
              <div aria-hidden="true" />
            </div>
          </ScrollArea>
        </div>
    </div>
  );
}
