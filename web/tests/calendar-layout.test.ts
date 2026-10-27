import { describe, expect, it } from "vitest";
import { lanesForWidth, layoutEntries } from "../components/calendar/WeekGrid";
import { placeDayPreview } from "../libs/calendar-utils";
import type { CalendarEntry } from "../types";

function event(id: string, startsAt: string, durationMinutes = 30): CalendarEntry {
  return { id, resource: "event", title: id, startsAt, durationMinutes };
}

describe("week layout", () => {
  it("keeps at most the allowed lanes and collapses the rest into a counter", () => {
    const crowded = Array.from({ length: 11 }, (_, index) =>
      event(`e${index}`, "2026-10-30T15:00:00", 30 + index * 10),
    );

    const layout = layoutEntries(crowded, 3);

    expect(layout.items).toHaveLength(2);
    expect(layout.items.every((item) => item.columns === 3)).toBe(true);
    expect(layout.overflow).toEqual([
      expect.objectContaining({ column: 2, columns: 3, start: 15 * 60 }),
    ]);
    expect(layout.overflow[0].entries).toHaveLength(9);
  });

  it("does not reserve a counter lane when everything fits", () => {
    const layout = layoutEntries(
      [
        event("a", "2026-10-30T10:00:00"),
        event("b", "2026-10-30T10:00:00"),
        event("c", "2026-10-30T12:00:00"),
      ],
      3,
    );
    expect(layout.overflow).toEqual([]);
    expect(layout.items.map((item) => item.columns)).toEqual([2, 2, 1]);
  });
});

describe("day preview placement", () => {
  const viewport = { width: 1280, height: 720 };
  const size = { width: 300, height: 346 };

  it("opens beside the hovered day without covering it", () => {
    const cell = { left: 650, right: 739, top: 589, bottom: 696 };
    const place = placeDayPreview(cell, size, viewport);

    expect(place.left).toBeGreaterThanOrEqual(cell.right);
    expect(place.top + size.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it("flips to the left side near the right edge of the screen", () => {
    const cell = { left: 1100, right: 1190, top: 200, bottom: 300 };
    const place = placeDayPreview(cell, size, viewport);

    expect(place.left + size.width).toBeLessThanOrEqual(cell.left);
    expect(place.top).toBe(200);
  });
});

describe("week lanes", () => {
  it("fits as many lanes as stay readable in the day column", () => {
    expect(lanesForWidth(128)).toBe(2);
    expect(lanesForWidth(200)).toBe(3);
    expect(lanesForWidth(330)).toBe(4);
    expect(lanesForWidth(90)).toBe(2);
  });
});
