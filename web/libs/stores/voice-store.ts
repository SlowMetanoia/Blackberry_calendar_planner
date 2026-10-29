import { createStore } from "zustand/vanilla";
import {
  getMessageSpeech,
  getUserPreferences,
  updateUserPreferences,
} from "../../api";
import type { OpenAirStatus, UserPreferences } from "../../types";
import { HandsFreeSession } from "../hands-free";
import { SpeechPlayer } from "../speech-player";
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
  let reservation: string | null = null;
  let stopRequested = false;
  let handsFree: HandsFreeSession | null = null;
  let playbackBusy = false;

  return createStore<VoiceState>()((set, get) => {
    const player = new SpeechPlayer(
      (kind) =>
        !get().recording &&
        !reservation &&
        (kind === "automatic" || !session.getState().voiceTurnActive),
      (busy) => {
        playbackBusy = busy;
        syncInput();
      },
    );
    const syncInput = () => {
      const state = session.getState();
      handsFree?.setInputBlocked?.(
        playbackBusy ||
          get().recording ||
          !!reservation ||
          state.queue.length > 0 ||
          state.messages.some((m) =>
            ["queued", "transcribing", "processing"].includes(m.status),
          ),
      );
      player.kick();
    };
    const reportError = (error: unknown) =>
      session.getState().setError((error as Error).message);
    const stopOpenAir = () => {
      const old = handsFree;
      handsFree = null;
      old?.stop();
      player.cancel("automatic");
      document.removeEventListener("visibilitychange", visibility);
      set({ openAirEnabled: false, openAirStatus: "off" });
      session.getState().endVoiceTurn();
    };
    const visibility = () => {
      if (document.hidden) handsFree?.pause();
      else handsFree?.resume();
    };
    const startHandsFree = async () => {
      if (handsFree) return;
      const version = session.getState().selectionVersion;
      const valid = () =>
        handsFree === current &&
        session.getState().selectionVersion === version;
      const current = new HandsFreeSession({
        silenceMs: get().openAirSilenceMs,
        activeTimeoutSeconds: get().openAirActiveTimeoutSeconds,
        getConversationId: () => session.getState().getConversationId(),
        beginTurn: () => valid() && session.getState().beginVoiceTurn(),
        playAudio: (blob) =>
          valid()
            ? player.play(async () => blob, "automatic")
            : Promise.resolve(),
        onStatus: (openAirStatus) => {
          if (!valid()) return;
          set({ openAirStatus });
          if (["armed", "ready", "off", "error"].includes(openAirStatus))
            session.getState().endVoiceTurn();
          syncInput();
        },
        onTranscript: () => {},
        onMessage: (message) => {
          if (valid()) session.getState().receiveMessage(message, version);
        },
        onError: (message) => {
          if (!valid()) return;
          session.getState().setError(message);
          session.getState().endVoiceTurn();
        },
      });
      handsFree = current;
      set({ openAirEnabled: true, openAirStatus: "armed" });
      document.addEventListener("visibilitychange", visibility);
      try {
        await current.start();
        if (valid()) syncInput();
      } catch (error) {
        if (valid()) {
          stopOpenAir();
          reportError(error);
        }
      }
    };
    const unsubscribe = session.subscribe((state, previous) => {
      if (state.selectionVersion !== previous.selectionVersion) {
        const restart = !!handsFree;
        stopOpenAir();
        player.cancel();
        if (reservation) {
          stopRequested = true;
          reservation = null;
          if (recorder?.state === "recording") recorder.stop();
          set({ recording: false });
        }
        if (restart && state.token) void startHandsFree();
      }
      syncInput();
    });
    const applyPreferences = (preferences: UserPreferences) =>
      set({
        openAirSilenceMs: preferences.open_air_silence_ms,
        openAirActiveTimeoutSeconds:
          preferences.open_air_active_timeout_seconds ?? 15,
        voiceOutputEnabled: preferences.voice_output_enabled ?? true,
        ttsVoice: preferences.tts_voice ?? "kseniya",
        ttsSpeed: preferences.tts_speed ?? 1,
        openAirDefault: preferences.open_air_default ?? false,
        mascotVisible: preferences.mascot_visible ?? true,
      });
    const reset = () => {
      // Releasing a voice reservation on logout must not send pending text.
      session.setState({ queue: [] });
      stopOpenAir();
      player.cancel();
      stopRequested = true;
      if (reservation) session.getState().cancelAudio(reservation);
      reservation = null;
      if (recorder?.state === "recording") recorder.stop();
      recorder = null;
      set({ recording: false, audioRequestPending: false });
    };
    return {
      recording: false,
      audioRequestPending: false,
      openAirEnabled: false,
      openAirStatus: "off",
      openAirSilenceMs: 1500,
      openAirActiveTimeoutSeconds: 15,
      voiceOutputEnabled: true,
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
          reportError(error);
        }
      },
      startRecording: async () => {
        if (reservation || recorder?.state === "recording" || handsFree) return;
        session.getState().setError("");
        player.cancel("manual");
        const id = session.getState().reserveAudio();
        reservation = id;
        stopRequested = false;
        syncInput();
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          if (stopRequested || reservation !== id) {
            stream.getTracks().forEach((track) => track.stop());
            session.getState().cancelAudio(id);
            if (reservation === id) reservation = null;
            syncInput();
            return;
          }
          const chunks: Blob[] = [];
          const media = new MediaRecorder(stream);
          recorder = media;
          media.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
          };
          media.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            const valid = reservation === id;
            if (valid) reservation = null;
            if (recorder === media) {
              recorder = null;
              set({ recording: false });
            }
            if (valid)
              session
                .getState()
                .finishAudio(
                  id,
                  new Blob(chunks, { type: media.mimeType || "audio/webm" }),
                );
            syncInput();
          };
          media.start();
          set({ recording: true });
        } catch {
          if (reservation === id) {
            reservation = null;
            session
              .getState()
              .setError("Не удалось получить доступ к микрофону");
          }
          session.getState().cancelAudio(id);
          syncInput();
        }
      },
      stopRecording: () => {
        stopRequested = true;
        if (recorder?.state === "recording") recorder.stop();
        else if (reservation) {
          const id = reservation;
          reservation = null;
          session.getState().cancelAudio(id);
          syncInput();
        }
      },
      toggleOpenAir: async () => {
        if (handsFree) stopOpenAir();
        else if (!reservation && !get().recording) await startHandsFree();
      },
      stopConversation: () => handsFree?.stopConversation(),
      stopOpenAir,
      repeat: (messageId) => {
        void player
          .play((signal) => getMessageSpeech(messageId, signal), "manual")
          .catch(reportError);
      },
      updateVoicePreferences: async (data) => {
        const previous: UserPreferences = {
          timezone: "UTC",
          upcoming_days: 7,
          open_air_silence_ms: get().openAirSilenceMs,
          open_air_active_timeout_seconds: get().openAirActiveTimeoutSeconds,
          voice_output_enabled: get().voiceOutputEnabled,
          tts_voice: get().ttsVoice,
          tts_speed: get().ttsSpeed,
          open_air_default: get().openAirDefault,
          mascot_visible: get().mascotVisible,
        };
        applyPreferences({ ...previous, ...data });
        if (data.open_air_active_timeout_seconds !== undefined)
          handsFree?.updateActiveTimeout(data.open_air_active_timeout_seconds);
        try {
          applyPreferences(await updateUserPreferences(data));
        } catch (error) {
          applyPreferences(previous);
          handsFree?.updateActiveTimeout(
            previous.open_air_active_timeout_seconds!,
          );
          reportError(error);
        }
      },
      changeOpenAirSilence: async (value) => {
        handsFree?.updateSilenceMs(value);
        await get().updateVoicePreferences({ open_air_silence_ms: value });
      },
      dispose: () => {
        unsubscribe();
        reset();
      },
      reset,
    };
  });
}
