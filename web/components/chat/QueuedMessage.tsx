import { useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  MicIcon,
  PencilIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useSessionStore } from "../../libs/stores";
import type { QueuedMessage as QueuedMessageItem } from "../../libs/stores/session-store";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Textarea } from "../ui/textarea";

const statusLabels: Record<QueuedMessageItem["status"], string> = {
  waiting: "В очереди",
  sending: "Отправляю…",
  editing: "Редактирование",
  failed: "Не отправлено",
};

function StatusIcon({ status }: { status: QueuedMessageItem["status"] }) {
  if (status === "sending")
    return <LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />;
  if (status === "failed")
    return <TriangleAlertIcon aria-hidden="true" className="size-3" />;
  return <ClockIcon aria-hidden="true" className="size-3" />;
}

function QueuedEditor({ item }: { item: QueuedMessageItem }) {
  const saveQueued = useSessionStore((state) => state.saveQueued);
  const cancelEditQueued = useSessionStore((state) => state.cancelEditQueued);
  const [draft, setDraft] = useState(item.text);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditQueued(item.localId);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveQueued(item.localId, draft);
    }
  }

  return (
    <div className="grid gap-2">
      <Textarea
        autoFocus
        aria-label="Текст сообщения в очереди"
        className="min-h-12 bg-card text-foreground"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => cancelEditQueued(item.localId)}
        >
          Отмена
        </Button>
        <Button size="sm" onClick={() => saveQueued(item.localId, draft)}>
          <CheckIcon aria-hidden="true" />
          Сохранить
        </Button>
      </div>
    </div>
  );
}

export function QueuedMessage({ item }: { item: QueuedMessageItem }) {
  const removeQueued = useSessionStore((state) => state.removeQueued);
  const editQueued = useSessionStore((state) => state.editQueued);
  const retryQueued = useSessionStore((state) => state.retryQueued);
  const editing = item.status === "editing";
  const changeable = item.status === "waiting" || item.status === "failed";

  return (
    <article
      aria-label={`Сообщение: ${statusLabels[item.status].toLowerCase()}`}
      className="queued-message grid justify-items-end gap-1"
    >
      <Card
        size="sm"
        className={`relative w-full max-w-[88%] gap-0 rounded-br-sm border border-dashed px-3.5 py-3 break-words ring-0 sm:max-w-[82%] sm:px-4 ${
          editing ? "min-w-[min(20rem,100%)] " : "w-auto min-w-[8.5rem] "
        }${
          item.status === "failed"
            ? "border-destructive/50 bg-destructive/5"
            : "border-primary/40 bg-primary/10"
        }`}
      >
        <CardContent className="min-w-0 px-0 text-sm leading-relaxed break-words whitespace-pre-wrap">
          {editing ? (
            <QueuedEditor item={item} />
          ) : item.kind === "audio" ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <MicIcon aria-hidden="true" className="size-3.5" />
              Голосовое сообщение
            </span>
          ) : (
            item.text
          )}
        </CardContent>
      </Card>
      {!editing && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span
            className={`inline-flex items-center gap-1 ${
              item.status === "failed" ? "text-destructive" : ""
            }`}
          >
            <StatusIcon status={item.status} />
            {statusLabels[item.status]}
          </span>
          {item.status === "failed" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Отправить снова"
              title="Отправить снова"
              onClick={() => retryQueued(item.localId)}
            >
              <RotateCwIcon aria-hidden="true" />
            </Button>
          )}
          {changeable && item.kind === "text" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Изменить сообщение"
              title="Изменить"
              onClick={() => editQueued(item.localId)}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
          )}
          {changeable && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Убрать из очереди"
              title="Убрать из очереди"
              onClick={() => removeQueued(item.localId)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
