type ZonedParts = {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
};

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parts(
  value: Date,
  timeZone: string,
  month: "2-digit" | "long" = "2-digit",
): ZonedParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      year: "numeric",
      month,
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return values as ZonedParts;
}

function sameLocalDay(left: Date, right: Date, timeZone: string): boolean {
  const a = parts(left, timeZone);
  const b = parts(right, timeZone);
  return a.day === b.day && a.month === b.month && a.year === b.year;
}

export function formatMessageTimestamp(
  value: string,
  now: Date = new Date(),
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone);
  const time = `${valueParts.hour}:${valueParts.minute}`;
  return sameLocalDay(date, now, timeZone)
    ? time
    : `${valueParts.day}.${valueParts.month}.${valueParts.year}, ${time}`;
}

export function formatSessionTimestamp(
  value: string,
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone);
  return `${valueParts.day}.${valueParts.month}.${valueParts.year}, ${valueParts.hour}:${valueParts.minute}`;
}

export function historyDateKey(
  value: string | Date,
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}`;
}

export function localDateKey(
  value: string | Date,
  timeZone: string = browserTimeZone(),
): string {
  return historyDateKey(value, timeZone);
}

export function formatHistoryDate(
  value: string,
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone, "long");
  return `${Number(valueParts.day)} ${valueParts.month} ${valueParts.year}`;
}

export function formatHistoryTime(
  value: string,
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone);
  return `${valueParts.hour}:${valueParts.minute}`;
}

export function formatDateTime(
  value: string,
  timeZone: string = browserTimeZone(),
): string {
  const date = validDate(value);
  if (!date) return "";
  const valueParts = parts(date, timeZone, "long");
  return `${Number(valueParts.day)} ${valueParts.month} ${valueParts.year}, ${valueParts.hour}:${valueParts.minute}`;
}

export function formatSchedule(
  value: string,
  durationMinutes: number | null,
  timeZone: string = browserTimeZone(),
): string {
  const start = validDate(value);
  if (!start) return "";
  const formattedStart = formatDateTime(value, timeZone);
  if (!durationMinutes || durationMinutes < 1) return formattedStart;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const startParts = parts(start, timeZone);
  const endParts = parts(end, timeZone);
  const endTime = `${endParts.hour}:${endParts.minute}`;

  if (sameLocalDay(start, end, timeZone)) return `${formattedStart}–${endTime}`;

  return `${formattedStart}–${formatDateTime(end.toISOString(), timeZone)}`;
}

function plural(value: number, one: string, few: string, many: string): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 1) return "";

  const total = Math.round(value);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const result: string[] = [];

  if (hours) result.push(`${hours} ${plural(hours, "час", "часа", "часов")}`);
  if (minutes)
    result.push(`${minutes} ${plural(minutes, "минута", "минуты", "минут")}`);

  return result.join(" ");
}
