import type { CalendarEntry, Resource } from "../types";
import { EntryDetails } from "./EntryDetails";

export function DayDialog({
  date,
  entries,
  onClose,
  onOpen,
  onCreate,
}: {
  date: string;
  entries: CalendarEntry[];
  onClose: () => void;
  onOpen: (entry: CalendarEntry) => void;
  onCreate: (resource: Resource) => void;
}) {
  const label = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(
    new Date(`${date}T12:00:00`),
  );
  return (
    <div className="day-dialog-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="day-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Дела на ${label}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="item-dialog-head">
          <div>
            <div className="eyebrow">День</div>
            <h2>{label}</h2>
          </div>
          <button aria-label="Закрыть дела на день" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="day-actions">
          <button onClick={() => onCreate("event")}>+ Событие</button>
          <button onClick={() => onCreate("task")}>+ Задача</button>
        </div>
        <div className="day-entry-list">
          {entries.map((entry) => (
            <button
              className={`day-entry ${entry.resource}`}
              key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
              onClick={() => onOpen(entry)}
            >
              <EntryDetails entry={entry} />
            </button>
          ))}
          {!entries.length && (
            <p className="sidebar-state">
              На эту дату ничего нет. Добавьте событие или задачу.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
