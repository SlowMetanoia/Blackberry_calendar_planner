import { createStore } from "zustand/vanilla";
import { getUserPreferences, updateUserPreferences } from "../../api";
import type { OpenAirStatus, UserPreferences } from "../../types";
import { HandsFreeSession } from "../hands-free";
import type { SessionStore } from "./session-store";

type Voice = "aidar" | "baya" | "kseniya" | "xenia" | "eugene";

export type VoiceState = {
  recording: boolean;
  audioRequestPending: boolean;
  openAirEnabled: boolean;
  openAirStatus: OpenAirStatus;
  openAirSilenceMs: number;
  openAirActiveTimeoutSeconds: number;
  voiceOutputEnabled: boolean;
  ttsVoice: Voice;
  ttsSpeed: number;
  openAirDefault: boolean;
  mascotVisible: boolean;
  loadPreferences: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleOpenAir: () => Promise<void>;
  stopConversation: () => void;
  stopOpenAir: () => void;
  repeat: (messageId: string) => void;
  updateVoicePreferences: (data: Partial<UserPreferences>) => Promise<void>;
  changeOpenAirSilence: (value: number) => Promise<void>;
  dispose: () => void;
  reset: () => void;
};

export function createVoiceStore(session: SessionStore) {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let discardRecording = false;
  let handsFree: HandsFreeSession | null = null;

  return createStore<VoiceState>()((set, get) => {
    const stopOpenAir = () => {
      handsFree?.stop();
      handsFree = null;
      document.removeEventListener("visibilitychange", visibility);
      set({ openAirEnabled: false, openAirStatus: "off" });
    };

    const visibility = () => {
      if (!handsFree) return;
      if (document.hidden) handsFree.pause();
      else handsFree.resume();
    };

    const startHandsFree = async () => {
      if (handsFree) return;
      const current = new HandsFreeSession({
        silenceMs: get().openAirSilenceMs,
        activeTimeoutSeconds: get().openAirActiveTimeoutSeconds,
        onStatus: (openAirStatus) => set({ openAirStatus }),
        onTranscript: () => {},
        onMessage: (message) => session.getState().receiveMessage(message),
        onError: (message) => session.getState().setError(message),
      });
      handsFree = current;
      set({ openAirEnabled: true, openAirStatus: "armed" });
      document.addEventListener("visibilitychange", visibility);
      try {
        await current.start();
      } catch (error) {
        stopOpenAir();
        session.getState().setError((error as Error).message);
      }
    };

    const applyPreferences = (preferences: UserPreferences) =>
      set({
        openAirSilenceMs: preferences.open_air_silence_ms,
        openAirActiveTimeoutSeconds:
          preferences.open_air_active_timeout_seconds ?? 15,
        voiceOutputEnabled: preferences.voice_output_enabled ?? false,
        ttsVoice: preferences.tts_voice ?? "kseniya",
        ttsSpeed: preferences.tts_speed ?? 1,
        openAirDefault: preferences.open_air_default ?? false,
        mascotVisible: preferences.mascot_visible ?? true,
      });

    return {
      recording: false,
      audioRequestPending: false,
      openAirEnabled: false,
      openAirStatus: "off",
      openAirSilenceMs: 1500,
      openAirActiveTimeoutSeconds: 15,
      voiceOutputEnabled: false,
      ttsVoice: "kseniya",
      ttsSpeed: 1,
      openAirDefault: false,
      mascotVisible: true,

      loadPreferences: async () => {
        if (!session.getState().token) return;
        try {
          const preferences = await getUserPreferences();
          applyPreferences(preferences);
          if (preferences.open_air_default) await startHandsFree();
        } catch (error) {
          session.getState().setError((error as Error).message);
        }
      },

      startRecording: async () => {
        session.getState().setError("");
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
            set({ audioRequestPending: true });
            void session
              .getState()
              .sendAudio(new Blob(chunks, { type: media.mimeType || "audio/webm" }))
              .finally(() => set({ audioRequestPending: false }));
          };
          media.start();
          set({ recording: true });
        } catch {
          session.getState().setError("Не удалось получить доступ к микрофону");
        }
      },

      stopRecording: () => {
        if (recorder?.state === "recording") recorder.stop();
      },

      toggleOpenAir: async () => {
        if (handsFree) stopOpenAir();
        else await startHandsFree();
      },

      stopConversation: () => handsFree?.stopConversation(),
      stopOpenAir,
      repeat: (messageId) => handsFree?.repeat(messageId),

      updateVoicePreferences: async (data) => {
        const previous = {
          open_air_silence_ms: get().openAirSilenceMs,
          open_air_active_timeout_seconds: get().openAirActiveTimeoutSeconds,
          voice_output_enabled: get().voiceOutputEnabled,
          tts_voice: get().ttsVoice,
          tts_speed: get().ttsSpeed,
          open_air_default: get().openAirDefault,
          mascot_visible: get().mascotVisible,
        };
        applyPreferences({ timezone: "UTC", upcoming_days: 7, ...previous, ...data });
        if (data.open_air_active_timeout_seconds !== undefined) {
          handsFree?.updateActiveTimeout(data.open_air_active_timeout_seconds);
        }
        try {
          applyPreferences(await updateUserPreferences(data));
        } catch (error) {
          applyPreferences({ timezone: "UTC", upcoming_days: 7, ...previous });
          handsFree?.updateActiveTimeout(previous.open_air_active_timeout_seconds);
          session.getState().setError((error as Error).message);
        }
      },

      changeOpenAirSilence: async (value) => {
        handsFree?.updateSilenceMs(value);
        await get().updateVoicePreferences({ open_air_silence_ms: value });
      },

      dispose: () => {
        document.removeEventListener("visibilitychange", visibility);
        stopOpenAir();
      },

      reset: () => {
        document.removeEventListener("visibilitychange", visibility);
        stopOpenAir();
        discardRecording = true;
        if (recorder?.state === "recording") recorder.stop();
        recorder = null;
        chunks = [];
        set({ recording: false, audioRequestPending: false });
      },
    };
  });
}
