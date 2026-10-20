import { useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { DatesSetInfo } from "@fullcalendar/react";
import FullCalendar, { type CalendarRef } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import ruLocale from "@fullcalendar/react/locales/ru";
import "temporal-polyfill/global";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import { localDateKey } from "../../libs/format";
import type { DayHover } from "../../types";
import { Button } from "../ui/button";

type DayCell = { el: HTMLElement; date: Date };

const titleFormat = new Intl.DateTimeFormat("ru-RU", {
  month: "long",
  year: "numeric",
});

export function MonthCalendar({
  fullscreen = false,
  occupied,
  onRangeChange,
  onOpenDate,
  onDayHover,
}: {
  fullscreen?: boolean;
  occupied: Set<string>;
  onRangeChange: (range: { from: string; to: string }) => void;
  onOpenDate: (date: string) => void;
  onDayHover: (hover: DayHover | null, date: string | null) => void;
}) {
  const calendarRef = useRef<CalendarRef>(null);
  const [title, setTitle] = useState(() => titleFormat.format(new Date()));

  const datesSet = (info: DatesSetInfo) => {
    setTitle(info.view.title);
    onRangeChange({
      from: info.start.toISOString(),
      to: info.end.toISOString(),
    });
  };

  const showPreview = (cell: DayCell, date: string) => {
    const rect = cell.el.getBoundingClientRect();
    onDayHover(
      {
        date,
        x: Math.min(rect.left, window.innerWidth - 292),
        y:
          rect.bottom + 230 < window.innerHeight
            ? rect.bottom + 5
            : Math.max(8, rect.top - 225),
      },
      date,
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Предыдущий месяц"
          onClick={() => calendarRef.current?.getApi().prev()}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Следующий месяц"
          onClick={() => calendarRef.current?.getApi().next()}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
        <h2
          className="min-w-0 flex-1 truncate text-center font-heading text-base font-semibold tracking-tight first-letter:uppercase sm:text-lg"
          aria-live="polite"
        >
          {title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          onClick={() => calendarRef.current?.getApi().today()}
        >
          Сегодня
        </Button>
      </div>

      <FullCalendar
        ref={calendarRef}
        plugins={[classicThemePlugin, dayGridPlugin, interactionPlugin]}
        locale={ruLocale}
        initialView="dayGridMonth"
        headerToolbar={false}
        height={fullscreen ? "100%" : "auto"}
        fixedWeekCount={false}
        datesSet={datesSet}
        dayCellClass={(info) =>
          occupied.has(localDateKey(info.date)) ? "calendar-day-occupied" : ""
        }
        dayCellDidMount={(info) => {
          const date = localDateKey(info.date);
          info.el.tabIndex = 0;
          info.el.setAttribute("aria-label", `Открыть дела на ${date}`);
          info.el.onclick = () => onOpenDate(date);
          info.el.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenDate(date);
            }
          };
          info.el.onmouseenter = () => {
            if (info.el.classList.contains("calendar-day-occupied"))
              showPreview({ el: info.el, date: info.date }, date);
          };
          info.el.onmouseleave = () => onDayHover(null, date);
        }}
        dayCellWillUnmount={(info) => {
          info.el.onclick = null;
          info.el.onkeydown = null;
          info.el.onmouseenter = null;
          info.el.onmouseleave = null;
        }}
      />
    </div>
  );
}
