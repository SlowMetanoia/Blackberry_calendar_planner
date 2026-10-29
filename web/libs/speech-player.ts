export type SpeechKind = "manual" | "automatic";

type Playback = {
  kind: SpeechKind;
  load: (signal: AbortSignal) => Promise<Blob>;
  resolve: () => void;
  reject: (error: unknown) => void;
  controller: AbortController;
};

/** One audio output for manual repeats and hands-free responses. */
export class SpeechPlayer {
  private queue: Playback[] = [];
  private current: Playback | null = null;
  private audio: HTMLAudioElement | null = null;
  private finishAudio: (() => void) | null = null;

  constructor(
    private readonly canPlay: (kind: SpeechKind) => boolean,
    private readonly onBusy: (busy: boolean) => void,
  ) {}

  play(load: Playback["load"], kind: SpeechKind): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind,
        load,
        resolve,
        reject,
        controller: new AbortController(),
      });
      this.kick();
    });
  }

  kick() {
    if (this.current) return;
    // The current hands-free turn must finish before waiting manual repeats.
    const index = this.queue.findIndex((item) => this.canPlay(item.kind));
    if (index < 0) return;
    const [item] = this.queue.splice(index, 1);
    this.current = item;
    this.onBusy(true);
    void this.run(item);
  }

  cancel(kind?: SpeechKind) {
    this.queue = this.queue.filter((item) => {
      if (kind && item.kind !== kind) return true;
      item.resolve();
      return false;
    });
    if (this.current && (!kind || this.current.kind === kind)) {
      this.current.controller.abort();
      this.audio?.pause();
      this.finishAudio?.();
    }
  }

  private async run(item: Playback) {
    let url: string | undefined;
    try {
      const blob = await item.load(item.controller.signal);
      if (!item.controller.signal.aborted) {
        url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this.audio = audio;
        await new Promise<void>((resolve, reject) => {
          this.finishAudio = resolve;
          audio.onended = () => resolve();
          audio.onerror = () =>
            reject(new Error("Не удалось воспроизвести ответ"));
          void audio.play().catch(reject);
        });
      }
      item.resolve();
    } catch (error) {
      if (item.controller.signal.aborted) item.resolve();
      else item.reject(error);
    } finally {
      if (this.audio) {
        this.audio.onended = null;
        this.audio.onerror = null;
      }
      this.audio = null;
      this.finishAudio = null;
      if (url) URL.revokeObjectURL(url);
      this.current = null;
      this.onBusy(false);
      this.kick();
    }
  }
}
