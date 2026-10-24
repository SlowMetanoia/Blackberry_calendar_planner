import type { PlannerView } from "../../types";
import { SidebarBrand } from "./SidebarBrand";
import { SidebarNav } from "./SidebarNav";
import { Mascot, type MascotMode } from "../chat/Mascot";

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
  mascotMode,
  mascotVisible,
}: {
  view: PlannerView;
  open: boolean;
  collapsed: boolean;
  historyCount: number;
  onSelect: (view: PlannerView) => void;
  onClose: () => void;
  onToggleCollapsed: () => void;
  mascotMode: MascotMode;
  mascotVisible: boolean;
}) {
  const today = todayFormat.format(new Date());

  return (
    <aside
      aria-label="Разделы ежедневника"
      className={`fixed inset-y-0 left-0 z-50 flex w-[min(19rem,88vw)] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-[width,transform] duration-200 ease-out md:static md:z-auto md:visible md:translate-x-0 md:pt-0 md:pb-0 md:shadow-none 
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
      <div className="min-h-0 flex-1 pt-16">
        <SidebarNav
          view={view}
          collapsed={collapsed}
          historyCount={historyCount}
          onSelect={onSelect}
        />
      </div>
      <div
        className="relative h-24 shrink-0 border-t border-sidebar-foreground/25"
        data-testid="sidebar-mascot-line"
      >
        {mascotVisible && <Mascot mode={mascotMode} />}
      </div>
    </aside>
  );
}
