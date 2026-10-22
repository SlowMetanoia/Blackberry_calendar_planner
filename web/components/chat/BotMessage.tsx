import { MessageSquarePlusIcon, Volume2Icon } from "lucide-react";
import type { AgentMessage } from "../../types";
import { useVoiceStore } from "../../libs/stores";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { MessageTime } from "./MessageTime";
import { OperationReceipt } from "./OperationReceipt";
import { ReadCard } from "./ReadCard";

export function BotMessage({
  message,
  showThinking,
  startNewConversation,
}: {
  message: AgentMessage;
  showThinking: boolean;
  startNewConversation: () => void;
}) {
  return (
    <Card
      size="sm"
      className="bubble bot relative max-w-[88%] gap-0 rounded-bl-sm bg-muted/60 px-3.5 pt-3 pb-7 break-words ring-border/60 sm:max-w-[82%] sm:px-4 sm:pt-3.5"
    >
      <CardContent className="grid min-w-0 gap-1 px-0">
        {message.reply ? (
          <p className="text-sm leading-relaxed">{message.reply}</p>
        ) : showThinking ? (
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
            className="mt-2 w-fit max-sm:h-11"
            onClick={startNewConversation}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            Начать новый диалог
          </Button>
        )}
        {message.speech_text && <RepeatSpeechButton messageId={message.id} />}
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
  );
}

function RepeatSpeechButton({ messageId }: { messageId: string }) {
  const repeat = useVoiceStore((state) => state.repeat);
  const voiceConnected = useVoiceStore((state) => state.openAirEnabled);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mt-1 w-fit"
      disabled={!voiceConnected}
      onClick={() => repeat(messageId)}
    >
      <Volume2Icon aria-hidden="true" />
      Повторить
    </Button>
  );
}
