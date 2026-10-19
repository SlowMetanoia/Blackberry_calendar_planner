import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
        className={`planner-sidebar ${open ? "open" : ""}`}
        aria-label="Календарь и ближайшие дела"
      >
        <div className="sidebar-head">
          <div>
            <div className="eyebrow">Планы</div>
            <b>Календарь</b>
          </div>
          <button
            className="sidebar-close"
            aria-label="Закрыть календарь"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="mini-calendar">{calendar(false)}</div>
        <button className="calendar-expand" onClick={() => setFullOpen(true)}>
          Развернуть календарь
        </button>
        <div className="upcoming-head">
          <b>Ближайшие дела</b>
          <label>
            <span className="sr-only">Период ближайших дел</span>
            <select
              aria-label="Период ближайших дел"
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
            </select>
          </label>
        </div>
        <div className="upcoming-list">
          {loading && <p className="sidebar-state">Загружаю…</p>}
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
            <section className="schedule-section">
              <h3>Без срока</h3>
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
            </section>
          )}
          {overviewCursor && (
            <button
              className="calendar-expand"
              onClick={() => void loadMoreOverview()}
            >
              Показать ещё
            </button>
          )}
          {!loading &&
            !overview.overdue.length &&
            !overview.upcoming.length &&
            !overview.undated.length && (
              <p className="sidebar-state">
                На выбранный период ничего не запланировано.
              </p>
            )}
        </div>
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
      {fullOpen && (
        <div
          className="calendar-modal-scrim"
          role="presentation"
          onMouseDown={() => setFullOpen(false)}
        >
          <section
            className="calendar-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Подробный календарь"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="calendar-modal-head">
              <div>
                <div className="eyebrow">Планы</div>
                <h2>Календарь</h2>
              </div>
              <button
                aria-label="Закрыть подробный календарь"
                onClick={() => setFullOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="calendar-full">{calendar(true)}</div>
          </section>
        </div>
      )}
      {dayOpen && (
        <DayDialog
          date={dayOpen}
          entries={selectedEntries}
          onClose={() => setDayOpen(null)}
          onOpen={(entry) => setEditor({ resource: entry.resource, entry })}
          onCreate={(resource) => setEditor({ resource, date: dayOpen })}
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
