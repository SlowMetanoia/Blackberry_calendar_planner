import type { Resource } from "../../types";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { RecurrenceFields } from "./RecurrenceFields";
import type { CalendarItemFormController } from "../../libs/hooks/use-item-form";
import type { RepeatFrequency } from "../../libs/item-form";

export function CalendarItemFields({
  form,
}: {
  form: CalendarItemFormController;
}) {
  return (
    <>
      {!form.existing && (
        <div className="grid gap-1.5">
          <Label>Тип</Label>
          <Tabs
            value={form.resource}
            onValueChange={(value) => form.setResource(value as Resource)}
          >
            <TabsList className="w-full max-sm:h-11">
              <TabsTrigger value="event">Событие</TabsTrigger>
              <TabsTrigger value="task">Задача</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {form.existing && form.recurring && (
        <div className="grid gap-1.5">
          <Label htmlFor="calendar-scope">Изменить</Label>
          <NativeSelect
            id="calendar-scope"
            value={form.scope}
            onChange={(event) =>
              form.setScope(event.target.value as "occurrence" | "series")
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
          value={form.title}
          onChange={(event) => form.setTitle(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="calendar-when">
          {form.resource === "event" ? "Начало" : "Дедлайн"}
        </Label>
        <Input
          id="calendar-when"
          type="datetime-local"
          required={form.resource === "event" || form.draft.repeat !== "none"}
          value={form.when}
          onChange={(event) => form.setWhen(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="calendar-repeat">Повторять</Label>
        <NativeSelect
          id="calendar-repeat"
          value={form.draft.repeat}
          disabled={form.scope === "occurrence" && form.recurring}
          onChange={(event) =>
            form.updateDraft({
              repeat: event.target.value as RepeatFrequency,
            })
          }
        >
          <option value="none">Не повторять</option>
          <option value="daily">Каждый день</option>
          <option value="weekly">Каждую неделю</option>
          <option value="monthly">Каждый месяц</option>
          <option value="yearly">Каждый год</option>
        </NativeSelect>
      </div>

      {form.draft.repeat !== "none" && form.scope === "series" && (
        <RecurrenceFields draft={form.draft} onChange={form.updateDraft} />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="calendar-duration">
          {form.resource === "event" ? "Длительность, минут" : "Оценка, минут"}
        </Label>
        <Input
          id="calendar-duration"
          type="number"
          min="1"
          value={form.duration}
          onChange={(event) => form.setDuration(event.target.value)}
        />
      </div>

      {form.resource === "event" && (
        <div className="grid gap-1.5">
          <Label htmlFor="calendar-location">Место</Label>
          <Input
            id="calendar-location"
            maxLength={500}
            value={form.location}
            onChange={(event) => form.setLocation(event.target.value)}
          />
        </div>
      )}

      {form.resource === "task" && (
        <div className="grid gap-1.5">
          <Label htmlFor="calendar-status">Статус</Label>
          <NativeSelect
            id="calendar-status"
            value={form.status}
            onChange={(event) =>
              form.setStatus(event.target.value as "open" | "completed")
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
          value={form.description}
          onChange={(event) => form.setDescription(event.target.value)}
        />
      </div>
    </>
  );
}
