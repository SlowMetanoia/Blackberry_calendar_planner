import { formatHistoryDate, historyDateKey } from "../../libs/format";
import { useSessionStore } from "../../libs/stores";
import type { CalendarOperation } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { EmptyState } from "../shared/EmptyState";
import { HistoryItem } from "./HistoryItem";

function changesCount(value: number): string {
  const lastTwo = value % 100,
    last = value % 10;
  if (last === 1 && lastTwo !== 11) return `${value} изменение`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14))
    return `${value} изменения`;
  return `${value} изменений`;
}

export function HistoryPanel() {
  const items = useSessionStore((state) => state.history);
  const undo = useSessionStore((state) => state.undo);

  if (!items.length)
    return (
      <EmptyState
        title="Изменений пока нет"
        description="Здесь появятся созданные, изменённые и удалённые записи календаря."
      />
    );

  const groups = new Map<string, CalendarOperation[]>();
  items.forEach((item) => {
    const key = historyDateKey(item.created_at);
    groups.set(key, [...(groups.get(key) || []), item]);
  });

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportClassName="px-4 py-5 sm:px-7"
      aria-label="История изменений календаря"
    >
      <div className="mx-auto w-full max-w-[90%]">
        {[...groups.entries()].map(([date, group]) => (
          <section className="grid" key={date}>
            <header className="sticky top-0 z-10 -mx-1.5 flex items-center gap-2.5 bg-background/95 px-1.5 py-2.5 backdrop-blur">
              <h2 className="text-xs font-semibold">
                {formatHistoryDate(group[0].created_at)}
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {changesCount(group.length)}
              </span>
              <Separator className="flex-1 bg-border/70" />
            </header>
            <ul className="grid divide-y divide-border/60">
              {group.map((item) => (
                <li key={item.id}>
                  <HistoryItem item={item} undo={undo} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
