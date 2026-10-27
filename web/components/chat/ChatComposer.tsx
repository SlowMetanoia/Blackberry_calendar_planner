import {
  FormEvent,
  useState,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  MicIcon,
  SquareIcon,
} from "lucide-react";
import type { OpenAirStatus } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { VoiceSettingsDialog } from "./VoiceSettingsDialog";

const openAirLabels: Record<OpenAirStatus, string> = {
  off: "Вика выключена",
  armed: "Скажите «Вика»",
  hearing_wake: "Слышу обращение…",
  recognizing_wake: "Распознаю обращение «Вика»…",
  ready: "Скажите, что нужно сделать",
  hearing_command: "Слушаю команду…",
  processing: "Распознаю и думаю…",
  speaking: "Отвечаю…",
  paused: "Hands-free на паузе",
  error: "Open-air временно недоступен",
};

export function ChatComposer({
  recording,
  openAirEnabled,
  openAirStatus,
  openAirSilenceMs,
  onSendText,
  onToggleOpenAir,
  onStopConversation,
  onChangeOpenAirSilence,
  onStartRecording,
  onStopRecording,
  onTextActivity,
  onTextIdle,
}: {
  recording: boolean;
  openAirEnabled: boolean;
  openAirStatus: OpenAirStatus;
  openAirSilenceMs: number;
  onSendText: (text: string) => Promise<void> | void;
  onToggleOpenAir: () => Promise<void> | void;
  onStopConversation: () => void;
  onChangeOpenAirSilence: (value: number) => Promise<void> | void;
  onStartRecording: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStopRecording: () => void;
  onTextActivity: () => void;
  onTextIdle: () => void;
}) {
  const [text, setText] = useState("");
  const textIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function notifyTextActivity(value: string) {
    if (textIdleTimer.current) clearTimeout(textIdleTimer.current);
    if (!value.trim()) {
      onTextIdle();
      return;
    }
    onTextActivity();
    textIdleTimer.current = setTimeout(onTextIdle, 700);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const value = text;
    setText("");
    if (textIdleTimer.current) clearTimeout(textIdleTimer.current);
    onTextIdle();
    await onSendText(value);
  }

  return (
    <footer className="relative shrink-0 bg-background md:h-24 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-2.5 sm:pb-3">
      {/* Messages fade out above the composer instead of being cut by a line. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-full h-7 bg-gradient-to-b from-transparent to-background"
      />
      <form
        className="mx-auto flex w-full max-w-3xl items-center gap-1.5 sm:gap-2"
        onSubmit={submit}
      >
        <Input
          aria-label="Сообщение"
          placeholder="Задача или вопрос…"
          className="h-11 flex-1 bg-card sm:h-9"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            notifyTextActivity(e.target.value);
          }}
        />
        <Button
          type="submit"
          size="icon-lg"
          aria-label="Отправить"
          className="size-11 shrink-0 sm:size-9"
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
        {openAirEnabled && openAirStatus !== "armed" && (
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 sm:size-9"
            aria-label="Завершить hands-free диалог"
            onClick={onStopConversation}
          >
            <SquareIcon aria-hidden="true" />
          </Button>
        )}
        <VoiceSettingsDialog />
        <Button
          type="button"
          variant={openAirEnabled ? "highlight" : "outline"}
          size="lg"
          className="size-11 shrink-0 px-0 sm:size-9 sm:w-auto sm:px-2.5"
          aria-label={`${openAirEnabled ? "Выключить" : "Включить"} open-air режим Вика`}
          aria-pressed={openAirEnabled}
          onClick={() => void onToggleOpenAir()}
        >
          <AudioLinesIcon aria-hidden="true" />
          <span className="hidden sm:inline">Вика</span>
        </Button>
        <Button
          type="button"
          variant={recording ? "destructive" : "secondary"}
          size="icon-lg"
          className="mic size-11 shrink-0 touch-none sm:size-9"
          disabled={openAirEnabled}
          aria-label="Удерживайте для записи"
          onPointerDown={onStartRecording}
          onPointerUp={onStopRecording}
          onPointerCancel={onStopRecording}
        >
          {recording ? (
            <SquareIcon aria-hidden="true" />
          ) : (
            <MicIcon aria-hidden="true" />
          )}
        </Button>
      </form>
      <div className="mx-auto mt-1.5 flex min-h-5 w-full max-w-3xl flex-wrap items-center justify-end gap-x-3 gap-y-1 sm:mt-2">
        <small className="text-[11px] text-muted-foreground">
          {openAirEnabled
            ? openAirLabels[openAirStatus]
            : recording
              ? "Отпустите, чтобы отправить"
              : "Удерживайте микрофон для записи"}
        </small>
        {openAirEnabled && (
          <>
            <Label
              htmlFor="open-air-silence"
              className="text-[11px] text-muted-foreground"
            >
              Пауза
            </Label>
            <span className="w-[76px] shrink-0">
              <NativeSelect
                id="open-air-silence"
                aria-label="Пауза перед отправкой"
                className="h-9 text-xs sm:h-7"
                value={openAirSilenceMs}
                onChange={(event) =>
                  void onChangeOpenAirSilence(Number(event.target.value))
                }
              >
                <option value={1000}>1 с</option>
                <option value={1500}>1,5 с</option>
                <option value={2000}>2 с</option>
                <option value={3000}>3 с</option>
                <option value={5000}>5 с</option>
              </NativeSelect>
            </span>
          </>
        )}
      </div>
    </footer>
  );
}
