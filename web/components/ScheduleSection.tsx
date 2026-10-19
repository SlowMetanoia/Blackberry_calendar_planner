import { useState } from "react";
import { createPortal } from "react-dom";
import { localDateKey } from "../libs/format";
import type { CalendarEntry, PreviewAnchor } from "../types";
import { EntryDetails } from "./EntryDetails";

function entryLabel(entry: CalendarEntry): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.startsAt));
}

export function ScheduleSection({
  title,
  entries,
  onOpen,
}: {
  title: string;
  entries: CalendarEntry[];
  onOpen: (entry: CalendarEntry) => void;
}) {
  if (!entries.length) return null;
  const groups = new Map<string, CalendarEntry[]>();
  entries.forEach((entry) => {
    const key = localDateKey(entry.startsAt);
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  return (
    <section className="schedule-section">
      <h3>{title}</h3>
      {[...groups.entries()].map(([date, items]) => (
        <div className="schedule-day" key={date}>
          <h4>
            {new Intl.DateTimeFormat("ru-RU", {
              weekday: "short",
              day: "numeric",
              month: "short",
            }).format(new Date(`${date}T12:00:00`))}
          </h4>
          {items.map((entry) => (
            <ScheduleItem
              entry={entry}
              key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
              onOpen={onOpen}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

export function ScheduleItem({
  entry,
  onOpen,
}: {
  entry: CalendarEntry;
  onOpen: (entry: CalendarEntry) => void;
}) {
  const [preview, setPreview] = useState<PreviewAnchor | null>(null),
    previewId = `schedule-preview-${entry.resource}-${entry.occurrenceKey || entry.id}`;
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect(),
      width = 310;
    setPreview({
      x:
        rect.left > width + 16
          ? rect.left - width - 10
          : Math.min(rect.right + 10, window.innerWidth - width - 8),
      y: Math.max(8, Math.min(rect.top, window.innerHeight - 260)),
    });
  };
  return (
    <>
      <button
        className={`schedule-item ${entry.resource}`}
        aria-describedby={preview ? previewId : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setPreview(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setPreview(null)}
        onClick={() => onOpen(entry)}
      >
        <strong>{entry.title}</strong>
        <small>
          {entry.startsAt
            ? `${entryLabel(entry)} · ${entry.resource === "task" ? "задача" : "событие"}`
            : "Задача без срока"}
        </small>
      </button>
      {preview &&
        createPortal(
          <div
            id={previewId}
            className="schedule-preview"
            role="tooltip"
            style={{ left: preview.x, top: preview.y }}
          >
            <EntryDetails entry={entry} />
          </div>,
          document.body,
        )}
    </>
  );
}
