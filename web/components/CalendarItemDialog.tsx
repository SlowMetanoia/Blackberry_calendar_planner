import { FormEvent, useState } from "react";
import {
  createEvent,
  createTask,
  deleteEvent,
  deleteEventOccurrence,
  deleteTask,
  deleteTaskOccurrence,
  updateEvent,
  updateEventOccurrence,
  updateTask,
  updateTaskOccurrence,
} from "../api";
import { localDateKey } from "../libs/format";
import type {
  EditorState,
  RecurrenceRule,
  Resource,
  Weekday,
} from "../types";

function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const weekdayLabels: Record<Weekday, string> = {
  MO: "Пн",
  TU: "Вт",
  WE: "Ср",
  TH: "Чт",
  FR: "Пт",
  SA: "Сб",
  SU: "Вс",
};

export function CalendarItemDialog({
  state,
  onClose,
  onChanged,
  onError,
}: {
  state: EditorState;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const source = state.entry?.task || state.entry?.event;
  const [resource, setResource] = useState<Resource>(state.resource),
    [title, setTitle] = useState(source?.title || ""),
    [description, setDescription] = useState(source?.description || "");
  const [when, setWhen] = useState(() =>
    state.entry
      ? toLocalInput(state.entry.startsAt)
      : `${state.date || localDateKey(new Date())}T09:00`,
  );
  const [duration, setDuration] = useState(
      String(state.entry?.durationMinutes || ""),
    ),
    [location, setLocation] = useState(state.entry?.event?.location || ""),
    [status, setStatus] = useState(state.entry?.task?.status || "open"),
    [saving, setSaving] = useState(false);
  const initialRule = source?.recurrence || null,
    [repeat, setRepeat] = useState<"none" | RecurrenceRule["frequency"]>(
      initialRule?.frequency || "none",
    ),
    [interval, setInterval] = useState(initialRule?.interval || 1);
  const [weekdays, setWeekdays] = useState<Weekday[]>(
      initialRule?.weekdays || [],
    ),
    [monthlyKind, setMonthlyKind] = useState(
      initialRule?.monthly?.kind || "day_of_month",
    ),
    [monthDay, setMonthDay] = useState(
      initialRule?.monthly?.day ||
        new Date(state.entry?.startsAt || Date.now()).getDate(),
    ),
    [ordinal, setOrdinal] = useState(initialRule?.monthly?.ordinal || 1),
    [monthWeekday, setMonthWeekday] = useState<Weekday>(
      initialRule?.monthly?.weekday || "MO",
    );
  const [endKind, setEndKind] = useState(initialRule?.end.kind || "never"),
    [until, setUntil] = useState(initialRule?.end.until || ""),
    [count, setCount] = useState(initialRule?.end.count || 10),
    [recurrenceTimezone, setRecurrenceTimezone] = useState(
      source?.recurrence_timezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC",
    ),
    [scope, setScope] = useState<"occurrence" | "series">(
      state.entry?.recurring ? "occurrence" : "series",
    );
  const existing = Boolean(state.entry);

  const recurrence = (): RecurrenceRule | null => {
    if (repeat === "none") return null;
    const end =
      endKind === "until"
        ? { kind: endKind, until }
        : endKind === "count"
          ? { kind: endKind, count }
          : { kind: "never" as const };
    return {
      frequency: repeat,
      interval,
      weekdays:
        repeat === "weekly" ? (weekdays.length ? weekdays : undefined) : undefined,
      monthly:
        repeat === "monthly"
          ? monthlyKind === "day_of_month"
            ? { kind: monthlyKind, day: monthDay }
            : monthlyKind === "nth_weekday"
              ? { kind: monthlyKind, ordinal, weekday: monthWeekday }
              : { kind: "last_day" }
          : undefined,
      end,
    } as RecurrenceRule;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const minutes = duration ? Number(duration) : null,
        key = state.entry?.occurrenceKey,
        instance = Boolean(
          existing &&
            key &&
            scope === "occurrence" &&
            state.entry?.recurring,
        ),
        boundary = state.entry?.recurring ? key : undefined,
        includeRecurrence =
          !instance &&
          (!existing || source?.recurrence !== undefined || repeat !== "none");
      if (resource === "event") {
        const starts_at = fromLocalInput(when);
        if (!starts_at) throw new Error("Укажите дату и время события");
        const data = {
          title,
          description: description || null,
          starts_at,
          duration_minutes: minutes,
          location: location || null,
          ...(includeRecurrence
            ? {
                recurrence: recurrence(),
                recurrence_timezone:
                  repeat === "none" ? null : recurrenceTimezone,
              }
            : {}),
        };
        if (instance) await updateEventOccurrence(state.entry!.id, key!, data);
        else if (existing) {
          if (boundary) await updateEvent(state.entry!.id, data, boundary);
          else await updateEvent(state.entry!.id, data);
        } else await createEvent(data);
      } else {
        const deadline = fromLocalInput(when);
        if (repeat !== "none" && !deadline)
          throw new Error("Для повтора нужен первый дедлайн");
        const data = {
          title,
          description: description || null,
          deadline,
          estimated_minutes: minutes,
          status: status as "open" | "completed",
          ...(includeRecurrence
            ? {
                recurrence: recurrence(),
                recurrence_timezone:
                  repeat === "none" ? null : recurrenceTimezone,
              }
            : {}),
        };
        if (instance) await updateTaskOccurrence(state.entry!.id, key!, data);
        else if (existing) {
          if (boundary) await updateTask(state.entry!.id, data, boundary);
          else await updateTask(state.entry!.id, data);
        } else await createTask(data);
      }
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!state.entry || !window.confirm(`Удалить «${state.entry.title}»?`))
      return;
    setSaving(true);
    try {
      const key = state.entry.occurrenceKey;
      if (resource === "event") {
        if (key && scope === "occurrence")
          await deleteEventOccurrence(state.entry.id, key);
        else await deleteEvent(state.entry.id);
      } else {
        if (key && scope === "occurrence")
          await deleteTaskOccurrence(state.entry.id, key);
        else await deleteTask(state.entry.id);
      }
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="item-dialog-scrim"
      role="presentation"
      onMouseDown={onClose}
    >
      <form
        className="item-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={existing ? "Редактирование записи" : "Новая запись"}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="item-dialog-head">
          <h2>{existing ? "Изменить запись" : "Новая запись"}</h2>
          <button type="button" aria-label="Закрыть форму" onClick={onClose}>
            ×
          </button>
        </div>
        {!existing && (
          <label>
            Тип
            <select
              value={resource}
              onChange={(event) => setResource(event.target.value as Resource)}
            >
              <option value="event">Событие</option>
              <option value="task">Задача</option>
            </select>
          </label>
        )}
        {existing && state.entry?.recurring && (
          <label>
            Изменить
            <select
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as "occurrence" | "series")
              }
            >
              <option value="occurrence">Только этот повтор</option>
              <option value="series">Этот и будущие повторы</option>
            </select>
          </label>
        )}
        <label>
          Название
          <input
            required
            maxLength={500}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          {resource === "event" ? "Начало" : "Дедлайн"}
          <input
            type="datetime-local"
            required={resource === "event" || repeat !== "none"}
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </label>
        <label>
          Повторять
          <select
            value={repeat}
            disabled={scope === "occurrence" && Boolean(state.entry?.recurring)}
            onChange={(event) =>
              setRepeat(event.target.value as typeof repeat)
            }
          >
            <option value="none">Не повторять</option>
            <option value="daily">Каждый день</option>
            <option value="weekly">Каждую неделю</option>
            <option value="monthly">Каждый месяц</option>
            <option value="yearly">Каждый год</option>
          </select>
        </label>
        {repeat !== "none" && scope === "series" && (
          <fieldset className="recurrence-fields">
            <label>
              Интервал
              <input
                type="number"
                min="1"
                required
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value))}
              />
            </label>
            {repeat === "weekly" && (
              <div className="weekday-picker">
                {(Object.keys(weekdayLabels) as Weekday[]).map((day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(day)}
                      onChange={() =>
                        setWeekdays((value) =>
                          value.includes(day)
                            ? value.filter((item) => item !== day)
                            : [...value, day],
                        )
                      }
                    />
                    {weekdayLabels[day]}
                  </label>
                ))}
              </div>
            )}
            {repeat === "monthly" && (
              <>
                <label>
                  Правило месяца
                  <select
                    value={monthlyKind}
                    onChange={(event) =>
                      setMonthlyKind(
                        event.target.value as typeof monthlyKind,
                      )
                    }
                  >
                    <option value="day_of_month">Число месяца</option>
                    <option value="nth_weekday">День недели по счёту</option>
                    <option value="last_day">Последний день</option>
                  </select>
                </label>
                {monthlyKind === "day_of_month" && (
                  <label>
                    Число
                    <input
                      type="number"
                      min="1"
                      max="31"
                      value={monthDay}
                      onChange={(event) =>
                        setMonthDay(Number(event.target.value))
                      }
                    />
                  </label>
                )}
                {monthlyKind === "nth_weekday" && (
                  <div className="recurrence-row">
                    <label>
                      Номер
                      <select
                        value={ordinal}
                        onChange={(event) =>
                          setOrdinal(Number(event.target.value))
                        }
                      >
                        <option value="1">Первый</option>
                        <option value="2">Второй</option>
                        <option value="3">Третий</option>
                        <option value="4">Четвёртый</option>
                        <option value="-1">Последний</option>
                      </select>
                    </label>
                    <label>
                      День
                      <select
                        value={monthWeekday}
                        onChange={(event) =>
                          setMonthWeekday(event.target.value as Weekday)
                        }
                      >
                        {Object.entries(weekdayLabels).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </>
            )}
            <label>
              Окончание
              <select
                value={endKind}
                onChange={(event) =>
                  setEndKind(event.target.value as typeof endKind)
                }
              >
                <option value="never">Никогда</option>
                <option value="until">До даты</option>
                <option value="count">После числа повторов</option>
              </select>
            </label>
            {endKind === "until" && (
              <label>
                Последняя дата
                <input
                  type="date"
                  required
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </label>
            )}
            {endKind === "count" && (
              <label>
                Количество
                <input
                  type="number"
                  min="1"
                  required
                  value={count}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              </label>
            )}
            <label>
              Часовой пояс
              <input
                required
                value={recurrenceTimezone}
                onChange={(event) => setRecurrenceTimezone(event.target.value)}
              />
            </label>
          </fieldset>
        )}
        <label>
          {resource === "event" ? "Длительность, минут" : "Оценка, минут"}
          <input
            type="number"
            min="1"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
        {resource === "event" && (
          <label>
            Место
            <input
              maxLength={500}
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
        )}
        {resource === "task" && (
          <label>
            Статус
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as "open" | "completed")
              }
            >
              <option value="open">Открыта</option>
              <option value="completed">Выполнена</option>
            </select>
          </label>
        )}
        <label>
          Описание
          <textarea
            maxLength={10000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="item-dialog-actions">
          {existing && (
            <button
              className="danger"
              type="button"
              disabled={saving}
              onClick={() => void remove()}
            >
              Удалить
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={saving}>
            {saving ? "Сохраняю…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}
