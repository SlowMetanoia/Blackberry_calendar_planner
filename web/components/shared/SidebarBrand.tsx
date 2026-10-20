import {
  NotebookPenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";

export function SidebarBrand({
  collapsed,
  today,
  onClose,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  today: string;
  onClose: () => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-4 pt-5 pb-4 ${
        collapsed ? "md:justify-center md:px-0" : ""
      }`}
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-accent text-sidebar-accent-foreground ${
          collapsed ? "md:hidden" : ""
        }`}
      >
        <NotebookPenIcon aria-hidden="true" className="size-4" />
      </span>
      <span className={`grid min-w-0 gap-0.5 ${collapsed ? "md:hidden" : ""}`}>
        <span className="truncate font-heading text-sm font-semibold">
          Ежедневник
        </span>
        <span className="truncate text-[10.5px] text-sidebar-foreground/50 first-letter:uppercase">
          {today}
        </span>
      </span>
      <Button
        className="ml-auto text-sidebar-foreground/60 hover:bg-sidebar-accent/15 hover:text-sidebar-foreground md:hidden"
        variant="ghost"
        size="icon-sm"
        aria-label="Закрыть меню"
        onClick={onClose}
      >
        <XIcon aria-hidden="true" />
      </Button>
      <Button
        className={`ml-auto hidden text-sidebar-foreground/60 hover:bg-sidebar-accent/15 hover:text-sidebar-foreground md:inline-flex ${
          collapsed ? "md:hidden" : ""
        }`}
        variant="ghost"
        size="icon-sm"
        aria-label="Свернуть панель"
        onClick={onToggleCollapsed}
      >
        <PanelLeftCloseIcon aria-hidden="true" />
      </Button>
      {collapsed && (
        <Button
          className="hidden text-sidebar-foreground/60 hover:bg-sidebar-accent/15 hover:text-sidebar-foreground md:inline-flex"
          variant="ghost"
          size="icon-sm"
          aria-label="Развернуть панель"
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpenIcon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
