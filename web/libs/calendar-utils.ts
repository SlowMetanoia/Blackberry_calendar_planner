import { localDateKey } from "./format";

export type CalendarMode = "month" | "week";
export type CalendarDay = { date: Date; key: string };

export const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7));
}

export function withYearMonth(date: Date, year: number, month: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(date.getDate(), lastDay), 12);
}

export function shiftMonth(date: Date, amount: number): Date {
  return withYearMonth(date, date.getFullYear(), date.getMonth() + amount);
}

export function buildMonthDays(month: Date): CalendarDay[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const days: CalendarDay[] = [];

  for (let date = start; date <= end; date = addDays(date, 1)) {
    days.push({ date, key: localDateKey(date) });
  }
  return days;
}

export function buildWeekDays(anchor: Date): CalendarDay[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return { date, key: localDateKey(date) };
  });
}
