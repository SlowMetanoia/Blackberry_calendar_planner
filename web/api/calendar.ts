import type {
  CalendarOccurrence,
  CalendarOperation,
  CursorPage,
  Event,
  EventMutationResult,
  EventOccurrenceMutationResult,
  EventListOptions,
  OccurrenceListOptions,
  Page,
  Task,
  TaskListOptions,
} from "../types";
import { request } from "./client";

function query(
  path: string,
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export const getCalendarHistory = (limit = 100, offset = 0) =>
  request<Page<CalendarOperation>>(
    `/calendar/history?limit=${limit}&offset=${offset}`,
  );
export const undoOperation = (id: string) =>
  request<CalendarOperation>(`/calendar/history/${id}/undo`, {
    method: "POST",
  });

export const getTasks = (options: TaskListOptions = {}) =>
  request<Page<Task>>(
    query("/tasks", {
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      deadline_from: options.deadlineFrom,
      deadline_to: options.deadlineTo,
      status: options.status,
      deadline_presence: options.deadlinePresence,
    }),
  );
export const getEvents = (options: EventListOptions = {}) =>
  request<Page<Event>>(
    query("/events", {
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      starts_at_from: options.startsAtFrom,
      starts_at_to: options.startsAtTo,
    }),
  );

export const createTask = (data: Omit<Task, "id" | "owner_id">) =>
  request<Task>("/tasks", { method: "POST", body: JSON.stringify(data) });
export const updateTask = (
  id: string,
  data: Partial<Omit<Task, "id" | "owner_id">>,
  effectiveFrom?: string,
) =>
  request<Task>(
    query(`/tasks/${id}`, {
      effective_from_occurrence_key: effectiveFrom,
    }),
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
export const deleteTask = (id: string) =>
  request<void>(`/tasks/${id}`, { method: "DELETE" });

export const createEvent = (data: Omit<Event, "id" | "owner_id">) =>
  request<EventMutationResult>("/events", { method: "POST", body: JSON.stringify(data) });
export const updateEvent = (
  id: string,
  data: Partial<Omit<Event, "id" | "owner_id">>,
  effectiveFrom?: string,
) =>
  request<EventMutationResult>(
    query(`/events/${id}`, {
      effective_from_occurrence_key: effectiveFrom,
    }),
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
export const deleteEvent = (id: string) =>
  request<void>(`/events/${id}`, { method: "DELETE" });

export const getOccurrences = (options: OccurrenceListOptions = {}) =>
  request<CursorPage<CalendarOccurrence>>(
    query("/calendar/occurrences", {
      resource: options.resource,
      series_id: options.seriesId,
      from: options.from,
      to: options.to,
      status: options.status,
      limit: options.limit ?? 100,
      cursor: options.cursor,
    }),
  );
export const updateTaskOccurrence = (
  id: string,
  key: string,
  data: Partial<Omit<Task, "id" | "owner_id">>,
) =>
  request<CalendarOccurrence>(
    `/tasks/${id}/occurrences/${encodeURIComponent(key)}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
export const deleteTaskOccurrence = (id: string, key: string) =>
  request<void>(`/tasks/${id}/occurrences/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
export const updateEventOccurrence = (
  id: string,
  key: string,
  data: Partial<Omit<Event, "id" | "owner_id">>,
) =>
  request<EventOccurrenceMutationResult>(
    `/events/${id}/occurrences/${encodeURIComponent(key)}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
export const deleteEventOccurrence = (id: string, key: string) =>
  request<void>(`/events/${id}/occurrences/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
