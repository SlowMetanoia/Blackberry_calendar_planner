import type { Resource, ResourceMetadataItem } from "../types";
import {
  browserTimeZone,
  formatDateTime,
  formatDuration,
  formatSchedule,
} from "./format";

export const resourceHeadings: Record<string, string> = {
  task: "Задача",
  event: "Событие",
  reminder: "Напоминание",
};
export const operationWords: Record<string, string> = {
  create: "Создано",
  update: "Изменено",
  delete: "Удалено",
};
export const undoWords: Record<string, string> = {
  create: "создание",
  update: "изменение",
  delete: "удаление",
};
export const taskStatusLabels: Record<string, string> = {
  open: "Открыта",
  completed: "Выполнена",
  active: "Активно",
  fired: "Сработало",
  cancelled: "Отменено",
};

export function stringField(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : null;
}
export function numberField(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function recurrenceLabel(data: Record<string, unknown>): string | null {
  const rule = data.recurrence;
  if (!rule || typeof rule !== "object") return null;
  const value = rule as { frequency?: string; interval?: number };
  const names: Record<string, string> = {
    daily: "дн.",
    weekly: "нед.",
    monthly: "мес.",
    yearly: "г.",
  };
  return value.frequency
    ? `каждые ${value.interval || 1} ${names[value.frequency] || value.frequency}`
    : null;
}

export function resourceMetadata(
  resource: string,
  data: Record<string, unknown>,
  timeZone = browserTimeZone(),
): ResourceMetadataItem[] {
  const items: ResourceMetadataItem[] = [],
    duration = numberField(
      data,
      resource === "event" ? "duration_minutes" : "estimated_minutes",
    ),
    dates = Array.isArray(data.occurrence_dates)
      ? data.occurrence_dates.filter(
          (value): value is string => typeof value === "string",
        )
      : [];

  if (dates.length) {
    items.push({
      label: "Даты",
      value: dates.map((value) => formatDateTime(value, timeZone)).join("; "),
    });
    const total = numberField(data, "occurrence_total");
    if (total && total > dates.length)
      items.push({ value: `Ещё ${total - dates.length}` });
  } else if (resource === "event") {
    const start = stringField(data, "starts_at");
    if (start) items.push({ value: formatSchedule(start, duration, timeZone) });
  } else if (resource === "reminder") {
    const when = stringField(data, "remind_at");
    if (when) items.push({label:"Напомнить",value:formatDateTime(when,timeZone)});
  } else {
    const deadline = stringField(data, "deadline");
    if (deadline)
      items.push({ label: "Срок", value: formatDateTime(deadline, timeZone) });
  }

  const repeat = recurrenceLabel(data);
  if (repeat) items.push({ label: "Повтор", value: repeat });
  if (duration)
    items.push({
      label: resource === "event" ? "Длительность" : "Оценка",
      value: formatDuration(duration),
    });

  if (resource === "event") {
    const location = stringField(data, "location");
    if (location) items.push({ label: "Место", value: location });
  } else {
    const status = stringField(data, "status");
    if (status)
      items.push({
        label: "Статус",
        value: taskStatusLabels[status] || status,
      });
  }
  const description = stringField(data, "description");
  if (description) items.push({ label: "Описание", value: description });

  return items;
}

export function operationSchedule(
  resource: Resource,
  data: Record<string, unknown>,
): string {
  const value = stringField(
    data,
    resource === "event" ? "starts_at" : resource === "reminder" ? "remind_at" : "deadline",
  );
  if (!value) return "";
  return `${resource === "event" ? "запланировано на" : resource === "reminder" ? "напомнить в" : "запланировано к"} ${formatDateTime(value)}`;
}
