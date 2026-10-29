import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { createSessionStore } from "../libs/stores/session-store";
import { createVoiceStore } from "../libs/stores/voice-store";
import { SpeechPlayer } from "../libs/speech-player";

vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  getMessageSpeech: vi.fn(),
  getUserPreferences: vi.fn(),
}));

const audios: FakeAudio[] = [];
class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    audios.push(this);
  }
  play = vi.fn(async () => {});
  pause = vi.fn();
}
beforeEach(() => {
  vi.resetAllMocks();
  audios.length = 0;
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(api.getMessageSpeech).mockResolvedValue(new Blob(["wav"]));
});
afterEach(() => vi.unstubAllGlobals());

it("repeats with Vika and automatic speech disabled without requesting a microphone", async () => {
  const session = createSessionStore();
  const voice = createVoiceStore(session);
  voice.setState({ voiceOutputEnabled: false });
  voice.getState().repeat("message-1");
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  expect(api.getMessageSpeech).toHaveBeenCalledWith(
    "message-1",
    expect.any(AbortSignal),
  );
  expect(voice.getState().openAirEnabled).toBe(false);
  expect(voice.getState().voiceOutputEnabled).toBe(false);
  audios[0].onended?.();
  voice.getState().dispose();
});

it("waits for a voice turn and plays repeat requests sequentially", async () => {
  const session = createSessionStore();
  const voice = createVoiceStore(session);
  session.getState().beginVoiceTurn();
  voice.getState().repeat("first");
  voice.getState().repeat("second");
  expect(api.getMessageSpeech).not.toHaveBeenCalled();
  session.getState().endVoiceTurn();
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  expect(api.getMessageSpeech).toHaveBeenCalledTimes(1);
  audios[0].onended?.();
  await vi.waitFor(() => expect(audios).toHaveLength(2));
  expect(api.getMessageSpeech).toHaveBeenLastCalledWith(
    "second",
    expect.any(AbortSignal),
  );
  audios[1].onended?.();
  voice.getState().dispose();
});

it("releases the queue after a synthesis error", async () => {
  const session = createSessionStore();
  const voice = createVoiceStore(session);
  vi.mocked(api.getMessageSpeech).mockRejectedValueOnce(
    new Error("TTS offline"),
  );
  voice.getState().repeat("unavailable");
  voice.getState().repeat("available");
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  expect(session.getState().error).toBe("TTS offline");
  audios[0].onended?.();
  voice.getState().dispose();
});

it("uses the new default but preserves an existing false preference", async () => {
  const session = createSessionStore();
  session.setState({ token: "token" });
  const voice = createVoiceStore(session);
  expect(voice.getState().voiceOutputEnabled).toBe(true);
  vi.mocked(api.getUserPreferences).mockResolvedValue({
    timezone: "UTC",
    upcoming_days: 7,
    open_air_silence_ms: 1500,
    voice_output_enabled: false,
  });
  await voice.getState().loadPreferences();
  expect(voice.getState().voiceOutputEnabled).toBe(false);
  voice.getState().dispose();
});

it("finishes the current automatic response before a repeat waiting for that turn", async () => {
  let turnActive = true;
  const player = new SpeechPlayer(
    (kind) => kind === "automatic" || !turnActive,
    () => {},
  );
  const manual = vi.fn(async () => new Blob(["manual"]));
  const pending = player.play(manual, "manual");
  const automatic = player.play(
    async () => new Blob(["automatic"]),
    "automatic",
  );
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  expect(manual).not.toHaveBeenCalled();
  audios[0].onended?.();
  await automatic;
  turnActive = false;
  player.kick();
  await vi.waitFor(() => expect(audios).toHaveLength(2));
  audios[1].onended?.();
  await pending;
});

it("waits for recording to finish before repeating", async () => {
  const session = createSessionStore();
  const voice = createVoiceStore(session);
  voice.setState({ recording: true });
  voice.getState().repeat("after-recording");
  expect(api.getMessageSpeech).not.toHaveBeenCalled();
  voice.setState({ recording: false });
  // Recording normally updates the session reservation as it finishes.
  session.getState().endVoiceTurn();
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  audios[0].onended?.();
  voice.getState().dispose();
});
