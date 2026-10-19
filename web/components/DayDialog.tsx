import { CalendarPlusIcon, ListPlusIcon } from "lucide-react";
import type { CalendarEntry, Resource } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        closeLabel="Закрыть дела на день"
        className="max-h-[calc(100dvh-2rem)] gap-4 overflow-hidden sm:max-w-xl"
      >
        <DialogHeader className="pr-8">
          <Badge variant="secondary" className="w-fit">
            День
          </Badge>
          <DialogTitle className="text-xl capitalize">
            Дела на {label}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={() => onCreate("event")}>
            <CalendarPlusIcon aria-hidden="true" />
            + Событие
          </Button>
          <Button variant="outline" onClick={() => onCreate("task")}>
            <ListPlusIcon aria-hidden="true" />
            + Задача
          </Button>
        </div>
        <ScrollArea className="max-h-[55vh]">
          <div className="grid gap-2 pr-2">
            {entries.map((entry) => (
              <Button
                variant="outline"
                className="h-auto w-full justify-start border-l-4 border-l-primary/70 px-3 py-2.5 text-left whitespace-normal"
                key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
                onClick={() => onOpen(entry)}
              >
                <EntryDetails entry={entry} />
              </Button>
            ))}
            {!entries.length && (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                На эту дату ничего нет. Добавьте событие или задачу.
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
