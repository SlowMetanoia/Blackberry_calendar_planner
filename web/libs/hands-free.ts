import type { AgentMessage, OpenAirStatus } from "../types";
import {
  createVoiceSessionTicket,
  voiceSessionUrl,
  type VoiceServerEvent,
} from "../api";
import { SilenceSegmenter } from "./open-air";

export const HANDS_FREE_VOICE_THRESHOLD = 0.025;

export function createHandsFreeSegmenter(silenceMs: number) {
  return new SilenceSegmenter({
    silenceMs,
    voiceThreshold: HANDS_FREE_VOICE_THRESHOLD,
    maxSpeechMs: 60_000,
  });
}

function level(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function pcm16At16Khz(
  samples: Float32Array,
  sourceRate: number,
): ArrayBuffer {
  const ratio = sourceRate / 16_000;
  const output = new Int16Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let index = 0; index < output.length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += samples[cursor];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

export class HandsFreeCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private enabled = false;
  private segmenter: SilenceSegmenter;
  private preRoll: ArrayBuffer[] = [];
  private preRollBytes = 0;

  constructor(
    private readonly options: {
      silenceMs: number;
      onStart: () => void;
      onPcm: (pcm: ArrayBuffer) => void;
      onEnd: () => void;
    },
  ) {
    this.segmenter = createHandsFreeSegmenter(options.silenceMs);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/pcm-capture-worklet.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "pcm-capture");
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) =>
      this.consume(event.data);
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
    this.enabled = true;
  }

  setPaused(paused: boolean) {
    this.enabled = !paused;
    this.segmenter.reset();
    this.preRoll = [];
    this.preRollBytes = 0;
  }

  updateSilenceMs(value: number) {
    this.segmenter.setSilenceMs(value);
  }

  stop() {
    this.enabled = false;
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") void this.context.close();
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.sink = null;
  }

  private consume(samples: Float32Array) {
    if (!this.enabled || !this.context) return;
    const pcm = pcm16At16Khz(samples, this.context.sampleRate);
    const speaking = this.segmenter.isSpeaking;
    const result = this.segmenter.observe(
      level(samples),
      this.context.currentTime * 1000,
    );
    if (!speaking) {
      this.preRoll.push(pcm);
      this.preRollBytes += pcm.byteLength;
      while (this.preRollBytes > 16_000 && this.preRoll.length > 1)
        this.preRollBytes -= this.preRoll.shift()!.byteLength;
      if (result === "started") {
        this.options.onStart();
        this.preRoll.forEach(this.options.onPcm);
        this.preRoll = [];
        this.preRollBytes = 0;
      }
      return;
    }
    this.options.onPcm(pcm);
    if (result === "finished") this.options.onEnd();
  }
}

export const VOICE_CUES = {
  ready: [660, 880],
  finished: [440, 330],
} as const;

export class InactivityTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onTimeout: () => void) {}

  arm(seconds: number) {
    this.clear();
    this.handle = setTimeout(this.onTimeout, seconds * 1000);
  }

  clear() {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }
}

async function cueSequence(frequencies: readonly number[]) {
  const context = new AudioContext();
  frequencies.forEach((frequency, index) => {
    const start = context.currentTime + index * 0.1;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.08);
  });
  await new Promise((resolve) => setTimeout(resolve, frequencies.length * 100));
  await context.close();
}

export async function signalUtteranceEnd(
  send: (payload: string) => void,
  playCue: () => Promise<void> = () => cueSequence(VOICE_CUES.finished),
) {
  send(JSON.stringify({ type: "utterance_end" }));
  try {
    await playCue();
  } catch {
    // Browser audio feedback is optional and must never block speech delivery.
  }
}

export class HandsFreeSession {
  private socket: WebSocket | null = null;
  private capture: HandsFreeCapture | null = null;
  private playback: Promise<void> = Promise.resolve();
  private activeAudio: HTMLAudioElement | null = null;
  private status: OpenAirStatus = "off";
  private utterancePhase: "wake" | "command" | null = null;
  private readyTimeout = new InactivityTimer(() => {
    if (this.stopped || this.paused || this.status !== "ready") return;
    this.capture?.setPaused(true);
    this.socket?.send(JSON.stringify({ type: "stop" }));
  });
  private paused = false;
  private stopped = false;

  constructor(
    private readonly options: {
      silenceMs: number;
      activeTimeoutSeconds: number;
      onStatus: (status: OpenAirStatus) => void;
      onTranscript: (text: string) => void;
      onMessage: (message: AgentMessage) => void;
      onError: (message: string) => void;
    },
  ) {}

  async start() {
    this.stopped = false;
    this.status = "armed";
    const { ticket } = await createVoiceSessionTicket();
    const socket = new WebSocket(voiceSessionUrl(ticket));
    socket.binaryType = "blob";
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Не удалось открыть голосовую сессию"));
    });
    this.capture = new HandsFreeCapture({
      silenceMs: this.options.silenceMs,
      onStart: () => {
        this.clearReadyTimeout();
        this.utterancePhase = this.status === "armed" ? "wake" : "command";
        this.setStatus(
          this.utterancePhase === "wake" ? "hearing_wake" : "hearing_command",
        );
        socket.send(JSON.stringify({ type: "utterance_start", sample_rate: 16_000 }));
      },
      onPcm: (pcm) => socket.send(pcm),
      onEnd: () => {
        this.capture?.setPaused(true);
        const phase = this.utterancePhase;
        this.setStatus(phase === "wake" ? "recognizing_wake" : "processing");
        void signalUtteranceEnd(
          (payload) => socket.send(payload),
          phase === "command"
            ? () => cueSequence(VOICE_CUES.finished)
            : async () => undefined,
        );
      },
    });
    socket.onmessage = (event) => void this.receive(event);
    socket.onclose = () => {
      if (!this.stopped) this.options.onStatus("error");
      this.capture?.stop();
    };
    await this.capture.start();
  }

  updateSilenceMs(value: number) {
    this.capture?.updateSilenceMs(value);
  }

  updateActiveTimeout(value: number) {
    this.options.activeTimeoutSeconds = value;
    if (this.status === "ready" && !this.paused) this.armReadyTimeout();
  }

  pause() {
    this.paused = true;
    this.clearReadyTimeout();
    this.capture?.setPaused(true);
    this.options.onStatus("paused");
  }

  resume() {
    this.paused = false;
    if (this.status === "ready") void this.enterReady();
    else {
      this.capture?.setPaused(false);
      this.options.onStatus(this.status);
    }
  }

  stopConversation() {
    this.clearReadyTimeout();
    this.capture?.setPaused(true);
    this.socket?.send(JSON.stringify({ type: "stop" }));
  }

  repeat(messageId: string) {
    this.capture?.setPaused(true);
    this.socket?.send(JSON.stringify({ type: "repeat", message_id: messageId }));
  }

  stop() {
    this.stopped = true;
    this.clearReadyTimeout();
    this.capture?.stop();
    this.capture = null;
    this.socket?.close();
    this.socket = null;
    this.activeAudio?.pause();
    this.activeAudio = null;
    this.playback = Promise.resolve();
  }

  private async receive(event: MessageEvent) {
    if (this.stopped) return;
    if (event.data instanceof Blob) {
      this.playback = this.playback
        .then(() => this.playAudio(event.data))
        .catch((error) => this.options.onError((error as Error).message));
      return;
    }
    const message = JSON.parse(String(event.data)) as VoiceServerEvent;
    if (message.type === "state") {
      if (message.state === "armed") {
        this.utterancePhase = null;
        this.clearReadyTimeout();
        this.setStatus("armed");
        if (!this.paused) this.capture?.setPaused(false);
      } else if (message.state === "ready") {
        this.utterancePhase = null;
        await this.enterReady();
      } else if (message.state === "capturing") {
        this.utterancePhase = message.phase ?? "command";
        this.setStatus(
          this.utterancePhase === "wake" ? "hearing_wake" : "hearing_command",
        );
      } else if (message.state === "processing") {
        this.capture?.setPaused(true);
        this.setStatus(message.phase === "wake" ? "recognizing_wake" : "processing");
      } else if (message.state === "speaking") {
        this.capture?.setPaused(true);
        this.setStatus("speaking");
      }
    } else if (message.type === "transcript") {
      this.options.onTranscript(message.text);
    } else if (message.type === "message") {
      this.options.onMessage(message.message);
    } else if (message.type === "error" || message.type === "tts_unavailable") {
      this.options.onError(message.message);
    } else if (message.type === "playback_skipped") {
      this.socket?.send(JSON.stringify({ type: "playback_complete" }));
    } else if (message.type === "playback_ready") {
      await this.playAll();
      this.socket?.send(JSON.stringify({ type: "playback_complete" }));
    }
  }

  private async playAll() {
    await this.playback;
    this.playback = Promise.resolve();
  }

  private setStatus(status: OpenAirStatus) {
    this.status = status;
    if (!this.paused) this.options.onStatus(status);
  }

  private async enterReady() {
    this.clearReadyTimeout();
    this.setStatus("ready");
    this.capture?.setPaused(true);
    try {
      await cueSequence(VOICE_CUES.ready);
    } catch {
      // The state transition must work even when browser audio is blocked.
    }
    if (this.stopped || this.paused || this.status !== "ready") return;
    this.capture?.setPaused(false);
    this.armReadyTimeout();
  }

  private armReadyTimeout() {
    this.clearReadyTimeout();
    this.readyTimeout.arm(this.options.activeTimeoutSeconds);
  }

  private clearReadyTimeout() {
    this.readyTimeout.clear();
  }

  private async playAudio(blob: Blob) {
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      this.activeAudio = audio;
      await audio.play();
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Не удалось воспроизвести ответ"));
      });
    } finally {
      this.activeAudio = null;
      URL.revokeObjectURL(url);
    }
  }
}
