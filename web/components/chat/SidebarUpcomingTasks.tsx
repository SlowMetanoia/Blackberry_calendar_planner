import { CalendarClockIcon } from "lucide-react";
import type { UpcomingTask } from "../../libs/hooks/use-upcoming-tasks";
import { formatHistoryTime, localDateKey } from "../../libs/format";
import { Skeleton } from "../ui/skeleton";

const dayMonth = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
});

function deadlineLabel(item: UpcomingTask): string {
  const date = new Date(item.deadline);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const time = formatHistoryTime(date.toISOString());
  const key = localDateKey(date);
  if (key === localDateKey(today)) return `Сегодня, ${time}`;
  if (key === localDateKey(tomorrow)) return `Завтра, ${time}`;
  return `${dayMonth.format(date)}, ${time}`;
}

export function SidebarUpcomingTasks({
  items,
  loading,
  error,
}: {
  items: UpcomingTask[];
  loading: boolean;
  error: string;
}) {
  if (loading && !items.length) {
    return (
      <div className="grid gap-2 px-2 py-1.5" aria-busy="true">
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <span className="sr-only">Загружаю задачи…</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-2 py-2 text-[12px] leading-relaxed text-sidebar-foreground/45">
        {error}
      </p>
    );
  }

  if (!items.length) {
    return null;
  }

  return (
    <ul className="grid gap-0.5 px-1">
      {items.map((item) => (
        <li key={item.task.id}>
          <div className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5">
            <span
              aria-hidden="true"
              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                item.overdue ? "bg-destructive" : "bg-sidebar-primary"
              }`}
            />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <strong className="truncate text-[13px] font-medium leading-[1.15rem]">
                {item.task.title}
              </strong>
              <small
                className={`truncate text-[11.5px] tabular-nums ${
                  item.overdue
                    ? "text-destructive"
                    : "text-sidebar-foreground/45"
                }`}
              >
                {item.overdue ? "Просрочено · " : ""}
                {deadlineLabel(item)}
              </small>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
