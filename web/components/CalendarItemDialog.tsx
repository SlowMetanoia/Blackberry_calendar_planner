import { FormEvent, useState } from "react";
import { RepeatIcon, Trash2Icon } from "lucide-react";
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
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NativeSelect } from "./ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

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
          existing && key && scope === "occurrence" && state.entry?.recurring,
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        closeLabel="Закрыть форму"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader className="gap-1.5 pr-8">
            <Badge variant="secondary" className="w-fit">
              {existing ? "Запись календаря" : "Планирование"}
            </Badge>
            <DialogTitle className="text-xl">
              {existing ? "Редактирование записи" : "Новая запись"}
            </DialogTitle>
          </DialogHeader>

          {!existing && (
            <div className="grid gap-1.5">
              <Label>Тип</Label>
              <Tabs
                value={resource}
                onValueChange={(value) => setResource(value as Resource)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="event">Событие</TabsTrigger>
                  <TabsTrigger value="task">Задача</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          {existing && state.entry?.recurring && (
            <div className="grid gap-1.5">
              <Label htmlFor="calendar-scope">Изменить</Label>
              <NativeSelect
                id="calendar-scope"
                value={scope}
                onChange={(event) =>
                  setScope(event.target.value as "occurrence" | "series")
                }
              >
                <option value="occurrence">Только этот повтор</option>
                <option value="series">Этот и будущие повторы</option>
              </NativeSelect>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="calendar-title">Название</Label>
            <Input
              id="calendar-title"
              required
              maxLength={500}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="calendar-when">
              {resource === "event" ? "Начало" : "Дедлайн"}
            </Label>
            <Input
              id="calendar-when"
              type="datetime-local"
              required={resource === "event" || repeat !== "none"}
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="calendar-repeat">Повторять</Label>
            <NativeSelect
              id="calendar-repeat"
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
            </NativeSelect>
          </div>

          {repeat !== "none" && scope === "series" && (
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <RepeatIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                Настройки повтора
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="calendar-interval">Интервал</Label>
                <Input
                  id="calendar-interval"
                  type="number"
                  min="1"
                  required
                  value={interval}
                  onChange={(event) => setInterval(Number(event.target.value))}
                />
              </div>
              {repeat === "weekly" && (
                <div className="grid gap-1.5">
                  <Label>Дни недели</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(weekdayLabels) as Weekday[]).map((day) => (
                      <Label
                        key={day}
                        className="cursor-pointer gap-1.5 rounded-md border bg-card px-2 py-1 text-xs font-normal has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5"
                      >
                        <Checkbox
                          checked={weekdays.includes(day)}
                          onCheckedChange={() =>
                            setWeekdays((value) =>
                              value.includes(day)
                                ? value.filter((item) => item !== day)
                                : [...value, day],
                            )
                          }
                        />
                        {weekdayLabels[day]}
                      </Label>
                    ))}
                  </div>
                </div>
              )}
              {repeat === "monthly" && (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="calendar-monthly-kind">
                      Правило месяца
                    </Label>
                    <NativeSelect
                      id="calendar-monthly-kind"
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
                    </NativeSelect>
                  </div>
                  {monthlyKind === "day_of_month" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="calendar-month-day">Число</Label>
                      <Input
                        id="calendar-month-day"
                        type="number"
                        min="1"
                        max="31"
                        value={monthDay}
                        onChange={(event) =>
                          setMonthDay(Number(event.target.value))
                        }
                      />
                    </div>
                  )}
                  {monthlyKind === "nth_weekday" && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor="calendar-ordinal">Номер</Label>
                        <NativeSelect
                          id="calendar-ordinal"
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
                        </NativeSelect>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="calendar-month-weekday">День</Label>
                        <NativeSelect
                          id="calendar-month-weekday"
                          value={monthWeekday}
                          onChange={(event) =>
                            setMonthWeekday(event.target.value as Weekday)
                          }
                        >
                          {Object.entries(weekdayLabels).map(
                            ([value, label]) => (
                              <option value={value} key={value}>
                                {label}
                              </option>
                            ),
                          )}
                        </NativeSelect>
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="calendar-end-kind">Окончание</Label>
                <NativeSelect
                  id="calendar-end-kind"
                  value={endKind}
                  onChange={(event) =>
                    setEndKind(event.target.value as typeof endKind)
                  }
                >
                  <option value="never">Никогда</option>
                  <option value="until">До даты</option>
                  <option value="count">После числа повторов</option>
                </NativeSelect>
              </div>
              {endKind === "until" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="calendar-until">Последняя дата</Label>
                  <Input
                    id="calendar-until"
                    type="date"
                    required
                    value={until}
                    onChange={(event) => setUntil(event.target.value)}
                  />
                </div>
              )}
              {endKind === "count" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="calendar-count">Количество</Label>
                  <Input
                    id="calendar-count"
                    type="number"
                    min="1"
                    required
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value))}
                  />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="calendar-timezone">Часовой пояс</Label>
                <Input
                  id="calendar-timezone"
                  required
                  value={recurrenceTimezone}
                  onChange={(event) =>
                    setRecurrenceTimezone(event.target.value)
                  }
                />
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="calendar-duration">
              {resource === "event" ? "Длительность, минут" : "Оценка, минут"}
            </Label>
            <Input
              id="calendar-duration"
              type="number"
              min="1"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </div>

          {resource === "event" && (
            <div className="grid gap-1.5">
              <Label htmlFor="calendar-location">Место</Label>
              <Input
                id="calendar-location"
                maxLength={500}
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
            </div>
          )}

          {resource === "task" && (
            <div className="grid gap-1.5">
              <Label htmlFor="calendar-status">Статус</Label>
              <NativeSelect
                id="calendar-status"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as "open" | "completed")
                }
              >
                <option value="open">Открыта</option>
                <option value="completed">Выполнена</option>
              </NativeSelect>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="calendar-description">Описание</Label>
            <Textarea
              id="calendar-description"
              maxLength={10000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {existing && (
              <Button
                variant="destructive"
                type="button"
                disabled={saving}
                onClick={() => void remove()}
              >
                <Trash2Icon aria-hidden="true" />
                Удалить
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
