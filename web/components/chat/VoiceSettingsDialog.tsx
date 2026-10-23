import { Settings2Icon } from "lucide-react";
import { useVoiceStore } from "../../libs/stores";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";

export function VoiceSettingsDialog() {
  const enabled = useVoiceStore((state) => state.voiceOutputEnabled);
  const voice = useVoiceStore((state) => state.ttsVoice);
  const speed = useVoiceStore((state) => state.ttsSpeed);
  const openAirDefault = useVoiceStore((state) => state.openAirDefault);
  const mascotVisible = useVoiceStore((state) => state.mascotVisible);
  const silence = useVoiceStore((state) => state.openAirSilenceMs);
  const activeTimeout = useVoiceStore(
    (state) => state.openAirActiveTimeoutSeconds,
  );
  const update = useVoiceStore((state) => state.updateVoicePreferences);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="icon-lg" aria-label="Настройки голоса">
          <Settings2Icon aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Настройки голоса</DialogTitle>
          <DialogDescription>
            Голосовой ответ работает только для новых ответов и не озвучивает историю сам.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={enabled}
              onCheckedChange={(value) =>
                void update({ voice_output_enabled: value === true })
              }
            />
            Озвучивать ответы
          </Label>
          <Label className="grid gap-1.5">
            Голос
            <NativeSelect
              value={voice}
              onChange={(event) =>
                void update({ tts_voice: event.target.value as typeof voice })
              }
            >
              <option value="kseniya">Ксения</option>
              <option value="xenia">Xenia</option>
              <option value="baya">Бая</option>
              <option value="aidar">Айдар</option>
              <option value="eugene">Евгений</option>
            </NativeSelect>
          </Label>
          <Label className="grid gap-1.5">
            Скорость: {speed.toFixed(2)}×
            <Input
              type="range"
              min="0.75"
              max="1.5"
              step="0.05"
              value={speed}
              onChange={(event) => void update({ tts_speed: Number(event.target.value) })}
            />
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={openAirDefault}
              onCheckedChange={(value) => void update({ open_air_default: value === true })}
            />
            Ждать «Айвори» после открытия
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={mascotVisible}
              onCheckedChange={(value) =>
                void update({ mascot_visible: value === true })
              }
            />
            Показывать маскота
          </Label>
          <Label className="grid gap-1.5">
            Пауза между фразами
            <NativeSelect
              value={silence}
              onChange={(event) =>
                void update({ open_air_silence_ms: Number(event.target.value) })
              }
            >
              <option value={1000}>1 секунда</option>
              <option value={1500}>1,5 секунды</option>
              <option value={2000}>2 секунды</option>
              <option value={3000}>3 секунды</option>
              <option value={5000}>5 секунд</option>
            </NativeSelect>
          </Label>
          <Label className="grid gap-1.5">
            Ожидание следующей команды
            <NativeSelect
              value={activeTimeout}
              onChange={(event) =>
                void update({
                  open_air_active_timeout_seconds: Number(event.target.value),
                })
              }
            >
              <option value={5}>5 секунд</option>
              <option value={10}>10 секунд</option>
              <option value={15}>15 секунд</option>
              <option value={30}>30 секунд</option>
              <option value={60}>60 секунд</option>
            </NativeSelect>
          </Label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
