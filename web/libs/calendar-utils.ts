import { localDateKey } from "./format";
import type { AnchorRect } from "../types";

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

const PREVIEW_GAP = 8;
const PREVIEW_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// Puts the day preview next to the hovered day so it never covers it: to the
// right when there is room, otherwise to the left, and only as a last resort
// below or above.
export function placeDayPreview(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = viewport.width - PREVIEW_MARGIN - size.width;
  const maxTop = Math.max(
    PREVIEW_MARGIN,
    viewport.height - PREVIEW_MARGIN - size.height,
  );
  const right = anchor.right + PREVIEW_GAP;
  const left = anchor.left - PREVIEW_GAP - size.width;
  if (right <= maxLeft || left >= PREVIEW_MARGIN)
    return {
      left: right <= maxLeft ? right : left,
      top: clamp(anchor.top, PREVIEW_MARGIN, maxTop),
    };
  const below = anchor.bottom + PREVIEW_GAP;
  return {
    left: clamp(anchor.left, PREVIEW_MARGIN, Math.max(PREVIEW_MARGIN, maxLeft)),
    top:
      below + size.height <= viewport.height - PREVIEW_MARGIN
        ? below
        : Math.max(PREVIEW_MARGIN, anchor.top - PREVIEW_GAP - size.height),
  };
}
