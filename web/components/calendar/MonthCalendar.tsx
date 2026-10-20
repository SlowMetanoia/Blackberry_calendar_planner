import type { DatesSetInfo } from "@fullcalendar/react";
import FullCalendar from "@fullcalendar/react";
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

type DayCell = { el: HTMLElement; date: Date };

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
  const datesSet = (info: DatesSetInfo) =>
    onRangeChange({
      from: info.start.toISOString(),
      to: info.end.toISOString(),
    });

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
    <FullCalendar
      plugins={[classicThemePlugin, dayGridPlugin, interactionPlugin]}
      locale={ruLocale}
      initialView="dayGridMonth"
      headerToolbar={{ left: "prev,next", center: "title", right: "today" }}
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
  );
}
