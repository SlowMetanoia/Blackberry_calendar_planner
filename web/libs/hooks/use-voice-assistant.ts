import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  getUserPreferences,
  sendMessage,
  transcribeAudio,
  updateUserPreferences,
} from "../../api";
import { extractIvoryCommand, OpenAirCapture } from "../open-air";
import type { AgentMessage, OpenAirStatus } from "../../types";

export function useVoiceAssistant({
  token,
  acceptMessage,
  getConversationId,
  onAudio,
  onError,
}: {
  token: string | null;
  acceptMessage: (message: AgentMessage) => Promise<void>;
  getConversationId: () => string | null;
  onAudio: (blob: Blob) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [openAirEnabled, setOpenAirEnabled] = useState(false);
  const [openAirStatus, setOpenAirStatus] = useState<OpenAirStatus>("off");
  const [openAirSilenceMs, setOpenAirSilenceMs] = useState(1500);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const openAirCapture = useRef<OpenAirCapture | null>(null);
  const openAirActive = useRef(false);
  const openAirGeneration = useRef(0);
  const openAirQueue = useRef<Promise<void>>(Promise.resolve());

  const stopOpenAir = useCallback(() => {
    openAirGeneration.current++;
    openAirActive.current = false;
    openAirCapture.current?.stop();
    openAirCapture.current = null;
    setOpenAirEnabled(false);
    setOpenAirStatus("off");
  }, []);

  useEffect(() => {
    if (!token) return;
    void getUserPreferences()
      .then((preferences) => setOpenAirSilenceMs(preferences.open_air_silence_ms))
      .catch((error) => onError((error as Error).message));
  }, [token, onError]);

  useEffect(() => () => openAirCapture.current?.stop(), []);

  const processOpenAirPhrase = useCallback(
    (audio: Blob, generation: number) => {
      openAirQueue.current = openAirQueue.current
        .catch(() => {})
        .then(async () => {
          try {
            if (
              !openAirActive.current ||
              generation !== openAirGeneration.current
            )
              return;
            const command = extractIvoryCommand(await transcribeAudio(audio));
            if (
              !command ||
              !openAirActive.current ||
              generation !== openAirGeneration.current
            )
              return;
            void acceptMessage(await sendMessage(command, getConversationId()));
          } catch (error) {
            onError((error as Error).message);
          } finally {
            if (
              openAirActive.current &&
              generation === openAirGeneration.current
            )
              setOpenAirStatus("listening");
          }
        });
    },
    [acceptMessage, getConversationId, onError],
  );

  const toggleOpenAir = useCallback(async () => {
    if (openAirActive.current) {
      stopOpenAir();
      return;
    }
    onError("");
    const generation = ++openAirGeneration.current;
    openAirActive.current = true;
    setOpenAirEnabled(true);
    setOpenAirStatus("starting");
    const capture = new OpenAirCapture({
      silenceMs: openAirSilenceMs,
      onPhrase: (audio) => processOpenAirPhrase(audio, generation),
      onStatus: (status) => {
        if (openAirActive.current || status === "off") setOpenAirStatus(status);
      },
    });
    openAirCapture.current = capture;
    try {
      await capture.start();
    } catch {
      if (openAirCapture.current === capture) {
        stopOpenAir();
        onError("Не удалось запустить open-air: проверьте доступ к микрофону");
      }
    }
  }, [onError, openAirSilenceMs, processOpenAirPhrase, stopOpenAir]);

  const changeOpenAirSilence = useCallback(
    async (value: number) => {
      const previous = openAirSilenceMs;
      setOpenAirSilenceMs(value);
      openAirCapture.current?.updateSilenceMs(value);
      try {
        const preferences = await updateUserPreferences({
          open_air_silence_ms: value,
        });
        setOpenAirSilenceMs(preferences.open_air_silence_ms);
      } catch (error) {
        setOpenAirSilenceMs(previous);
        openAirCapture.current?.updateSilenceMs(previous);
        onError((error as Error).message);
      }
    },
    [onError, openAirSilenceMs],
  );

  async function startRecording(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    onError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      const media = new MediaRecorder(stream);
      recorder.current = media;
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        void onAudio(
          new Blob(chunks.current, { type: media.mimeType || "audio/webm" }),
        );
      };
      media.start();
      setRecording(true);
    } catch {
      onError("Не удалось получить доступ к микрофону");
    }
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  return {
    recording,
    openAirEnabled,
    openAirStatus,
    openAirSilenceMs,
    startRecording,
    stopRecording,
    toggleOpenAir,
    stopOpenAir,
    changeOpenAirSilence,
  };
}
