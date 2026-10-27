import { useId, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { shiftMonth, weekdays } from "../../libs/calendar-utils";
import { localDateKey } from "../../libs/format";
import { useMonthMarks } from "../../libs/hooks/use-month-marks";
import { Button } from "../ui/button";

const monthFormat = new Intl.DateTimeFormat("ru-RU", {
  month: "long",
  year: "numeric",
});
const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});

const OPEN_STORAGE_KEY = "planner-mini-calendar-open";

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function monthTitle(month: Date): string {
  const label = monthFormat.format(month).replace(/\s*г\.$/, "");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function MiniCalendar({
  onOpenDate,
}: {
  onOpenDate: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1, 12);
  });
  const [open, setOpen] = useState(storedOpen);
  const gridId = useId();
  const { days, marked } = useMonthMarks(month);
  const todayKey = localDateKey(new Date());

  function toggle() {
    setOpen((current) => {
      try {
        localStorage.setItem(OPEN_STORAGE_KEY, String(!current));
      } catch {
        // The calendar still toggles when storage is unavailable.
      }
      return !current;
    });
  }

  return (
    <section
      aria-label="Мини-календарь"
      className={`grid gap-1.5 px-3 ${open ? "pb-3" : "pb-1"}`}
    >
      <header className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={gridId}
          aria-label={`${open ? "Свернуть" : "Развернуть"} мини-календарь`}
          onClick={toggle}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left outline-none transition-colors hover:bg-sidebar-accent/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 md:min-h-7"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 shrink-0 text-sidebar-foreground/45 transition-transform duration-200 ${
              open ? "" : "-rotate-90"
            }`}
          />
          <span className="truncate text-[12.5px] font-semibold text-sidebar-foreground/85">
            {monthTitle(month)}
          </span>
        </button>
        {open && (
          <span className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-sidebar-foreground/60 hover:bg-sidebar-accent/10 hover:text-sidebar-foreground max-md:size-8"
              aria-label="Предыдущий месяц"
              onClick={() => setMonth((current) => shiftMonth(current, -1))}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-sidebar-foreground/60 hover:bg-sidebar-accent/10 hover:text-sidebar-foreground max-md:size-8"
              aria-label="Следующий месяц"
              onClick={() => setMonth((current) => shiftMonth(current, 1))}
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </span>
        )}
      </header>
      {open && (
        <div id={gridId} className="grid grid-cols-7 text-center">
          {weekdays.map((weekday) => (
            <span
              key={weekday}
              aria-hidden="true"
              className="pb-0.5 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/35"
            >
              {weekday}
            </span>
          ))}
          {days.map(({ date, key }) => {
            const inMonth = date.getMonth() === month.getMonth();
            const isToday = key === todayKey;
            const busy = marked.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-label={`${dayFormat.format(date)}${busy ? ", есть дела" : ""}`}
                aria-current={isToday ? "date" : undefined}
                onClick={() => onOpenDate(key)}
                className={`relative mx-auto grid size-8 place-items-center rounded-md text-[12px] tabular-nums transition-colors outline-none hover:bg-sidebar-accent/15 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 md:size-7 ${
                  isToday
                    ? "bg-sidebar-primary font-semibold text-sidebar-primary-foreground hover:bg-sidebar-primary/85"
                    : inMonth
                      ? "text-sidebar-foreground/80"
                      : "text-sidebar-foreground/30"
                }`}
              >
                {date.getDate()}
                {busy && (
                  <span
                    aria-hidden="true"
                    className={`absolute bottom-0.5 size-1 rounded-full ${
                      isToday ? "bg-sidebar-primary-foreground" : "bg-sidebar-primary"
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
