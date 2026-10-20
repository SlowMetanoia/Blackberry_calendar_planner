import {
  CalendarDaysIcon,
  HistoryIcon,
  MessagesSquareIcon,
} from "lucide-react";
import type { PlannerView } from "../../types";

const sections: {
  view: PlannerView;
  label: string;
  description: string;
  icon: typeof CalendarDaysIcon;
}[] = [
  {
    view: "chat",
    label: "Чат",
    description: "",
    icon: MessagesSquareIcon,
  },
  {
    view: "calendar",
    label: "Календарь",
    description: "",
    icon: CalendarDaysIcon,
  },
  {
    view: "history",
    label: "История изменений",
    description: "",
    icon: HistoryIcon,
  },
];

export function SidebarNav({
  view,
  collapsed,
  historyCount,
  onSelect,
}: {
  view: PlannerView;
  collapsed: boolean;
  historyCount: number;
  onSelect: (view: PlannerView) => void;
}) {
  return (
    <nav
      className="grid content-start gap-1 p-3"
      aria-label="Разделы"
    >
      {sections.map(({ view: target, label, description, icon: Icon }) => {
        const active = view === target;
        const count = target === "history" ? historyCount : 0;
        return (
          <button
            key={target}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={collapsed ? label : undefined}
            onClick={() => onSelect(target)}
            className={`group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 ${
              collapsed ? "md:justify-center md:px-0" : ""
            } ${
              active
                ? "bg-sidebar-accent/15 text-sidebar-foreground"
                : "text-sidebar-foreground/75 hover:bg-sidebar-accent/10 hover:text-sidebar-foreground"
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity ${
                active ? "opacity-100" : "opacity-0"
              }`}
            />
            <Icon
              aria-hidden="true"
              className={`size-4 shrink-0 ${
                active ? "text-sidebar-primary" : ""
              }`}
            />
            <span
              className={`grid min-w-0 flex-1 gap-0.5 ${
                collapsed ? "md:hidden" : ""
              }`}
            >
              <span className="truncate font-medium">{label}</span>
              <span className="truncate text-[10.5px] font-normal text-sidebar-foreground/45">
                {description}
              </span>
            </span>
            {count > 0 && (
              <span
                className={`rounded-full bg-sidebar-accent/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-sidebar-primary ${
                  collapsed ? "md:hidden" : ""
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
