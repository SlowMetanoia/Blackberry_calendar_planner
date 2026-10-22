import { FormEvent } from "react";
import { BellPlusIcon, Trash2Icon } from "lucide-react";
import type { CalendarEntry, CollisionReport, EditorState } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { CalendarItemFields } from "./CalendarItemFields";
import { useCalendarItemForm } from "../../libs/hooks/use-item-form";

export function CalendarItemDialog({
  state,
  onClose,
  onChanged,
  onError,
  onAddReminder,
  onCollisions,
}: {
  state: EditorState;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onAddReminder?: (entry: CalendarEntry) => void;
  onCollisions?: (report: CollisionReport) => void;
}) {
  const form = useCalendarItemForm({ state, onChanged, onError, onCollisions });

  async function submit(event: FormEvent) {
    event.preventDefault();
    await form.save();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        closeLabel="Закрыть форму"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto max-sm:max-h-[92dvh] sm:max-w-lg"
      >
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg sm:text-xl">
              {form.existing ? "Редактирование записи" : "Новая запись"}
            </DialogTitle>
          </DialogHeader>

          <CalendarItemFields form={form} />

          <div className="sticky bottom-0 z-10 mt-1 flex flex-col gap-2 border-t bg-popover/95 pt-3 pb-1 backdrop-blur sm:static sm:flex-row sm:flex-wrap sm:items-center sm:bg-transparent sm:pt-3 sm:pb-0">
            {form.existing && (
              <Button
                variant="destructive"
                type="button"
                className="w-full max-sm:h-11 sm:w-auto"
                disabled={form.saving}
                onClick={() => void form.remove()}
              >
                <Trash2Icon aria-hidden="true" />
                Удалить
              </Button>
            )}
            <span className="hidden flex-1 sm:block" />
            {state.entry?.startsAt && onAddReminder && <Button type="button" variant="outline" disabled={form.saving} onClick={()=>onAddReminder(state.entry!)}><BellPlusIcon aria-hidden="true"/>Добавить напоминание</Button>}
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="max-sm:h-11"
                onClick={onClose}
              >
                Отмена
              </Button>
              <Button
                type="submit"
                className="max-sm:h-11"
                disabled={form.saving}
              >
                {form.saving ? "Сохраняю…" : "Сохранить"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
