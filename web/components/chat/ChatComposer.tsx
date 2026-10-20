import {
  FormEvent,
  useState,
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

const openAirLabels: Record<OpenAirStatus, string> = {
  off: "Ivory выключена",
  starting: "Подключаю микрофон…",
  listening: "Слушаю «Ivory»",
  hearing: "Слышу речь…",
  recognizing: "Распознаю обращение…",
  error: "Open-air временно недоступен",
};

export function ChatComposer({
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
  const [text, setText] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const value = text;
    setText("");
    await onSendText(value);
  }

  return (
    <footer className="border-t bg-muted/30 px-4 py-3 sm:px-6">
      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          aria-label="Сообщение"
          placeholder="Напишите задачу или вопрос…"
          className="h-11 flex-1 bg-card"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="submit"
          size="icon-lg"
          aria-label="Отправить"
          className="shrink-0"
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={openAirEnabled ? "highlight" : "outline"}
          size="lg"
          className="shrink-0"
          aria-label={`${openAirEnabled ? "Выключить" : "Включить"} open-air режим Ivory`}
          aria-pressed={openAirEnabled}
          onClick={() => void onToggleOpenAir()}
        >
          <AudioLinesIcon aria-hidden="true" />
          Ivory
        </Button>
        <Button
          type="button"
          variant={recording ? "destructive" : "secondary"}
          size="icon-lg"
          className="mic shrink-0 touch-none"
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
      <div className="mt-2 flex min-h-5 flex-wrap items-center justify-end gap-3">
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
                className="h-7 text-xs"
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
