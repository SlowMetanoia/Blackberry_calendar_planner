import { describe, expect, it } from "vitest";
import { SilenceSegmenter, extractIvoryCommand } from "../libs/open-air";

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
