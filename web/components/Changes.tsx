import type { CalendarOperation } from "../types";

export function Changes({
  changes,
}: {
  changes: CalendarOperation["changes"];
}) {
  return (
    <dl className="operation-changes">
      {Object.entries(changes)
        .filter(([key]) => key !== "id")
        .map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {String(value.before ?? "—")} → {String(value.after ?? "—")}
            </dd>
          </div>
        ))}
    </dl>
  );
}
