import { ChevronsUpDownIcon } from "lucide-react";
import type { CalendarEntry } from "../../types";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
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
  return (
    <aside
      className="grid content-start overflow-hidden rounded-xl bg-card ring-1 ring-border/70"
      aria-label="Ближайшие дела"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-semibold">Ближайшие дела</h2>
          {overviewTotal > 0 && !loading && (
            <span className="text-[11px] text-muted-foreground">
              {overviewTotal}
            </span>
          )}
        </div>
        <Label htmlFor="upcoming-horizon" className="sr-only">
          Период ближайших дел
        </Label>
        <span className="w-[84px] shrink-0">
          <NativeSelect
            id="upcoming-horizon"
            aria-label="Период ближайших дел"
            className="h-7 text-xs"
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

      <div className="grid content-start gap-5 px-4 py-4">
        {loading && (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
            <span className="sr-only">Загружаю…</span>
          </div>
        )}
        {!loading && !overviewTotal && (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            На этот период ничего не запланировано.
          </p>
        )}
        <ScheduleSection
          title="Просрочено"
          overdue
          entries={overdue}
          onOpen={onOpenEntry}
        />
        <ScheduleSection
          title="В ближайшие дни"
          entries={upcoming}
          onOpen={onOpenEntry}
        />
        {undatedEntries.length > 0 && (
          <section className="grid gap-1.5">
            <h3 className="flex items-baseline gap-1.5 px-2 text-xs font-semibold">
              <span>Без срока</span>
              <span className="text-[11px] font-normal text-muted-foreground">
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
            className="w-fit justify-self-start"
            onClick={() => void onLoadMore()}
          >
            <ChevronsUpDownIcon aria-hidden="true" />
            Показать ещё
          </Button>
        )}
      </div>
    </aside>
  );
}
