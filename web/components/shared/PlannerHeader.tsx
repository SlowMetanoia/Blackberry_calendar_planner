import type { ReactNode } from "react";
import { MenuIcon } from "lucide-react";
import { Button } from "../ui/button";

export function PlannerHeader({
  title,
  onOpenNav,
  children,
}: {
  title: string;
  onOpenNav: () => void;
  children: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-7">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          className="shrink-0 md:hidden"
          variant="ghost"
          size="icon-sm"
          aria-label="Открыть меню"
          onClick={onOpenNav}
        >
          <MenuIcon aria-hidden="true" />
        </Button>
        <h1 className="truncate font-heading text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
      </div>
      <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-1">
        {children}
      </div>
    </header>
  );
}
