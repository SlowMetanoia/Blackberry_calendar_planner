import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSessionStore, useVoiceStore } from "../../libs/stores";
import { ScrollArea } from "../ui/scroll-area";
import { ChatComposer } from "./ChatComposer";
import { MessageExchange } from "./MessageExchange";

export function ChatView({
  startNewConversation,
}: {
  startNewConversation: () => void;
}) {
  const chat = useRef<HTMLDivElement | null>(null);
  const messages = useSessionStore((state) => state.messages);
  const sendText = useSessionStore((state) => state.sendText);
  const recording = useVoiceStore((state) => state.recording);
  const openAirEnabled = useVoiceStore((state) => state.openAirEnabled);
  const openAirStatus = useVoiceStore((state) => state.openAirStatus);
  const openAirSilenceMs = useVoiceStore((state) => state.openAirSilenceMs);
  const startRecording = useVoiceStore((state) => state.startRecording);
  const stopRecording = useVoiceStore((state) => state.stopRecording);
  const toggleOpenAir = useVoiceStore((state) => state.toggleOpenAir);
  const changeOpenAirSilence = useVoiceStore(
    (state) => state.changeOpenAirSilence,
  );

  const handleStartRecording = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      void startRecording();
    },
    [startRecording],
  );

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
        </div>
      )}

      <ChatComposer
        recording={recording}
        openAirEnabled={openAirEnabled}
        openAirStatus={openAirStatus}
        openAirSilenceMs={openAirSilenceMs}
        onSendText={sendText}
        onToggleOpenAir={toggleOpenAir}
        onChangeOpenAirSilence={changeOpenAirSilence}
        onStartRecording={handleStartRecording}
        onStopRecording={stopRecording}
      />
    </div>
  );
}
