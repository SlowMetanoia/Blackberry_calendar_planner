import { localDateKey } from "../../libs/format";
import type { CalendarEntry } from "../../types";
import { ScheduleList } from "./ScheduleList";

function dayMonth(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(value);
}

function dayHeading(date: string): { lead: string; rest: string } {
  const value = new Date(`${date}T12:00:00`),
    today = localDateKey(new Date()),
    tomorrow = localDateKey(new Date(Date.now() + 86_400_000));
  if (date === today) return { lead: "Сегодня", rest: dayMonth(value) };
  if (date === tomorrow) return { lead: "Завтра", rest: dayMonth(value) };
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short" })
    .format(value)
    .replace(".", "");
  return {
    lead: weekday.charAt(0).toUpperCase() + weekday.slice(1),
    rest: dayMonth(value),
  };
}

export function ScheduleSection({
  title,
  entries,
  onOpen,
  overdue = false,
  taskActions = false,
}: {
  title?: string;
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
  overdue?: boolean;
  taskActions?: boolean;
}) {
  if (!entries.length) return null;
  const groups = new Map<string, CalendarEntry[]>();
  entries.forEach((entry) => {
    const key = localDateKey(entry.startsAt);
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  return (
    <section className="grid gap-1.5">
      {title && (
        <h3 className="flex items-baseline gap-1.5 px-2 text-xs font-semibold">
          <span className={overdue ? "text-destructive" : "text-foreground"}>
            {title}
          </span>
          <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
            {entries.length}
          </span>
        </h3>
      )}
      <div className="grid gap-2">
        {[...groups.entries()].map(([date, items]) => {
          const heading = dayHeading(date);
          return (
            <div className="grid" key={date}>
              <h4 className="sticky top-0 z-10 flex items-baseline gap-1.5 bg-background px-2 py-1 text-[11px] leading-none">
                <span className="font-semibold text-foreground">
                  {heading.lead}
                </span>
                <span className="text-muted-foreground">{heading.rest}</span>
              </h4>
              <ScheduleList
                entries={items}
                onOpen={onOpen}
                taskActions={taskActions}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
