import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentMessage, OpenAirStatus } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import { ChatComposer } from "./ChatComposer";
import { MessageExchange } from "./MessageExchange";

export function ChatView({
  messages,
  startNewConversation,
  recording,
  openAirEnabled,
  openAirStatus,
  openAirSilenceMs,
  onSendText,
  onToggleOpenAir,
  onChangeOpenAirSilence,
  onStartRecording,
  onStopRecording,
}: {
  messages: AgentMessage[];
  startNewConversation: () => void;
  recording: boolean;
  openAirEnabled: boolean;
  openAirStatus: OpenAirStatus;
  openAirSilenceMs: number;
  onSendText: (text: string) => Promise<void> | void;
  onToggleOpenAir: () => Promise<void> | void;
  onChangeOpenAirSilence: (value: number) => Promise<void> | void;
  onStartRecording: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStopRecording: () => void;
}) {
  const chat = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() =>
      chat.current?.scrollTo({
        top: chat.current.scrollHeight,
        behavior: "smooth",
      }),
    );
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {messages.length ? (
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="chat px-4 py-6 sm:px-8"
          viewportRef={chat}
          aria-live="polite"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {messages.map((message) => (
              <MessageExchange
                key={message.id}
                message={message}
                startNewConversation={startNewConversation}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center px-4 sm:px-8">
          <div className="mx-auto w-full max-w-3xl">
            <div className="max-w-xl border-l-2 border-accent py-2 pl-5">
              <p className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                Что на сегодня?
              </p>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                Напишите или произнесите задачу — я разложу её по дням, найду
                время и напомню о важном.
              </p>
              <p className="mt-6 max-w-md text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Например:</span>{" "}
                «Перенеси встречу с Анной на пятницу в 15:00».
              </p>
            </div>
          </div>
        </div>
      )}

      <ChatComposer
        recording={recording}
        openAirEnabled={openAirEnabled}
        openAirStatus={openAirStatus}
        openAirSilenceMs={openAirSilenceMs}
        onSendText={onSendText}
        onToggleOpenAir={onToggleOpenAir}
        onChangeOpenAirSilence={onChangeOpenAirSilence}
        onStartRecording={onStartRecording}
        onStopRecording={onStopRecording}
      />
    </div>
  );
}
