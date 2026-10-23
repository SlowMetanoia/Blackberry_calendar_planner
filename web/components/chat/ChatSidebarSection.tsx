import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

function storedOpen(storageKey: string, defaultOpen: boolean): boolean {
  if (typeof localStorage === "undefined") return defaultOpen;
  const stored = localStorage.getItem(storageKey);
  return stored === null ? defaultOpen : stored === "true";
}

export function ChatSidebarSection({
  storageKey,
  title,
  icon: Icon,
  count,
  grow = 1,
  defaultOpen = true,
  className = "",
  children,
}: {
  storageKey: string;
  title: string;
  icon: LucideIcon;
  count?: number;
  grow?: number;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => storedOpen(storageKey, defaultOpen));
  const contentId = useId();
  const titleId = useId();

  const toggle = () =>
    setOpen((current) => {
      const next = !current;
      if (typeof localStorage !== "undefined")
        localStorage.setItem(storageKey, String(next));
      return next;
    });

  return (
    <section
      aria-labelledby={titleId}
      style={{ flexGrow: open ? grow : 0 }}
      className={`flex min-h-9 basis-0 flex-col transition-[flex-grow] duration-300 ease-out ${className}`}
    >
      <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1 pb-0.5">
        <button
          type="button"
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-sidebar-accent/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 md:min-h-0"
          aria-expanded={open}
          aria-controls={contentId}
          aria-label={`${open ? "Свернуть" : "Развернуть"} раздел «${title}»`}
          onClick={toggle}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 shrink-0 text-sidebar-foreground/45 transition-transform duration-200 ${
              open ? "" : "-rotate-90"
            }`}
          />
          <Icon
            aria-hidden="true"
            className="size-4 shrink-0 text-sidebar-foreground/60"
          />
          <span
            id={titleId}
            className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground/55"
          >
            {title}
          </span>
          {count !== undefined && (
            <span className="rounded-full bg-sidebar-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-sidebar-foreground/60">
              {count}
            </span>
          )}
        </button>
      </div>
      <div
        className={`grid min-h-0 flex-1 transition-[grid-template-rows,opacity] duration-300 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div
          id={contentId}
          aria-hidden={!open}
          inert={!open}
          className="flex min-h-0 flex-col overflow-hidden"
        >
          {children}
        </div>
      </div>
    </section>
  );
}
