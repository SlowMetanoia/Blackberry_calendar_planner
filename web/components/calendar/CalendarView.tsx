import { useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2Icon } from "lucide-react";
import type {
  CalendarEntry,
  DayHover,
  EditorState,
  Resource,
} from "../../types";
import { useSessionStore } from "../../libs/stores";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { CalendarItemDialog } from "./CalendarItemDialog";
import { DayDialog } from "./DayDialog";
import { DayHoverPreview } from "./DayHoverPreview";
import { MonthCalendar } from "./MonthCalendar";
import { UpcomingPanel } from "./UpcomingPanel";
import { useCalendarData } from "../../libs/hooks/use-calendar-data";

export function CalendarView() {
  const data = useCalendarData();
  const onHistoryChanged = useSessionStore(
    (state) => state.handleCalendarChanged,
  );
  const onError = useSessionStore((state) => state.setError);
  const [fullOpen, setFullOpen] = useState(false);
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
      occupied={data.occupied}
      onRangeChange={data.updateVisibleRange}
      onOpenDate={openDate}
      onDayHover={handleDayHover}
    />
  );

  return (
    <>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="px-4 py-5 sm:px-7"
      >
        <div className="mx-auto grid w-full max-w-6xl items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
          <section className="grid gap-2" aria-label="Календарь месяца">
            <div className="planner-calendar rounded-xl bg-card p-3 ring-1 ring-border/70">
              {calendar(false)}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit justify-self-end text-muted-foreground hover:text-foreground"
              onClick={() => setFullOpen(true)}
            >
              <Maximize2Icon aria-hidden="true" />
              Развернуть календарь
            </Button>
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
      </ScrollArea>

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
          className="h-[min(900px,calc(100dvh-2rem))] w-[min(1500px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:max-w-[min(1500px,calc(100vw-2rem))]"
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-xl">Подробный календарь</DialogTitle>
          </DialogHeader>
          <div className="calendar-full min-h-0">{calendar(true)}</div>
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
