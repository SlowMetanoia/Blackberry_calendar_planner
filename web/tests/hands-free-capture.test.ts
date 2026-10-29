import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionStore } from "../libs/stores/session-store";
import { createVoiceStore } from "../libs/stores/voice-store";

vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  createVoiceSessionTicket: vi.fn(async () => ({ ticket: "test-ticket" })),
  voiceSessionUrl: vi.fn(() => "ws://localhost/voice"),
}));

const sockets: FakeSocket[] = [];
const worklets: FakeWorklet[] = [];

class FakeSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  constructor() {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {}
  state(state: string, phase?: string) {
    this.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "state", state, phase }),
    }));
  }
  frames() {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data));
  }
}

function audioNode() {
  return {
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    frequency: { value: 0 },
    start: vi.fn(),
    stop: vi.fn(),
  };
}

class FakeContext {
  sampleRate = 16_000;
  currentTime = 0;
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = audioNode;
  createGain = audioNode;
  createOscillator = audioNode;
  close = vi.fn(async () => {});
}

class FakeWorklet {
  port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = {
    onmessage: null,
  };
  constructor(private readonly context: FakeContext) {
    worklets.push(this);
  }
  connect = vi.fn();
  disconnect = vi.fn();
  feed(level: number, milliseconds: number) {
    this.context.currentTime = milliseconds / 1000;
    this.port.onmessage?.(new MessageEvent("message", {
      data: new Float32Array(160).fill(level),
    }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  worklets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("finishes wake-word and command audio after silence despite synchronous store updates", async () => {
  const session = createSessionStore();
  const voice = createVoiceStore(session);
  try {
    await voice.getState().toggleOpenAir();
    const capture = worklets[0];
    const socket = sockets[0];

    capture.feed(0.06, 0);
    expect(voice.getState().openAirStatus).toBe("hearing_wake");
    expect(session.getState().voiceTurnActive).toBe(true);
    capture.feed(0.06, 100);
    capture.feed(0, 1600);

    expect(socket.frames().map((frame) => frame.type)).toEqual([
      "utterance_start", "utterance_end",
    ]);
    expect(voice.getState().openAirStatus).toBe("recognizing_wake");

    socket.state("ready");
    await vi.advanceTimersByTimeAsync(200);
    expect(session.getState().voiceTurnActive).toBe(false);
    capture.feed(0.06, 2000);
    capture.feed(0.06, 2100);
    capture.feed(0, 3600);

    expect(socket.frames().map((frame) => frame.type)).toEqual([
      "utterance_start", "utterance_end",
      "utterance_start", "utterance_end",
    ]);
    expect(voice.getState().openAirStatus).toBe("processing");

    socket.state("armed");
    capture.feed(0.06, 4000);
    capture.feed(0, 5500);
    expect(socket.frames().filter((frame) => frame.type === "utterance_end"))
      .toHaveLength(3);
  } finally {
    voice.getState().dispose();
  }
});
