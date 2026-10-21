import type { ListeningState, OpenAirStatus } from "../types/open-air";

type SegmenterOptions = {
  silenceMs: number;
  voiceThreshold: number;
  maxSpeechMs: number;
};

export class SilenceSegmenter {
  private startedAt: number | null = null;
  private lastVoiceAt: number | null = null;

  constructor(private readonly options: SegmenterOptions) {}

  get isSpeaking() {
    return this.startedAt !== null;
  }

  setSilenceMs(value: number) {
    this.options.silenceMs = value;
  }

  observe(level: number, now: number): ListeningState {
    const voice = level >= this.options.voiceThreshold;
    if (this.startedAt === null) {
      if (!voice) return "idle";
      this.startedAt = now;
      this.lastVoiceAt = now;
      return "started";
    }
    if (voice) this.lastVoiceAt = now;
    const tooLong = now - this.startedAt >= this.options.maxSpeechMs;
    const silent =
      this.lastVoiceAt !== null &&
      now - this.lastVoiceAt >= this.options.silenceMs;
    if (tooLong || silent) {
      this.reset();
      return "finished";
    }
    return "speaking";
  }

  reset() {
    this.startedAt = null;
    this.lastVoiceAt = null;
  }
}

const wakeWord = /(^|[^\p{L}\p{N}_])(ivory|айвори|ивори)(?=$|[^\p{L}\p{N}_])/iu;

export function extractIvoryCommand(transcript: string): string | null {
  const match = wakeWord.exec(transcript.normalize("NFC"));
  if (!match) return null;
  const start = (match.index ?? 0) + match[1].length;
  return transcript.slice(start).trim() || null;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;

  return Math.sqrt(sum / samples.length);
}

function encodeWave(frames: Float32Array[], sampleRate: number): Blob {
  const length = frames.reduce((total, frame) => total + frame.length, 0),
    buffer = new ArrayBuffer(44 + length * 2),
    view = new DataView(buffer);

  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);

  let offset = 44;
  frames.forEach((frame) =>
    frame.forEach((sample) => {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(
        offset,
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
        true,
      );
      offset += 2;
    }),
  );

  return new Blob([buffer], { type: "audio/wav" });
}

export class OpenAirCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private segmenter: SilenceSegmenter | null = null;
  private preRoll: Float32Array[] = [];
  private phrase: Float32Array[] = [];
  private preRollSamples = 0;
  private stopped = true;

  constructor(
    private readonly options: {
      silenceMs: number;
      onPhrase: (audio: Blob) => void;
      onStatus: (status: OpenAirStatus) => void;
      voiceThreshold?: number;
      maxSpeechMs?: number;
      preRollMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;

    this.stopped = false;
    this.options.onStatus("starting");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (this.stopped) {
        this.stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.context = new AudioContext();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;

      this.segmenter = new SilenceSegmenter({
        silenceMs: this.options.silenceMs,
        voiceThreshold: this.options.voiceThreshold ?? 0.025,
        maxSpeechMs: this.options.maxSpeechMs ?? 30_000,
      });

      this.processor.onaudioprocess = (event) =>
        this.consume(event.inputBuffer.getChannelData(0));

      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);
      this.options.onStatus("listening");
    } catch (error) {
      this.stop();
      this.options.onStatus("error");
      throw error;
    }
  }

  updateSilenceMs(value: number) {
    this.options.silenceMs = value;
    this.segmenter?.setSilenceMs(value);
  }

  stop() {
    this.stopped = true;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();

    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    if (this.context && this.context.state !== "closed")
      void this.context.close();

    this.context = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.segmenter = null;
    this.preRoll = [];
    this.phrase = [];
    this.preRollSamples = 0;
    this.options.onStatus("off");
  }
  private consume(input: Float32Array) {
    if (this.stopped || !this.context || !this.segmenter) return;

    const frame = new Float32Array(input),
      wasSpeaking = this.segmenter.isSpeaking,
      event = this.segmenter.observe(
        rms(frame),
        this.context.currentTime * 1000,
      );

    if (!wasSpeaking) {
      this.preRoll.push(frame);
      this.preRollSamples += frame.length;
      const limit =
        (this.context.sampleRate * (this.options.preRollMs ?? 500)) / 1000;
      while (this.preRollSamples > limit && this.preRoll.length > 1)
        this.preRollSamples -= this.preRoll.shift()!.length;

      if (event === "started") {
        this.phrase = this.preRoll;
        this.preRoll = [];
        this.preRollSamples = 0;
        this.options.onStatus("hearing");
      }

      return;
    }
    this.phrase.push(frame);
    if (event !== "finished") return;

    const audio = encodeWave(this.phrase, this.context.sampleRate);
    this.phrase = [];
    this.options.onStatus("recognizing");
    this.options.onPhrase(audio);
  }
}
