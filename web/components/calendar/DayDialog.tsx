import { CalendarPlusIcon, ListPlusIcon } from "lucide-react";
import type { CalendarEntry, Resource } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { EmptyState } from "../shared/EmptyState";
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
        className="max-h-[calc(100dvh-2rem)] gap-4 overflow-hidden max-sm:max-h-[92dvh] sm:max-w-xl"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg sm:text-xl">
            Дела на {label}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="max-sm:h-11"
            onClick={() => onCreate("event")}
          >
            <CalendarPlusIcon aria-hidden="true" />
            Событие
          </Button>
          <Button
            variant="outline"
            className="max-sm:h-11"
            onClick={() => onCreate("task")}
          >
            <ListPlusIcon aria-hidden="true" />
            Задача
          </Button>
        </div>
        <ScrollArea className="max-h-[55vh] max-sm:max-h-[60dvh]">
          <div className="grid gap-2 pr-2">
            {entries.map((entry) => (
              <Button
                variant="outline"
                className={`h-auto min-h-11 w-full justify-start border-l-[3px] px-3 py-2.5 text-left whitespace-normal ${
                  entry.resource === "event"
                    ? "border-l-chart-2/80"
                    : "border-l-primary/60"
                }`}
                key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
                onClick={() => onOpen(entry)}
              >
                <EntryDetails entry={entry} />
              </Button>
            ))}
            {!entries.length && (
              <EmptyState
                title="На этот день пока ничего не запланировано."
                className="min-h-0 flex-none py-6 pb-6"
              />
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
