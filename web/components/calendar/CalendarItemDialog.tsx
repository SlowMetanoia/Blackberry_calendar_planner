import { FormEvent } from "react";
import { Trash2Icon } from "lucide-react";
import type { EditorState } from "../../types";
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
}: {
  state: EditorState;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const form = useCalendarItemForm({ state, onChanged, onError });

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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader className="pr-8">
            <DialogTitle className="text-xl">
              {form.existing ? "Редактирование записи" : "Новая запись"}
            </DialogTitle>
          </DialogHeader>

          <CalendarItemFields form={form} />

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {form.existing && (
              <Button
                variant="destructive"
                type="button"
                disabled={form.saving}
                onClick={() => void form.remove()}
              >
                <Trash2Icon aria-hidden="true" />
                Удалить
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={form.saving}>
              {form.saving ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
