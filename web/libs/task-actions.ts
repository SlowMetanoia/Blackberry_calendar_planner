import {
  deleteTask,
  deleteTaskOccurrence,
  updateTask,
  updateTaskOccurrence,
} from "../api";
import type { CalendarEntry } from "../types";

export type TaskAction = "complete" | "cancel";

export const taskActionNotices: Record<TaskAction, string> = {
  complete: "завершена",
  cancel: "отменена",
};

// Recurring tasks change only the chosen occurrence; the series stays intact.
export async function applyTaskAction(
  entry: CalendarEntry,
  action: TaskAction,
): Promise<void> {
  const occurrence =
    entry.recurring && entry.occurrenceKey ? entry.occurrenceKey : null;
  if (action === "complete") {
    if (occurrence)
      await updateTaskOccurrence(entry.id, occurrence, { status: "completed" });
    else await updateTask(entry.id, { status: "completed" });
    return;
  }
  if (occurrence) await deleteTaskOccurrence(entry.id, occurrence);
  else await deleteTask(entry.id);
}
