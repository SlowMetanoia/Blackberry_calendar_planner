import type { RecurrenceRule, Weekday } from "../types";

export type RepeatFrequency = "none" | RecurrenceRule["frequency"];
export type MonthlyKind = NonNullable<RecurrenceRule["monthly"]>["kind"];
export type EndKind = RecurrenceRule["end"]["kind"];

export const weekdayLabels: Record<Weekday, string> = {
  MO: "Пн",
  TU: "Вт",
  WE: "Ср",
  TH: "Чт",
  FR: "Пт",
  SA: "Сб",
  SU: "Вс",
};

export type RecurrenceDraft = {
  repeat: RepeatFrequency;
  interval: number;
  weekdays: Weekday[];
  monthlyKind: MonthlyKind;
  monthDay: number;
  ordinal: number;
  monthWeekday: Weekday;
  endKind: EndKind;
  until: string;
  count: number;
  timezone: string;
};

export function defaultRecurrenceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function initialRecurrenceDraft(
  rule: RecurrenceRule | null | undefined,
  firstOccurrence: string | null | undefined,
  timezone: string | null | undefined,
): RecurrenceDraft {
  return {
    repeat: rule?.frequency || "none",
    interval: rule?.interval || 1,
    weekdays: rule?.weekdays || [],
    monthlyKind: rule?.monthly?.kind || "day_of_month",
    monthDay:
      rule?.monthly?.day || new Date(firstOccurrence || Date.now()).getDate(),
    ordinal: rule?.monthly?.ordinal || 1,
    monthWeekday: rule?.monthly?.weekday || "MO",
    endKind: rule?.end.kind || "never",
    until: rule?.end.until || "",
    count: rule?.end.count || 10,
    timezone: timezone || defaultRecurrenceTimezone(),
  };
}

export function recurrenceFromDraft(
  draft: RecurrenceDraft,
): RecurrenceRule | null {
  if (draft.repeat === "none") return null;
  const end =
    draft.endKind === "until"
      ? { kind: draft.endKind, until: draft.until }
      : draft.endKind === "count"
        ? { kind: draft.endKind, count: draft.count }
        : { kind: "never" as const };
  return {
    frequency: draft.repeat,
    interval: draft.interval,
    weekdays:
      draft.repeat === "weekly"
        ? draft.weekdays.length
          ? draft.weekdays
          : undefined
        : undefined,
    monthly:
      draft.repeat === "monthly"
        ? draft.monthlyKind === "day_of_month"
          ? { kind: draft.monthlyKind, day: draft.monthDay }
          : draft.monthlyKind === "nth_weekday"
            ? {
              kind: draft.monthlyKind,
              ordinal: draft.ordinal,
              weekday: draft.monthWeekday,
            }
            : { kind: "last_day" }
        : undefined,
    end,
  } as RecurrenceRule;
}

export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
