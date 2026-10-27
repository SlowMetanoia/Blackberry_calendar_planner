import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  MessageSquarePlusIcon,
  MessagesSquareIcon,
} from "lucide-react";
import type { EntryRef } from "../../libs/entry-loader";
import {
  useSessionStore,
  useUiStore,
  useVoiceStore,
} from "../../libs/stores";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ChatComposer } from "./ChatComposer";
import type { MascotMode } from "./Mascot";
import { MessageExchange } from "./MessageExchange";
import { QueuedMessage } from "./QueuedMessage";

export function ChatView({
  startNewConversation,
  sessionCount,
  onOpenHistory,
  onMascotModeChange,
}: {
  startNewConversation: () => void;
  sessionCount: number;
  onOpenHistory: () => void;
  onMascotModeChange: (mode: MascotMode) => void;
}) {
  const chat = useRef<HTMLDivElement | null>(null);
  const messages = useSessionStore((state) => state.messages);
  const queue = useSessionStore((state) => state.queue);
  const openEntry = useUiStore((state) => state.openEntry);
  const openRecord = useCallback(
    (ref: EntryRef) => openEntry({ ref }),
    [openEntry],
  );
  const sendText = useSessionStore((state) => state.sendText);
  const recording = useVoiceStore((state) => state.recording);
  const audioRequestPending = useVoiceStore((state) => state.audioRequestPending);
  const openAirEnabled = useVoiceStore((state) => state.openAirEnabled);
  const openAirStatus = useVoiceStore((state) => state.openAirStatus);
  const openAirSilenceMs = useVoiceStore((state) => state.openAirSilenceMs);
  const startRecording = useVoiceStore((state) => state.startRecording);
  const stopRecording = useVoiceStore((state) => state.stopRecording);
  const toggleOpenAir = useVoiceStore((state) => state.toggleOpenAir);
  const stopConversation = useVoiceStore((state) => state.stopConversation);
  const changeOpenAirSilence = useVoiceStore(
    (state) => state.changeOpenAirSilence,
  );
  const [textActive, setTextActive] = useState(false);
  const pending =
    messages.some((message) =>
      ["queued", "transcribing", "processing"].includes(message.status),
    ) || queue.some((item) => item.status === "sending");
  const mascotMode: MascotMode =
    pending || audioRequestPending || openAirStatus === "processing"
      ? "processing"
      : recording ||
          ["hearing_wake", "recognizing_wake", "hearing_command"].includes(
            openAirStatus,
          ) ||
          textActive
        ? "listen"
        : "idle";

  useEffect(() => {
    onMascotModeChange(mascotMode);
  }, [mascotMode, onMascotModeChange]);

  const handleSendText = useCallback(
    async (text: string) => {
      setTextActive(false);
      await sendText(text);
    },
    [sendText],
  );

  const handleStartRecording = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      void startRecording();
    },
    [startRecording],
  );

  useEffect(() => {
    if (!messages.length && !queue.length) return;
    requestAnimationFrame(() =>
      chat.current?.scrollTo({
        top: chat.current.scrollHeight,
        behavior: "smooth",
      }),
    );
  }, [messages, queue.length]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2 md:hidden">
        <Button
          variant="outline"
          className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-xl px-3"
          onClick={onOpenHistory}
        >
          <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate text-[13px] font-medium">Диалоги</span>
          <span className="ml-auto min-w-6 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10.5px] font-medium tabular-nums text-muted-foreground">
            {sessionCount}
          </span>
        </Button>
        <Button
          variant="secondary"
          size="icon-lg"
          className="size-10 shrink-0 rounded-xl"
          aria-label="Новый диалог"
          onClick={startNewConversation}
        >
          <MessageSquarePlusIcon aria-hidden="true" />
        </Button>
      </div>

      {messages.length || queue.length ? (
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="chat px-3.5 py-4 sm:px-8 sm:py-6"
          viewportRef={chat}
          aria-live="polite"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 sm:gap-6">
            {messages.map((message) => (
              <MessageExchange
                key={message.id}
                message={message}
                startNewConversation={startNewConversation}
                onOpenRecord={openRecord}
              />
            ))}
            {queue.map((item) => (
              <QueuedMessage key={item.localId} item={item} />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10 md:hidden">
            <div className="grid max-w-[17rem] justify-items-center gap-2 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-accent/25 text-accent-foreground">
                <MessagesSquareIcon aria-hidden="true" className="size-5" />
              </span>
              <p className="font-heading text-base font-semibold">
                Начните диалог
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Напишите задачу или удерживайте микрофон, чтобы рассказать о
                планах голосом.
              </p>
            </div>
          </div>
          <div className="hidden min-h-0 flex-1 items-center justify-center px-6 pb-10 sm:px-8 md:flex" />
        </>
      )}

      <ChatComposer
        recording={recording}
        openAirEnabled={openAirEnabled}
        openAirStatus={openAirStatus}
        openAirSilenceMs={openAirSilenceMs}
        onSendText={handleSendText}
        onToggleOpenAir={toggleOpenAir}
        onStopConversation={stopConversation}
        onChangeOpenAirSilence={changeOpenAirSilence}
        onStartRecording={handleStartRecording}
        onStopRecording={stopRecording}
        onTextActivity={() => setTextActive(true)}
        onTextIdle={() => setTextActive(false)}
      />
    </div>
  );
}
