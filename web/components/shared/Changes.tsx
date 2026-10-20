import type { CalendarOperation } from "../../types";

export function Changes({
  changes,
}: {
  changes: CalendarOperation["changes"];
}) {
  return (
    <dl className="grid gap-1.5 text-xs">
      {Object.entries(changes)
        .filter(([key]) => key !== "id")
        .map(([key, value]) => (
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2"
            key={key}
          >
            <dt className="truncate font-medium text-muted-foreground">
              {key}
            </dt>
            <dd className="m-0 flex flex-wrap items-center gap-1.5 text-foreground">
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive line-through decoration-destructive/40">
                {String(value.before ?? "—")}
              </span>{" "}
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>{" "}
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                {String(value.after ?? "—")}
              </span>
            </dd>
          </div>
        ))}
    </dl>
  );
}
