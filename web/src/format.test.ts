import { describe, expect, it } from "vitest";
import { formatDuration, formatHistoryDate, formatHistoryTime, formatMessageTimestamp, formatSchedule, historyDateKey } from "./format";

describe("date and duration formatting", () => {
  it("shows only the local time for a message from today", () => {
    expect(formatMessageTimestamp(
      "2026-10-14T08:49:00Z",
      new Date("2026-10-14T12:00:00Z"),
      "Europe/Moscow",
    )).toBe("11:49");
  });

  it("adds the local date for a message from another day", () => {
    expect(formatMessageTimestamp(
      "2026-10-13T15:32:00Z",
      new Date("2026-10-14T12:00:00Z"),
      "Europe/Moscow",
    )).toBe("13.10.2026, 18:32");
  });

  it("uses the supplied timezone at the day boundary", () => {
    const now = new Date("2026-10-15T00:30:00Z");
    expect(formatMessageTimestamp("2026-10-14T22:30:00Z", now, "Europe/Moscow")).toBe("01:30");
    expect(formatMessageTimestamp("2026-10-14T22:30:00Z", now, "UTC")).toBe("14.10.2026, 22:30");
  });

  it("formats a scheduled event range and Russian duration", () => {
    expect(formatSchedule("2026-10-15T08:00:00Z", 90, "Europe/Moscow"))
      .toBe("15 октября 2026, 11:00–12:30");
    expect(formatDuration(90)).toBe("1 час 30 минут");
  });

  it("formats history date groups and action time in the supplied timezone", () => {
    expect(historyDateKey("2026-10-14T22:30:00Z", "Europe/Moscow")).toBe("2026-10-15");
    expect(formatHistoryDate("2026-10-14T22:30:00Z", "Europe/Moscow")).toBe("15 октября 2026");
    expect(formatHistoryTime("2026-10-14T22:30:00Z", "Europe/Moscow")).toBe("01:30");
  });

  it("does not expose invalid dates", () => {
    expect(formatMessageTimestamp("not-a-date", new Date(), "Europe/Moscow")).toBe("");
    expect(formatSchedule("not-a-date", null, "Europe/Moscow")).toBe("");
  });
});
