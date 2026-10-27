import { getEvent, getOccurrences, getReminder, getTask } from "../api";
import type { CalendarEntry, Event, Resource, Task } from "../types";
import { occurrenceEntry, reminderEntry } from "./planner-data";

// A record mentioned somewhere outside the calendar, such as an agent reply.
export type EntryRef = {
  resource: Resource;
  id: string;
  occurrenceKey?: string | null;
  snapshot?: Record<string, unknown> | null;
};

const OCCURRENCE_WINDOW_MS = 2 * 86_400_000;

function taskEntry(task: Task): CalendarEntry {
  return {
    id: task.id,
    resource: "task",
    title: task.title,
    startsAt: task.deadline ?? "",
    durationMinutes: task.estimated_minutes,
    task,
  };
}

function eventEntry(event: Event): CalendarEntry {
  return {
    id: event.id,
    resource: "event",
    title: event.title,
    startsAt: event.starts_at,
    durationMinutes: event.duration_minutes,
    event,
  };
}

function scheduledAt(
  resource: "task" | "event",
  data: Record<string, unknown> | Task | Event,
): number {
  const value = resource === "task" ? (data as Task).deadline : (data as Event).starts_at;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

// Loads the current state of one occurrence, looking around the time the
// snapshot or the series last placed it.
async function loadOccurrence(
  ref: EntryRef & { resource: "task" | "event" },
  series: Task | Event,
): Promise<CalendarEntry> {
  const time = [ref.snapshot, series]
    .map((data) => (data ? scheduledAt(ref.resource, data) : Number.NaN))
    .find(Number.isFinite);
  if (time !== undefined) {
    const page = await getOccurrences({
      resource: ref.resource,
      seriesId: ref.id,
      from: new Date(time - OCCURRENCE_WINDOW_MS).toISOString(),
      to: new Date(time + OCCURRENCE_WINDOW_MS).toISOString(),
      limit: 100,
    });
    const match = page.items.find(
      (item) => item.occurrence_key === ref.occurrenceKey,
    );
    if (match) return occurrenceEntry(match);
  }
  return ref.resource === "task" ? taskEntry(series as Task) : eventEntry(series as Event);
}

export async function loadEntry(ref: EntryRef): Promise<CalendarEntry> {
  if (ref.resource === "reminder") return reminderEntry(await getReminder(ref.id));
  const series =
    ref.resource === "task" ? await getTask(ref.id) : await getEvent(ref.id);
  if (ref.occurrenceKey && series.recurrence)
    return loadOccurrence({ ...ref, resource: ref.resource }, series);
  return ref.resource === "task" ? taskEntry(series as Task) : eventEntry(series as Event);
}
