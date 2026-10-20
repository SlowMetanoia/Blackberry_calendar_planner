import { createStore } from "zustand/vanilla";
import {
  getUserPreferences,
  sendMessage,
  transcribeAudio,
  updateUserPreferences,
} from "../../api";
import { extractIvoryCommand, OpenAirCapture } from "../open-air";
import type { OpenAirStatus } from "../../types";
import type { SessionStore } from "./session-store";

export type VoiceState = {
  recording: boolean;
  openAirEnabled: boolean;
  openAirStatus: OpenAirStatus;
  openAirSilenceMs: number;
  loadPreferences: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleOpenAir: () => Promise<void>;
  stopOpenAir: () => void;
  changeOpenAirSilence: (value: number) => Promise<void>;
  dispose: () => void;
  reset: () => void;
};

export function createVoiceStore(session: SessionStore) {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let openAirCapture: OpenAirCapture | null = null;
  let openAirActive = false;
  let openAirGeneration = 0;
  let openAirQueue: Promise<void> = Promise.resolve();
  let discardRecording = false;

  return createStore<VoiceState>()((set, get) => {
    const stopOpenAir = () => {
      openAirGeneration++;
      openAirActive = false;
      openAirCapture?.stop();
      openAirCapture = null;
      set({ openAirEnabled: false, openAirStatus: "off" });
    };

    const processOpenAirPhrase = (audio: Blob, generation: number) => {
      openAirQueue = openAirQueue
        .catch(() => {})
        .then(async () => {
          try {
            if (!openAirActive || generation !== openAirGeneration) return;
            const command = extractIvoryCommand(await transcribeAudio(audio));
            if (
              !command ||
              !openAirActive ||
              generation !== openAirGeneration
            )
              return;
            const message = await sendMessage(
              command,
              session.getState().getConversationId(),
            );
            if (!openAirActive || generation !== openAirGeneration) return;
            void session
              .getState()
              .acceptMessage(message)
              .catch((error) =>
                session.getState().setError((error as Error).message),
              );
          } catch (error) {
            session.getState().setError((error as Error).message);
          } finally {
            if (openAirActive && generation === openAirGeneration)
              set({ openAirStatus: "listening" });
          }
        });
    };

    return {
      recording: false,
      openAirEnabled: false,
      openAirStatus: "off",
      openAirSilenceMs: 1500,

      loadPreferences: async () => {
        if (!session.getState().token) return;
        try {
          const preferences = await getUserPreferences();
          set({ openAirSilenceMs: preferences.open_air_silence_ms });
        } catch (error) {
          session.getState().setError((error as Error).message);
        }
      },

      startRecording: async () => {
        session.getState().setError("");
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          chunks = [];
          discardRecording = false;
          const media = new MediaRecorder(stream);
          recorder = media;
          media.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
          };
          media.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            set({ recording: false });
            if (discardRecording) {
              chunks = [];
              return;
            }
            void session
              .getState()
              .sendAudio(
                new Blob(chunks, {
                  type: media.mimeType || "audio/webm",
                }),
              );
          };
          media.start();
          set({ recording: true });
        } catch {
          session
            .getState()
            .setError("Не удалось получить доступ к микрофону");
        }
      },

      stopRecording: () => {
        if (recorder?.state === "recording") recorder.stop();
      },

      toggleOpenAir: async () => {
        if (openAirActive) {
          stopOpenAir();
          return;
        }
        session.getState().setError("");
        const generation = ++openAirGeneration;
        openAirActive = true;
        set({ openAirEnabled: true, openAirStatus: "starting" });
        const capture = new OpenAirCapture({
          silenceMs: get().openAirSilenceMs,
          onPhrase: (audio) => processOpenAirPhrase(audio, generation),
          onStatus: (status) => {
            if (openAirActive || status === "off")
              set({ openAirStatus: status });
          },
        });
        openAirCapture = capture;
        try {
          await capture.start();
        } catch {
          if (openAirCapture === capture) {
            stopOpenAir();
            session
              .getState()
              .setError(
                "Не удалось запустить open-air: проверьте доступ к микрофону",
              );
          }
        }
      },

      stopOpenAir,

      changeOpenAirSilence: async (value) => {
        const previous = get().openAirSilenceMs;
        set({ openAirSilenceMs: value });
        openAirCapture?.updateSilenceMs(value);
        try {
          const preferences = await updateUserPreferences({
            open_air_silence_ms: value,
          });
          set({ openAirSilenceMs: preferences.open_air_silence_ms });
        } catch (error) {
          set({ openAirSilenceMs: previous });
          openAirCapture?.updateSilenceMs(previous);
          session.getState().setError((error as Error).message);
        }
      },

      dispose: () => {
        openAirGeneration++;
        openAirActive = false;
        openAirCapture?.stop();
        openAirCapture = null;
      },

      reset: () => {
        stopOpenAir();
        discardRecording = true;
        if (recorder?.state === "recording") recorder.stop();
        recorder = null;
        chunks = [];
        set({ recording: false });
      },
    };
  });
}
