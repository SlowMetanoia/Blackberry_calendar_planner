import { useEffect } from "react";
import { Undo2Icon, XIcon } from "lucide-react";
import type { TaskNotice as TaskNoticeState } from "../../libs/stores/session-store";
import { Button } from "../ui/button";

const NOTICE_TIMEOUT_MS = 8000;

export function TaskNotice({
  notice,
  onUndo,
  onDismiss,
}: {
  notice: TaskNoticeState | null;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      role="status"
      className="fixed bottom-[max(6.5rem,calc(env(safe-area-inset-bottom)+6.5rem))] left-1/2 z-[120] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl bg-popover py-1.5 pr-1.5 pl-3.5 text-sm text-popover-foreground shadow-lg ring-1 ring-border"
    >
      <span className="min-w-0 truncate">{notice.text}</span>
      {notice.operationId && (
        <Button variant="outline" size="sm" onClick={onUndo}>
          <Undo2Icon aria-hidden="true" />
          Вернуть
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Закрыть уведомление"
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
