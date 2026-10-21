import { createStore } from "zustand/vanilla";
import {
  getEvents,
  getReminders,
  getOccurrences,
  getTasks,
  getUserPreferences,
  updateUserPreferences,
} from "../../api";
import { collectPages } from "../pagination";
import type { CalendarOccurrence, Event, Reminder, Task } from "../../types";
import type { SessionStore } from "./session-store";

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

type Range = { from: string; to: string };

const initialData = () => ({
  upcomingDays: 7,
  undatedTasks: [] as Task[],
  overviewOccurrences: [] as CalendarOccurrence[],
  overviewCursor: null as string | null,
  calendarOccurrences: [] as CalendarOccurrence[],
  visibleRange: null as Range | null,
  loading: true,
  preferencesLoaded: false,
  reminders: [] as Reminder[],
});

export type CalendarData = ReturnType<typeof initialData>;

export type CalendarState = CalendarData & {
  loadOverview: (days: number) => Promise<void>;
  loadCalendar: (range: Range) => Promise<void>;
  refresh: () => Promise<void>;
  loadMoreOverview: () => Promise<void>;
  changeHorizon: (value: number) => Promise<void>;
  updateVisibleRange: (range: Range) => void;
  reset: () => void;
};

export function createCalendarStore(session: SessionStore) {
  return createStore<CalendarState>()((set, get) => {
    const loadOverview = async (days: number) => {
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
        set({
          overviewOccurrences: occurrences.items,
          overviewCursor: occurrences.next_cursor,
        });
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
        set({
          overviewOccurrences: legacyOccurrences(dated, events),
          overviewCursor: null,
        });
      }
      set({ undatedTasks: undated });
    };

    const loadCalendar = async (range: Range) => {
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
        set({ calendarOccurrences: result });
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
        set({ calendarOccurrences: legacyOccurrences(tasks, events) });
      }
    };

    return {
      ...initialData(),

      loadOverview,
      loadCalendar,

      refresh: async () => {
        set({ loading: true });
        try {
          if (!get().preferencesLoaded) {
            try {
              const preferences = await getUserPreferences();
              set({
                upcomingDays: preferences.upcoming_days,
                preferencesLoaded: true,
              });
            } catch (error) {
              session.getState().setError((error as Error).message);
            }
          }
          const { upcomingDays, visibleRange } = get();
          await Promise.all([
            collectPages((offset) => getReminders({offset})).then((reminders) => set({reminders})),
            loadOverview(upcomingDays),
            ...(visibleRange ? [loadCalendar(visibleRange)] : []),
          ]);
        } catch (error) {
          session.getState().setError((error as Error).message);
        } finally {
          set({ loading: false });
        }
      },

      loadMoreOverview: async () => {
        const { overviewCursor, upcomingDays } = get();
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
          set((state) => ({
            overviewOccurrences: [
              ...state.overviewOccurrences,
              ...page.items,
            ],
            overviewCursor: page.next_cursor,
          }));
        } catch (error) {
          session.getState().setError((error as Error).message);
        }
      },

      changeHorizon: async (value) => {
        set({ upcomingDays: value });
        try {
          await updateUserPreferences({ upcoming_days: value });
          await loadOverview(value);
        } catch (error) {
          session.getState().setError((error as Error).message);
        }
      },

      updateVisibleRange: (range) => {
        const current = get().visibleRange;
        if (current?.from === range.from && current.to === range.to) return;
        set({ visibleRange: range });
        void loadCalendar(range).catch((error) =>
          session.getState().setError((error as Error).message),
        );
      },

      reset: () => set(initialData()),
    };
  });
}
