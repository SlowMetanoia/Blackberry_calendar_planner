import { afterEach, describe, expect, it, vi } from "vitest";
import { SilenceSegmenter, extractIvoryCommand } from "../libs/open-air";
import {
  VOICE_CUES,
  InactivityTimer,
  createHandsFreeSegmenter,
  pcm16At16Khz,
  signalUtteranceEnd,
} from "../libs/hands-free";

describe("Ivory wake word", () => {
  it.each([
    ["Ivory, поставь встречу на пять", "Ivory, поставь встречу на пять"],
    ["мы потом решим, АЙВОРИ поставь встречу", "АЙВОРИ поставь встречу"],
    ["шум перед словом Ивори: напомни позвонить", "Ивори: напомни позвонить"],
  ])(
    "keeps the wake word and discards speech before it",
    (transcript, expected) => {
      expect(extractIvoryCommand(transcript)).toBe(expected);
    },
  );

  it.each(["ivorytower сделай задачу", "айворинка привет", "просто разговор"])(
    "does not match a partial or missing wake word",
    (transcript) => expect(extractIvoryCommand(transcript)).toBeNull(),
  );
});

describe("silence segmentation", () => {
  it("uses the hands-free microphone threshold", () => {
    const segmenter = createHandsFreeSegmenter(1500);

    expect(segmenter.observe(0.01, 0)).toBe("idle");
    expect(segmenter.observe(0.03, 100)).toBe("started");
    expect(segmenter.observe(0.01, 1599)).toBe("speaking");
    expect(segmenter.observe(0.01, 1600)).toBe("finished");
  });

  it("finishes speech after the configured silence", () => {
    const segmenter = new SilenceSegmenter({
      silenceMs: 1500,
      voiceThreshold: 0.03,
      maxSpeechMs: 30_000,
    });
    expect(segmenter.observe(0.01, 0)).toBe("idle");
    expect(segmenter.observe(0.05, 100)).toBe("started");
    expect(segmenter.observe(0.01, 1599)).toBe("speaking");
    expect(segmenter.observe(0.01, 1600)).toBe("finished");
    expect(segmenter.observe(0.01, 1700)).toBe("idle");
  });

  it("extends the phrase when speech resumes and enforces the maximum", () => {
    const segmenter = new SilenceSegmenter({
      silenceMs: 1000,
      voiceThreshold: 0.03,
      maxSpeechMs: 3000,
    });
    expect(segmenter.observe(0.05, 0)).toBe("started");
    expect(segmenter.observe(0.01, 900)).toBe("speaking");
    expect(segmenter.observe(0.05, 950)).toBe("speaking");
    expect(segmenter.observe(0.01, 1900)).toBe("speaking");
    expect(segmenter.observe(0.01, 1950)).toBe("finished");
    expect(segmenter.observe(0.05, 2000)).toBe("started");
    expect(segmenter.observe(0.05, 5000)).toBe("finished");
  });
});

describe("streaming PCM", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the active conversation to wake-word mode after its timeout", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = new InactivityTimer(onTimeout);

    timer.arm(15);
    vi.advanceTimersByTime(14_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    timer.arm(30);
    timer.clear();
    vi.advanceTimersByTime(30_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("uses distinguishable ready and command-finished cues", () => {
    expect(VOICE_CUES.ready).not.toEqual(VOICE_CUES.finished);
    expect(VOICE_CUES.ready.at(-1)).toBeGreaterThan(VOICE_CUES.ready[0]);
    expect(VOICE_CUES.finished.at(-1)).toBeLessThan(VOICE_CUES.finished[0]);
  });

  it("sends the phrase before optional audio feedback and ignores cue failure", async () => {
    const sent: string[] = [];
    let rejectCue: ((reason?: unknown) => void) | undefined;
    const cue = new Promise<void>((_resolve, reject) => {
      rejectCue = reject;
    });

    const result = signalUtteranceEnd(
      (payload) => sent.push(payload),
      () => cue,
    );

    expect(sent).toEqual([JSON.stringify({ type: "utterance_end" })]);
    rejectCue?.(new Error("audio playback was blocked"));
    await expect(result).resolves.toBeUndefined();
  });

  it("downsamples browser audio to mono PCM16 at 16 kHz", () => {
    const input = new Float32Array(480);
    input.fill(0.5);
    const pcm = new Int16Array(pcm16At16Khz(input, 48_000));
    expect(pcm).toHaveLength(160);
    expect(pcm[0]).toBeGreaterThan(16_000);
    expect(pcm[0]).toBeLessThan(16_500);
  });

  it("clamps samples before PCM encoding", () => {
    const pcm = new Int16Array(
      pcm16At16Khz(new Float32Array([2, -2]), 16_000),
    );
    expect(Array.from(pcm)).toEqual([32767, -32768]);
  });
});
