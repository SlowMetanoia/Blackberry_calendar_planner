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
import { Calendar } from "./Calendar";
import type { CalendarMode } from "./calendar-utils";
import { DayDialog } from "./DayDialog";
import { DayHoverPreview } from "./DayHoverPreview";
import { UpcomingPanel } from "./UpcomingPanel";
import { useCalendarData } from "../../libs/hooks/use-calendar-data";

export function CalendarView() {
  const data = useCalendarData();
  const onHistoryChanged = useSessionStore(
    (state) => state.handleCalendarChanged,
  );
  const onError = useSessionStore((state) => state.setError);
  const [fullOpen, setFullOpen] = useState(false);
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [dayTime, setDayTime] = useState<string | null>(null);
  const [dayHover, setDayHover] = useState<DayHover | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const selectedEntries = dayOpen ? data.entriesByDate.get(dayOpen) || [] : [];

  function openEntry(entry: CalendarEntry) {
    setEditor({ resource: entry.resource, entry });
  }

  function openDate(date: string, time?: string) {
    setDayHover(null);
    setDayOpen(date);
    setDayTime(time ?? null);
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
    <Calendar
      fullscreen={fullscreen}
      mode={mode}
      anchor={anchor}
      occupied={data.occupied}
      entriesByDate={data.entriesByDate}
      onModeChange={setMode}
      onAnchorChange={setAnchor}
      onRangeChange={data.updateVisibleRange}
      onOpenDate={openDate}
      onOpenEntry={openEntry}
      onDayHover={handleDayHover}
      onExpand={fullscreen ? undefined : () => setFullOpen(true)}
    />
  );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
        <div className="mx-auto grid min-h-full w-full max-w-[1600px] gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:gap-4 sm:p-6 xl:h-full xl:grid-cols-[minmax(0,1fr)_20rem] xl:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-0 flex-col" aria-label="Календарь месяца">
            <Card className="flex min-h-[28rem] flex-1 flex-col overflow-hidden ring-border/70 [--card-spacing:0px] sm:min-h-[34rem] xl:min-h-0">
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
          className="flex h-[min(920px,calc(100dvh-2rem))] w-[min(1500px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 max-sm:h-[92dvh] max-sm:max-h-[92dvh] max-sm:w-full max-sm:max-w-none max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:p-0 max-sm:pb-0 sm:max-w-[min(1500px,calc(100vw-2rem))]"
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
          onClose={() => {
            setDayOpen(null);
            setDayTime(null);
          }}
          onOpen={openEntry}
          onCreate={(resource: Resource) =>
            setEditor({
              resource,
              date: dayOpen,
              time: dayTime ?? undefined,
            })
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
