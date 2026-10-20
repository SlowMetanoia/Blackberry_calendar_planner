import type { ReactNode } from "react";
import { cn } from "cn";

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 place-items-center px-6 pb-16",
        className,
      )}
    >
      <div className="grid max-w-sm justify-items-center gap-1.5 text-center">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {action}
      </div>
    </div>
  );
}
