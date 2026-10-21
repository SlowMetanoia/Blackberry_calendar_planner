import { ChevronsDownIcon } from "lucide-react";
import type { CalendarEntry } from "../../types";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { ScheduleList } from "./ScheduleList";
import { ScheduleSection } from "./ScheduleSection";

const horizonOptions = [1, 3, 7, 14, 30];

export function UpcomingPanel({
  upcomingDays,
  loading,
  overdue,
  upcoming,
  undatedEntries,
  overviewTotal,
  overviewCursor,
  onHorizonChange,
  onLoadMore,
  onOpenEntry,
}: {
  upcomingDays: number;
  loading: boolean;
  overdue: CalendarEntry[];
  upcoming: CalendarEntry[];
  undatedEntries: CalendarEntry[];
  overviewTotal: number;
  overviewCursor: string | null;
  onHorizonChange: (value: number) => Promise<void> | void;
  onLoadMore: () => Promise<void> | void;
  onOpenEntry: (entry: CalendarEntry) => void;
}) {
  const isEmpty = !loading && overviewTotal === 0;
  const showSkeleton = loading && overviewTotal === 0;

  return (
    <section
      role="complementary"
      aria-label="Ближайшие дела"
      aria-busy={loading}
      className="flex h-[22rem] max-h-[65dvh] min-h-0 flex-col overflow-hidden sm:h-[24rem] sm:max-h-[70vh] xl:h-full xl:max-h-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-1.5 py-2.5 sm:px-2 sm:py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-semibold">Ближайшие дела</h2>
          {overviewTotal > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {overviewTotal}
            </span>
          )}
        </div>
        <Label htmlFor="upcoming-horizon" className="sr-only">
          Период ближайших дел
        </Label>
        <span className="w-[80px] shrink-0">
          <NativeSelect
            id="upcoming-horizon"
            aria-label="Период ближайших дел"
            className="h-9 text-xs sm:h-7"
            value={upcomingDays}
            onChange={(event) => void onHorizonChange(Number(event.target.value))}
          >
            {horizonOptions.map((value) => (
              <option value={value} key={value}>
                {value} дн.
              </option>
            ))}
          </NativeSelect>
        </span>
      </header>

      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="py-2.5 pl-1.5 pr-3 sm:py-3 sm:pl-2 sm:pr-4"
      >
        {showSkeleton && (
          <div className="grid gap-3 py-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-4/5" />
            <span className="sr-only">Загружаю…</span>
          </div>
        )}

        {isEmpty && (
          <div className="grid place-items-center px-4 py-12 text-center">
            <p className="text-sm font-medium">На этот период пусто</p>
            <p className="mt-1 max-w-56 text-xs leading-relaxed text-muted-foreground">
              Выберите день в календаре, чтобы добавить событие или задачу.
            </p>
          </div>
        )}

        {!showSkeleton && (
          <div className="grid gap-5">
            <ScheduleSection
              title="Просрочено"
              overdue
              entries={overdue}
              onOpen={onOpenEntry}
            />
            <ScheduleSection entries={upcoming} onOpen={onOpenEntry} />
            {undatedEntries.length > 0 && (
              <section className="grid gap-1.5">
                <h3 className="flex items-baseline gap-1.5 px-2 text-xs font-semibold">
                  <span>Без срока</span>
                  <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
                    {undatedEntries.length}
                  </span>
                </h3>
                <ScheduleList entries={undatedEntries} onOpen={onOpenEntry} />
              </section>
            )}
            {overviewCursor && (
              <Button
                variant="outline"
                size="sm"
                className="w-full max-sm:h-11"
                onClick={() => void onLoadMore()}
              >
                <ChevronsDownIcon aria-hidden="true" />
                Показать ещё
              </Button>
            )}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
