import { RepeatIcon } from "lucide-react";
import type { Weekday } from "../../types";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { weekdayLabels, type RecurrenceDraft } from "../../libs/item-form";

export function RecurrenceFields({
  draft,
  onChange,
}: {
  draft: RecurrenceDraft;
  onChange: (patch: Partial<RecurrenceDraft>) => void;
}) {
  if (draft.repeat === "none") return null;

  return (
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
          value={draft.interval}
          onChange={(event) => onChange({ interval: Number(event.target.value) })}
        />
      </div>
      {draft.repeat === "weekly" && (
        <div className="grid gap-1.5">
          <Label>Дни недели</Label>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(weekdayLabels) as Weekday[]).map((day) => (
              <Label
                key={day}
                className="cursor-pointer gap-1.5 rounded-md border bg-card px-2 py-1 text-xs font-normal has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5"
              >
                <Checkbox
                  checked={draft.weekdays.includes(day)}
                  onCheckedChange={() =>
                    onChange({
                      weekdays: draft.weekdays.includes(day)
                        ? draft.weekdays.filter((item) => item !== day)
                        : [...draft.weekdays, day],
                    })
                  }
                />
                {weekdayLabels[day]}
              </Label>
            ))}
          </div>
        </div>
      )}
      {draft.repeat === "monthly" && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="calendar-monthly-kind">Правило месяца</Label>
            <NativeSelect
              id="calendar-monthly-kind"
              value={draft.monthlyKind}
              onChange={(event) =>
                onChange({
                  monthlyKind: event.target.value as RecurrenceDraft["monthlyKind"],
                })
              }
            >
              <option value="day_of_month">Число месяца</option>
              <option value="nth_weekday">День недели по счёту</option>
              <option value="last_day">Последний день</option>
            </NativeSelect>
          </div>
          {draft.monthlyKind === "day_of_month" && (
            <div className="grid gap-1.5">
              <Label htmlFor="calendar-month-day">Число</Label>
              <Input
                id="calendar-month-day"
                type="number"
                min="1"
                max="31"
                value={draft.monthDay}
                onChange={(event) =>
                  onChange({ monthDay: Number(event.target.value) })
                }
              />
            </div>
          )}
          {draft.monthlyKind === "nth_weekday" && (
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="calendar-ordinal">Номер</Label>
                <NativeSelect
                  id="calendar-ordinal"
                  value={draft.ordinal}
                  onChange={(event) =>
                    onChange({ ordinal: Number(event.target.value) })
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
                  value={draft.monthWeekday}
                  onChange={(event) =>
                    onChange({ monthWeekday: event.target.value as Weekday })
                  }
                >
                  {Object.entries(weekdayLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
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
          value={draft.endKind}
          onChange={(event) =>
            onChange({
              endKind: event.target.value as RecurrenceDraft["endKind"],
            })
          }
        >
          <option value="never">Никогда</option>
          <option value="until">До даты</option>
          <option value="count">После числа повторов</option>
        </NativeSelect>
      </div>
      {draft.endKind === "until" && (
        <div className="grid gap-1.5">
          <Label htmlFor="calendar-until">Последняя дата</Label>
          <Input
            id="calendar-until"
            type="date"
            required
            value={draft.until}
            onChange={(event) => onChange({ until: event.target.value })}
          />
        </div>
      )}
      {draft.endKind === "count" && (
        <div className="grid gap-1.5">
          <Label htmlFor="calendar-count">Количество</Label>
          <Input
            id="calendar-count"
            type="number"
            min="1"
            required
            value={draft.count}
            onChange={(event) => onChange({ count: Number(event.target.value) })}
          />
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="calendar-timezone">Часовой пояс</Label>
        <Input
          id="calendar-timezone"
          required
          value={draft.timezone}
          onChange={(event) => onChange({ timezone: event.target.value })}
        />
      </div>
    </div>
  );
}
