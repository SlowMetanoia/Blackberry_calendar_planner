import { useState } from "react";
import { createPortal } from "react-dom";
import type {
  CalendarEntry,
  DayHover,
  EditorState,
  Resource,
} from "../../types";
import { useSessionStore } from "../../libs/stores";
import { Card } from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { CalendarItemDialog } from "./CalendarItemDialog";
import { DayDialog } from "./DayDialog";
import { DayHoverPreview } from "./DayHoverPreview";
import { MonthCalendar } from "./MonthCalendar";
import { UpcomingPanel } from "./UpcomingPanel";
import { useCalendarData } from "../../libs/hooks/use-calendar-data";

function currentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1, 12);
}

export function CalendarView() {
  const data = useCalendarData();
  const onHistoryChanged = useSessionStore(
    (state) => state.handleCalendarChanged,
  );
  const onError = useSessionStore((state) => state.setError);
  const [fullOpen, setFullOpen] = useState(false);
  const [month, setMonth] = useState(currentMonth);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [dayHover, setDayHover] = useState<DayHover | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const selectedEntries = dayOpen ? data.entriesByDate.get(dayOpen) || [] : [];

  function openEntry(entry: CalendarEntry) {
    setEditor({ resource: entry.resource, entry });
  }

  function openDate(date: string) {
    setDayHover(null);
    setDayOpen(date);
  }

  function handleDayHover(hover: DayHover | null, date: string | null) {
    setDayHover((current) =>
      hover ? hover : current?.date === date ? null : current,
    );
  }

  async function changed() {
    setEditor(null);
    await Promise.all([data.refresh(), Promise.resolve(onHistoryChanged())]);
  }

  const calendar = (fullscreen: boolean) => (
    <MonthCalendar
      fullscreen={fullscreen}
      month={month}
      occupied={data.occupied}
      entriesByDate={data.entriesByDate}
      onMonthChange={setMonth}
      onRangeChange={data.updateVisibleRange}
      onOpenDate={openDate}
      onDayHover={handleDayHover}
      onExpand={fullscreen ? undefined : () => setFullOpen(true)}
    />
  );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
        <div className="mx-auto grid min-h-full w-full max-w-[1600px] gap-4 p-4 sm:p-6 xl:h-full xl:grid-cols-[minmax(0,1fr)_20rem] xl:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-0 flex-col" aria-label="Календарь месяца">
            <Card className="flex min-h-[34rem] flex-1 flex-col overflow-hidden ring-border/70 [--card-spacing:0px] xl:min-h-0">
              {calendar(false)}
            </Card>
          </section>

          <UpcomingPanel
            upcomingDays={data.upcomingDays}
            loading={data.loading}
            overdue={data.overview.overdue}
            upcoming={data.overview.upcoming}
            undatedEntries={data.undatedEntries}
            overviewTotal={data.overviewTotal}
            overviewCursor={data.overviewCursor}
            onHorizonChange={data.changeHorizon}
            onLoadMore={data.loadMoreOverview}
            onOpenEntry={openEntry}
          />
        </div>
      </div>

      {dayHover &&
        createPortal(
          <DayHoverPreview
            date={dayHover.date}
            entries={data.entriesByDate.get(dayHover.date) || []}
            x={dayHover.x}
            y={dayHover.y}
          />,
          document.body,
        )}

      <Dialog open={fullOpen} onOpenChange={setFullOpen}>
        <DialogContent
          closeLabel="Закрыть подробный календарь"
          className="flex h-[min(920px,calc(100dvh-2rem))] w-[min(1500px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1500px,calc(100vw-2rem))]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Подробный календарь</DialogTitle>
          </DialogHeader>
          <div className="calendar-full flex min-h-0 flex-1 flex-col">
            {calendar(true)}
          </div>
        </DialogContent>
      </Dialog>

      {dayOpen && (
        <DayDialog
          date={dayOpen}
          entries={selectedEntries}
          onClose={() => setDayOpen(null)}
          onOpen={openEntry}
          onCreate={(resource: Resource) =>
            setEditor({ resource, date: dayOpen })
          }
        />
      )}
      {editor && (
        <CalendarItemDialog
          state={editor}
          onClose={() => setEditor(null)}
          onChanged={changed}
          onError={onError}
        />
      )}
    </>
  );
}
