import type { PlannerView } from "../../types";
import { MiniCalendar } from "./MiniCalendar";
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
  onOpenDate,
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
  onOpenDate: (date: string) => void;
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0">
          <SidebarNav
            view={view}
            collapsed={collapsed}
            historyCount={historyCount}
            onSelect={onSelect}
          />
        </div>
        {view !== "calendar" && (
          <div
            className={`mt-1 shrink-0 border-t border-sidebar-foreground/10 pt-2 ${
              collapsed ? "md:hidden" : ""
            }`}
          >
            <MiniCalendar onOpenDate={onOpenDate} />
          </div>
        )}
        <div className="mascot-slot relative min-h-0 flex-1">
          {mascotVisible && <Mascot mode={mascotMode} />}
        </div>
      </div>
      <div
        className="relative @container/sidebar-branding h-24 shrink-0 border-t border-sidebar-foreground/25"
        data-testid="sidebar-mascot-line"
      >
        <span
          data-collapsed={collapsed}
          className="gorkycode-label absolute inset-0 z-20 flex items-center justify-center whitespace-nowrap font-pixel text-sidebar-foreground/55"
        >
          Gorkycode
        </span>
      </div>
    </aside>
  );
}
