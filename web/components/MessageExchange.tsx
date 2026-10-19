import {
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
} from "lucide-react";
import { formatMessageTimestamp } from "../libs/format";
import type { AgentMessage } from "../types";
import { Alert, AlertDescription } from "./ui/alert";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { OperationReceipt } from "./OperationReceipt";
import { ReadCard } from "./ReadCard";

const pending = new Set(["queued", "transcribing", "processing"]);

function MessageTime({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const label = formatMessageTimestamp(value);
  return label ? (
    <time className={`text-[11px] leading-none ${className}`} dateTime={value}>
      {label}
    </time>
  ) : null;
}

export function MessageExchange({
  message,
  startNewConversation,
}: {
  message: AgentMessage;
  startNewConversation: () => void;
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
        <Card
          size="sm"
          className="bubble user relative ml-auto max-w-[82%] gap-0 rounded-br-sm bg-primary px-4 pt-3.5 pb-7 text-primary-foreground ring-primary/20"
        >
          <CardContent className="px-0 text-sm leading-relaxed whitespace-pre-wrap">
            {message.input_text}
          </CardContent>
          <MessageTime
            value={message.created_at}
            className="absolute right-4 bottom-2.5 text-primary-foreground/65"
          />
        </Card>
      )}
      {transcribing && (
        <div className="flex items-center gap-2 justify-self-start rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          Распознаю…
        </div>
      )}
      {showBot && (
        <Card
          size="sm"
          className="bubble bot relative flex max-w-[82%] flex-row items-start gap-3 rounded-bl-sm bg-muted/65 px-4 pt-3.5 pb-7 ring-border/60"
        >
          <Avatar size="sm" className="mt-0.5">
            <AvatarFallback className="bg-accent text-accent-foreground">
              <SparklesIcon aria-hidden="true" className="size-3.5" />
            </AvatarFallback>
          </Avatar>
          <CardContent className="grid min-w-0 flex-1 gap-1 px-0">
            {message.reply ? (
              <p className="text-sm leading-relaxed">{message.reply}</p>
            ) : message.input_text && pending.has(message.status) ? (
              <p className="text-sm text-muted-foreground">Думаю…</p>
            ) : null}
            {message.display_items.map((item) => (
              <ReadCard read={item} key={`${item.resource}-${item.id}`} />
            ))}
            {message.operations.map((item) => (
              <OperationReceipt item={item} key={item.id} />
            ))}
            {message.requires_new_conversation && (
              <Button
                className="mt-2 w-fit"
                onClick={startNewConversation}
              >
                <MessageSquarePlusIcon aria-hidden="true" />
                Начать новый диалог
              </Button>
            )}
            {message.error && (
              <Alert variant="destructive" className="mt-2 py-2">
                <AlertDescription>{message.error}</AlertDescription>
              </Alert>
            )}
            <MessageTime
              value={message.created_at}
              className="bot-time absolute bottom-2.5 left-4 text-muted-foreground"
            />
          </CardContent>
        </Card>
      )}
    </article>
  );
}
