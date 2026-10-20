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
    <header className="flex shrink-0 items-center justify-between gap-2 border-b bg-background px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2.5 sm:gap-3 sm:px-7 sm:py-3">
      <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
        <Button
          className="shrink-0 max-sm:size-9 md:hidden"
          variant="ghost"
          size="icon-sm"
          aria-label="Открыть меню"
          onClick={onOpenNav}
        >
          <MenuIcon aria-hidden="true" />
        </Button>
        <h1 className="truncate font-heading text-lg font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
      </div>
      <div className="flex max-w-[65%] shrink-0 flex-wrap items-center justify-end gap-0.5 sm:max-w-[60%] sm:gap-1">
        {children}
      </div>
    </header>
  );
}
