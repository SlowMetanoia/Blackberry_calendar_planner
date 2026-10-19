import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronsUpDownIcon,
  Maximize2Icon,
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
import { ScheduleList, ScheduleSection } from "./ScheduleSection";

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

export function CalendarView({
  revision,
  onHistoryChanged,
  onError,
}: {
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
  const undatedEntries = useMemo<CalendarEntry[]>(
    () =>
      overview.undated.map((task) => ({
        id: task.id,
        resource: "task",
        title: task.title,
        startsAt: "",
        durationMinutes: task.estimated_minutes,
        task,
      })),
    [overview.undated],
  );
  const overviewTotal =
    overview.overdue.length + overview.upcoming.length + undatedEntries.length;

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
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-4 py-5 sm:px-7">
        <div className="mx-auto grid w-full max-w-6xl items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
          <section className="grid gap-2" aria-label="Календарь месяца">
            <div className="planner-calendar rounded-xl bg-card p-3 ring-1 ring-border/70">
              {calendar(false)}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit justify-self-end text-muted-foreground hover:text-foreground"
              onClick={() => setFullOpen(true)}
            >
              <Maximize2Icon aria-hidden="true" />
              Развернуть календарь
            </Button>
          </section>

          <aside
            className="grid content-start overflow-hidden rounded-xl bg-card ring-1 ring-border/70"
            aria-label="Ближайшие дела"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="truncate text-sm font-semibold">
                  Ближайшие дела
                </h2>
                {overviewTotal > 0 && !loading && (
                  <span className="text-[11px] text-muted-foreground">
                    {overviewTotal}
                  </span>
                )}
              </div>
              <Label htmlFor="upcoming-horizon" className="sr-only">
                Период ближайших дел
              </Label>
              <span className="w-[84px] shrink-0">
                <NativeSelect
                  id="upcoming-horizon"
                  aria-label="Период ближайших дел"
                  className="h-7 text-xs"
                  value={upcomingDays}
                  onChange={(event) =>
                    void changeHorizon(Number(event.target.value))
                  }
                >
                  {horizonOptions.map((value) => (
                    <option value={value} key={value}>
                      {value} дн.
                    </option>
                  ))}
                </NativeSelect>
              </span>
            </header>

            <div className="grid content-start gap-5 px-4 py-4">
              {loading && (
                <div className="grid gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-4/5" />
                  <span className="sr-only">Загружаю…</span>
                </div>
              )}
              {!loading && !overviewTotal && (
                <p className="px-2 py-6 text-sm text-muted-foreground">
                  На этот период ничего не запланировано.
                </p>
              )}
              <ScheduleSection
                title="Просрочено"
                overdue
                entries={overview.overdue}
                onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
              />
              <ScheduleSection
                title="В ближайшие дни"
                entries={overview.upcoming}
                onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
              />
              {undatedEntries.length > 0 && (
                <section className="grid gap-1.5">
                  <h3 className="flex items-baseline gap-1.5 px-2 text-xs font-semibold">
                    <span>Без срока</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {undatedEntries.length}
                    </span>
                  </h3>
                  <ScheduleList
                    entries={undatedEntries}
                    onOpen={(entry) =>
                      setEditor({ resource: entry.resource, entry })
                    }
                  />
                </section>
              )}
              {overviewCursor && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit justify-self-start"
                  onClick={() => void loadMoreOverview()}
                >
                  <ChevronsUpDownIcon aria-hidden="true" />
                  Показать ещё
                </Button>
              )}
            </div>
          </aside>
        </div>
      </ScrollArea>

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
          <DialogHeader className="pr-8">
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
