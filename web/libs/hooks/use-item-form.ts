import { useState } from "react";
import {
  createEvent,
  createTask,
  deleteEvent,
  deleteEventOccurrence,
  deleteTask,
  deleteTaskOccurrence,
  updateEvent,
  updateEventOccurrence,
  updateTask,
  updateTaskOccurrence,
} from "../../api";
import { localDateKey } from "../format";
import type { CollisionReport, EditorState, Resource, TaskStatus } from "../../types";
import {
  fromLocalInput,
  initialRecurrenceDraft,
  recurrenceFromDraft,
  toLocalInput,
  type RecurrenceDraft,
} from "../item-form";

export function useCalendarItemForm({
  state,
  onChanged,
  onError,
  onCollisions,
}: {
  state: EditorState;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onCollisions?: (report: CollisionReport) => void;
}) {
  const source = state.entry?.task || state.entry?.event;
  const existing = Boolean(state.entry);
  const [resource, setResource] = useState<Resource>(state.resource);
  const [title, setTitle] = useState(source?.title || "");
  const [description, setDescription] = useState(source?.description || "");
  const [when, setWhen] = useState(() =>
    state.entry
      ? toLocalInput(state.entry.startsAt)
      : `${state.date || localDateKey(new Date())}T${state.time || "09:00"}`,
  );
  const [duration, setDuration] = useState(
    String(state.entry?.durationMinutes || ""),
  );
  const [location, setLocation] = useState(state.entry?.event?.location || "");
  const [status, setStatus] = useState<TaskStatus>(
    state.entry?.task?.status || "open",
  );
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState<"occurrence" | "series">(
    state.entry?.recurring ? "occurrence" : "series",
  );
  const [draft, setDraft] = useState<RecurrenceDraft>(() =>
    initialRecurrenceDraft(
      source?.recurrence,
      state.entry?.startsAt,
      source?.recurrence_timezone,
    ),
  );

  function updateDraft(patch: Partial<RecurrenceDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    setSaving(true);
    try {
      const minutes = duration ? Number(duration) : null,
        key = state.entry?.occurrenceKey,
        instance = Boolean(
          existing && key && scope === "occurrence" && state.entry?.recurring,
        ),
        boundary = state.entry?.recurring ? key : undefined,
        includeRecurrence =
          !instance &&
          (!existing ||
            source?.recurrence !== undefined ||
            draft.repeat !== "none"),
        recurrenceFields = includeRecurrence
          ? {
              recurrence: recurrenceFromDraft(draft),
              recurrence_timezone:
                draft.repeat === "none" ? null : draft.timezone,
            }
          : {};
      if (resource === "event") {
        const starts_at = fromLocalInput(when);
        if (!starts_at) throw new Error("Укажите дату и время события");
        const data = {
          title,
          description: description || null,
          starts_at,
          duration_minutes: minutes,
          location: location || null,
          ...recurrenceFields,
        };
        const result = instance
          ? await updateEventOccurrence(state.entry!.id, key!, data)
          : existing
            ? await updateEvent(state.entry!.id, data, boundary)
            : await createEvent(data);
        if (result.collision_report?.groups.length) onCollisions?.(result.collision_report);
      } else {
        const deadline = fromLocalInput(when);
        if (draft.repeat !== "none" && !deadline)
          throw new Error("Для повтора нужен первый дедлайн");
        const data = {
          title,
          description: description || null,
          deadline,
          estimated_minutes: minutes,
          status,
          ...recurrenceFields,
        };
        if (instance) await updateTaskOccurrence(state.entry!.id, key!, data);
        else if (existing) {
          if (boundary) await updateTask(state.entry!.id, data, boundary);
          else await updateTask(state.entry!.id, data);
        } else await createTask(data);
      }
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!state.entry || !window.confirm(`Удалить «${state.entry.title}»?`))
      return;
    setSaving(true);
    try {
      const key = state.entry.occurrenceKey;
      if (resource === "event") {
        if (key && scope === "occurrence")
          await deleteEventOccurrence(state.entry.id, key);
        else await deleteEvent(state.entry.id);
      } else {
        if (key && scope === "occurrence")
          await deleteTaskOccurrence(state.entry.id, key);
        else await deleteTask(state.entry.id);
      }
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return {
    existing,
    recurring: Boolean(state.entry?.recurring),
    resource,
    setResource,
    title,
    setTitle,
    description,
    setDescription,
    when,
    setWhen,
    duration,
    setDuration,
    location,
    setLocation,
    status,
    setStatus,
    saving,
    scope,
    setScope,
    draft,
    updateDraft,
    save,
    remove,
  };
}

export type CalendarItemFormController = ReturnType<typeof useCalendarItemForm>;
