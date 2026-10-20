import { formatSessionTimestamp } from "../../libs/format";
import type { ConversationSummary } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { EmptyState } from "../shared/EmptyState";

export function SessionHistoryDialog({
  open,
  onOpenChange,
  sessions,
  conversation,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: ConversationSummary[];
  conversation: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Закрыть историю сессий" className="sm:max-w-lg">
        <DialogHeader className="gap-1.5 pr-8">
          <DialogTitle className="text-lg sm:text-xl">История сессий</DialogTitle>
          <DialogDescription>
            Вернитесь к прошлому разговору или начните новый.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh] max-sm:max-h-[62dvh]">
          <div className="grid gap-1.5 pr-2">
            {sessions.map((session) => (
              <Button
                key={session.id}
                variant={conversation === session.id ? "secondary" : "ghost"}
                className="h-auto min-h-11 w-full justify-start px-3 py-2.5 text-left whitespace-normal"
                onClick={() => onSelect(session.id)}
              >
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="truncate text-sm font-medium">
                    {session.preview}
                  </span>
                  <time className="text-[11px] font-normal text-muted-foreground">
                    {formatSessionTimestamp(session.last_activity_at)}
                  </time>
                </span>
              </Button>
            ))}
            {!sessions.length && (
              <EmptyState
                title="Здесь появятся прошлые диалоги."
                className="min-h-0 flex-none py-6 pb-6"
              />
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
