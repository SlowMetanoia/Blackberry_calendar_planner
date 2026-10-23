import { AlertTriangleIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Удалить",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        closeLabel="Закрыть подтверждение"
        role="alertdialog"
        className="max-sm:gap-3 max-sm:pt-5 sm:max-w-sm"
      >
        <DialogHeader className="gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon aria-hidden="true" className="size-5" />
          </span>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="max-sm:h-11"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="max-sm:h-11"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Удаляю…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
