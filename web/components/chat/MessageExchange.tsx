import { LoaderCircleIcon } from "lucide-react";
import type { EntryRef } from "../../libs/entry-loader";
import type { AgentMessage } from "../../types";
import { BotMessage } from "./BotMessage";
import { UserMessage } from "./UserMessage";

const pending = new Set(["queued", "transcribing", "processing"]);

export function MessageExchange({
  message,
  startNewConversation,
  onOpenRecord,
}: {
  message: AgentMessage;
  startNewConversation: () => void;
  onOpenRecord?: (ref: EntryRef) => void;
}) {
  const transcribing = !message.input_text && pending.has(message.status);
  const showBot = Boolean(
    message.input_text ||
      message.reply ||
      message.display_items.length ||
      message.operations.length ||
      message.error ||
      message.requires_new_conversation,
  );

  return (
    <article className="exchange grid gap-3.5">
      {message.input_text && (
        <UserMessage
          text={message.input_text}
          createdAt={message.created_at}
        />
      )}
      {transcribing && (
        <div className="flex items-center gap-2 justify-self-start rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          Распознаю…
        </div>
      )}
      {showBot && (
        <BotMessage
          message={message}
          showThinking={Boolean(
            message.input_text && pending.has(message.status),
          )}
          startNewConversation={startNewConversation}
          onOpenRecord={onOpenRecord}
        />
      )}
    </article>
  );
}
