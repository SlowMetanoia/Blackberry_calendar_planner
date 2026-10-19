import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDaysIcon,
  ChevronsUpDownIcon,
  Maximize2Icon,
  XIcon,
} from "lucide-react";
import FullCalendar, { type DatesSetInfo } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import ruLocale from "@fullcalendar/react/locales/ru";
import "temporal-polyfill/global";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import {
  getEvents,
  getOccurrences,
  getTasks,
  getUserPreferences,
  updateUserPreferences,
} from "../api";
import { localDateKey } from "../libs/format";
import { collectPages } from "../libs/pagination";
import {
  occurrencesToEntries,
  partitionOccurrenceEntries,
} from "../libs/planner-data";
import type {
  CalendarEntry,
  CalendarOccurrence,
  DayHover,
  EditorState,
  Event,
  Resource,
  Task,
} from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { NativeSelect } from "./ui/native-select";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { CalendarItemDialog } from "./CalendarItemDialog";
import { DayDialog } from "./DayDialog";
import { DayHoverPreview } from "./DayHoverPreview";
import { ScheduleItem, ScheduleSection } from "./ScheduleSection";

const horizonOptions = [1, 3, 7, 14, 30];

function legacyOccurrences(
  tasks: Task[],
  events: Event[],
): CalendarOccurrence[] {
  return [
    ...tasks
      .filter((item) => item.deadline)
      .map((item) => ({
        resource: "task" as const,
        series_id: item.id,
        occurrence_key: `legacy-${item.id}`,
        original_at: item.deadline!,
        scheduled_at: item.deadline!,
        recurring: false,
        data: item,
      })),
    ...events.map((item) => ({
      resource: "event" as const,
      series_id: item.id,
      occurrence_key: `legacy-${item.id}`,
      original_at: item.starts_at,
      scheduled_at: item.starts_at,
      recurring: false,
      data: item,
    })),
  ];
}

export function PlannerSidebar({
  open,
  onClose,
  revision,
  onHistoryChanged,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  revision: number;
  onHistoryChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [upcomingDays, setUpcomingDays] = useState(7),
    [undatedTasks, setUndatedTasks] = useState<Task[]>([]),
    [overviewOccurrences, setOverviewOccurrences] = useState<
      CalendarOccurrence[]
    >([]),
    [overviewCursor, setOverviewCursor] = useState<string | null>(null);
  const [calendarOccurrences, setCalendarOccurrences] = useState<
    CalendarOccurrence[]
  >([]);
  const [visibleRange, setVisibleRange] = useState<{
      from: string;
      to: string;
    } | null>(null),
    [loading, setLoading] = useState(true),
    [fullOpen, setFullOpen] = useState(false);
  const [dayOpen, setDayOpen] = useState<string | null>(null),
    [dayHover, setDayHover] = useState<DayHover | null>(null),
    [editor, setEditor] = useState<EditorState | null>(null);

  const loadOverview = useCallback(async (days: number) => {
    const now = new Date(),
      end = new Date(now.getTime() + days * 86_400_000);
    const undated = await collectPages((offset) =>
      getTasks({ offset, status: "open", deadlinePresence: "undated" }),
    );
    try {
      const occurrences = await getOccurrences({
        from: "1970-01-01T00:00:00.000Z",
        to: end.toISOString(),
        limit: 100,
      });
      setOverviewOccurrences(occurrences.items);
      setOverviewCursor(occurrences.next_cursor);
    } catch {
      const [dated, events] = await Promise.all([
        collectPages((offset) =>
          getTasks({
            offset,
            status: "open",
            deadlinePresence: "dated",
            deadlineTo: end.toISOString(),
          }),
        ),
        collectPages((offset) =>
          getEvents({
            offset,
            startsAtFrom: now.toISOString(),
            startsAtTo: end.toISOString(),
          }),
        ),
      ]);
      setOverviewOccurrences(legacyOccurrences(dated, events));
      setOverviewCursor(null);
    }
    setUndatedTasks(undated);
  }, []);

  const loadMoreOverview = async () => {
    if (!overviewCursor) return;
    try {
      const now = new Date(),
        end = new Date(now.getTime() + upcomingDays * 86_400_000),
        page = await getOccurrences({
          from: "1970-01-01T00:00:00.000Z",
          to: end.toISOString(),
          limit: 100,
          cursor: overviewCursor,
        });
      setOverviewOccurrences((items) => [...items, ...page.items]);
      setOverviewCursor(page.next_cursor);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const loadCalendar = useCallback(
    async (range: { from: string; to: string }) => {
      try {
        const first = await getOccurrences({
          from: range.from,
          to: range.to,
          limit: 100,
        });
        const result = [...first.items];
        let cursor = first.next_cursor;
        while (cursor) {
          const page = await getOccurrences({
            from: range.from,
            to: range.to,
            limit: 100,
            cursor,
          });
          result.push(...page.items);
          cursor = page.next_cursor;
        }
        setCalendarOccurrences(result);
      } catch {
        const [tasks, events] = await Promise.all([
          collectPages((offset) =>
            getTasks({
              offset,
              status: "open",
              deadlinePresence: "dated",
              deadlineFrom: range.from,
              deadlineTo: range.to,
            }),
          ),
          collectPages((offset) =>
            getEvents({
              offset,
              startsAtFrom: range.from,
              startsAtTo: range.to,
            }),
          ),
        ]);
        setCalendarOccurrences(legacyOccurrences(tasks, events));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadOverview(upcomingDays),
        ...(visibleRange ? [loadCalendar(visibleRange)] : []),
      ]);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadCalendar, loadOverview, onError, upcomingDays, visibleRange]);

  useEffect(() => {
    void getUserPreferences()
      .then((preferences) => setUpcomingDays(preferences.upcoming_days))
      .catch((error) => onError((error as Error).message));
  }, [onError]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const entries = useMemo(
    () => occurrencesToEntries(calendarOccurrences),
    [calendarOccurrences],
  );
  const occupied = useMemo(
    () => new Set(entries.map((entry) => localDateKey(entry.startsAt))),
    [entries],
  );
  const entriesByDate = useMemo(() => {
    const result = new Map<string, CalendarEntry[]>();
    entries.forEach((entry) => {
      const key = localDateKey(entry.startsAt);
      result.set(key, [...(result.get(key) || []), entry]);
    });
    return result;
  }, [entries]);
  const selectedEntries = dayOpen ? entriesByDate.get(dayOpen) || [] : [];
  const overview = useMemo(
    () =>
      partitionOccurrenceEntries(
        overviewOccurrences,
        undatedTasks,
        new Date(),
        upcomingDays,
      ),
    [overviewOccurrences, undatedTasks, upcomingDays],
  );

  const datesSet = useCallback((info: DatesSetInfo) => {
    const range = {
      from: info.start.toISOString(),
      to: info.end.toISOString(),
    };
    setVisibleRange((current) =>
      current?.from === range.from && current.to === range.to ? current : range,
    );
  }, []);
  const openDate = (date: string) => {
    setDayHover(null);
    setDayOpen(date);
  };
  const changed = async () => {
    setEditor(null);
    await Promise.all([refresh(), Promise.resolve(onHistoryChanged())]);
  };
  const changeHorizon = async (value: number) => {
    setUpcomingDays(value);
    try {
      await updateUserPreferences({ upcoming_days: value });
      await loadOverview(value);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const calendar = (fullscreen: boolean) => (
    <FullCalendar
      plugins={[classicThemePlugin, dayGridPlugin, interactionPlugin]}
      locale={ruLocale}
      initialView="dayGridMonth"
      headerToolbar={{ left: "prev", center: "title", right: "next today" }}
      height={fullscreen ? "100%" : "auto"}
      fixedWeekCount={false}
      datesSet={datesSet}
      dayCellClass={(info) =>
        occupied.has(localDateKey(info.date)) ? "calendar-day-occupied" : ""
      }
      dayCellDidMount={(info) => {
        const date = localDateKey(info.date);
        info.el.tabIndex = 0;
        info.el.setAttribute("aria-label", `Открыть дела на ${date}`);
        info.el.onclick = () => openDate(date);
        info.el.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDate(date);
          }
        };
        info.el.onmouseenter = () => {
          const rect = info.el.getBoundingClientRect();
          if (info.el.classList.contains("calendar-day-occupied"))
            setDayHover({
              date,
              x: Math.min(rect.left, window.innerWidth - 292),
              y:
                rect.bottom + 230 < window.innerHeight
                  ? rect.bottom + 5
                  : Math.max(8, rect.top - 225),
            });
        };
        info.el.onmouseleave = () =>
          setDayHover((current) => (current?.date === date ? null : current));
      }}
      dayCellWillUnmount={(info) => {
        info.el.onclick = null;
        info.el.onkeydown = null;
        info.el.onmouseenter = null;
        info.el.onmouseleave = null;
      }}
    />
  );

  return (
    <>
      <aside
        className={`planner-sidebar ${open ? "open" : ""} gap-2.5 px-3.5 py-5`}
        aria-label="Календарь и ближайшие дела"
      >
        <div className="flex items-start justify-between gap-2 px-1">
          <div>
            <Badge variant="secondary" className="w-fit">
              Планы
            </Badge>
            <p className="mt-1.5 font-heading text-lg leading-none font-semibold">
              Календарь
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="sidebar-close"
            aria-label="Закрыть календарь"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>

        <div className="mini-calendar mt-1 rounded-lg bg-card p-1.5 ring-1 ring-border/70">
          {calendar(false)}
        </div>
        <Button variant="outline" className="w-full" onClick={() => setFullOpen(true)}>
          <Maximize2Icon aria-hidden="true" />
          Развернуть календарь
        </Button>

        <div className="mt-1 flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-1.5">
            <CalendarDaysIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <p className="text-sm font-semibold">Ближайшие дела</p>
          </div>
          <Label htmlFor="upcoming-horizon" className="sr-only">
            Период ближайших дел
          </Label>
          <NativeSelect
            id="upcoming-horizon"
            aria-label="Период ближайших дел"
            className="h-7 w-[84px] text-xs"
            value={upcomingDays}
            onChange={(event) => void changeHorizon(Number(event.target.value))}
          >
            {horizonOptions.map((value) => (
              <option value={value} key={value}>
                {value} дн.
              </option>
            ))}
          </NativeSelect>
        </div>

        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="upcoming-list px-0.5 pt-1 pb-4"
        >
          {loading && (
            <div className="grid gap-2 p-1">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-4/5" />
              <span className="sr-only">Загружаю…</span>
            </div>
          )}
          <div className="grid gap-4">
            <ScheduleSection
              title="Просрочено"
              entries={overview.overdue}
              onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
            />
            <ScheduleSection
              title="В ближайшие дни"
              entries={overview.upcoming}
              onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
            />
            {overview.undated.length > 0 && (
              <section className="grid gap-2">
                <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Без срока
                </h3>
                <div className="grid gap-1.5">
                  {overview.undated.map((task) => {
                    const entry: CalendarEntry = {
                      id: task.id,
                      resource: "task",
                      title: task.title,
                      startsAt: "",
                      durationMinutes: task.estimated_minutes,
                      task,
                    };
                    return (
                      <ScheduleItem
                        entry={entry}
                        key={task.id}
                        onOpen={(item) =>
                          setEditor({ resource: item.resource, entry: item })
                        }
                      />
                    );
                  })}
                </div>
              </section>
            )}
            {overviewCursor && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void loadMoreOverview()}
              >
                <ChevronsUpDownIcon aria-hidden="true" />
                Показать ещё
              </Button>
            )}
            {!loading &&
              !overview.overdue.length &&
              !overview.upcoming.length &&
              !overview.undated.length && (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  На выбранный период ничего не запланировано.
                </p>
              )}
          </div>
        </ScrollArea>
      </aside>

      {dayHover &&
        createPortal(
          <DayHoverPreview
            date={dayHover.date}
            entries={entriesByDate.get(dayHover.date) || []}
            x={dayHover.x}
            y={dayHover.y}
          />,
          document.body,
        )}

      <Dialog open={fullOpen} onOpenChange={setFullOpen}>
        <DialogContent
          closeLabel="Закрыть подробный календарь"
          className="h-[min(900px,calc(100dvh-2rem))] w-[min(1500px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:max-w-[min(1500px,calc(100vw-2rem))]"
        >
          <DialogHeader className="gap-1 pr-8">
            <Badge variant="secondary" className="w-fit">
              Планы
            </Badge>
            <DialogTitle className="text-xl">Подробный календарь</DialogTitle>
          </DialogHeader>
          <div className="calendar-full min-h-0">{calendar(true)}</div>
        </DialogContent>
      </Dialog>

      {dayOpen && (
        <DayDialog
          date={dayOpen}
          entries={selectedEntries}
          onClose={() => setDayOpen(null)}
          onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
          onCreate={(resource: Resource) => setEditor({ resource, date: dayOpen })}
        />
      )}
      {editor && (
        <CalendarItemDialog
          state={editor}
          onClose={() => setEditor(null)}
          onChanged={changed}
          onError={onError}
        />
      )}
    </>
  );
}
