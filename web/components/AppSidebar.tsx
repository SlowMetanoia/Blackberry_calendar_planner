import {
  CalendarDaysIcon,
  HistoryIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  XIcon,
} from "lucide-react";
import type { PlannerView } from "../types";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

const sections: {
  view: PlannerView;
  label: string;
  icon: typeof CalendarDaysIcon;
}[] = [
  { view: "chat", label: "Чат", icon: MessagesSquareIcon },
  { view: "calendar", label: "Календарь", icon: CalendarDaysIcon },
  { view: "history", label: "История изменений", icon: HistoryIcon },
];

export function AppSidebar({
  view,
  open,
  onSelect,
  onClose,
}: {
  view: PlannerView;
  open: boolean;
  onSelect: (view: PlannerView) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Разделы ежедневника"
      className={`fixed inset-y-0 left-0 z-50 flex w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 ease-out md:static md:z-auto md:visible md:translate-x-0 md:shadow-none ${
        open ? "visible translate-x-0 shadow-xl" : "invisible -translate-x-full"
      }`}
    >
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-accent text-sidebar-accent-foreground">
          <NotebookPenIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate font-heading text-sm font-semibold">
            Ежедневник
          </span>
          <span className="truncate text-[11px] text-sidebar-foreground/60">
            Планы голосом и текстом
          </span>
        </span>
        <Button
          className="ml-auto hover:bg-sidebar-accent/15 hover:text-sidebar-foreground md:hidden"
          variant="ghost"
          size="icon-sm"
          aria-label="Закрыть меню"
          onClick={onClose}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <Separator className="bg-sidebar-border" />
      <nav className="grid content-start gap-1 p-3" aria-label="Разделы">
        {sections.map(({ view: target, label, icon: Icon }) => {
          const active = view === target;
          return (
            <button
              key={target}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(target)}
              className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 ${
                active
                  ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/10 hover:text-sidebar-foreground"
              }`}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
