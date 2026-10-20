import type { PlannerView } from "../../types";
import { Separator } from "../ui/separator";
import { SidebarBrand } from "./SidebarBrand";
import { SidebarNav } from "./SidebarNav";

const todayFormat = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export function AppSidebar({
  view,
  open,
  collapsed,
  historyCount,
  onSelect,
  onClose,
  onToggleCollapsed,
}: {
  view: PlannerView;
  open: boolean;
  collapsed: boolean;
  historyCount: number;
  onSelect: (view: PlannerView) => void;
  onClose: () => void;
  onToggleCollapsed: () => void;
}) {
  const today = todayFormat.format(new Date());

  return (
    <aside
      aria-label="Разделы ежедневника"
      className={`fixed inset-y-0 left-0 z-50 flex w-[264px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200 ease-out md:static md:z-auto md:visible md:translate-x-0 md:shadow-none 
          ${collapsed ? "md:w-[76px]" : "md:w-[264px]"
        } ${open ? "visible translate-x-0 shadow-xl" : "invisible -translate-x-full"
        }`}
    >
      <SidebarBrand
        collapsed={collapsed}
        today={today}
        onClose={onClose}
        onToggleCollapsed={onToggleCollapsed}
      />
      <div className="pt-16">
        <SidebarNav
          view={view}
          collapsed={collapsed}
          historyCount={historyCount}
          onSelect={onSelect}
        />
      </div>
    </aside>
  );
}
