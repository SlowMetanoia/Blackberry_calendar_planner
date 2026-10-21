import { describe, expect, it } from "vitest";
import { partitionUpcoming, toCalendarEntries } from "../libs/planner-data";
import type { Event, Task } from "../types";

const task = (overrides: Partial<Task>): Task => ({
  id: "t",
  owner_id: "u",
  title: "Задача",
  description: null,
  deadline: null,
  estimated_minutes: null,
  status: "open",
  ...overrides,
});
const event = (overrides: Partial<Event>): Event => ({
  id: "e",
  owner_id: "u",
  title: "Событие",
  description: null,
  starts_at: "2026-10-16T09:00:00Z",
  duration_minutes: null,
  location: null,
  ...overrides,
});

describe("planner calendar data", () => {
  it("maps dated open tasks and events to calendar entries", () => {
    const entries = toCalendarEntries(
      [
        task({ id: "open", deadline: "2026-10-16T08:00:00Z" }),
        task({
          id: "done",
          deadline: "2026-10-16T07:00:00Z",
          status: "completed",
        }),
        task({ id: "undated" }),
      ],
      [event({ id: "event" })],
    );
    expect(entries.map((item) => `${item.resource}:${item.id}`)).toEqual([
      "task:open",
      "event:event",
    ]);
  });

  it("separates overdue, upcoming, and undated open tasks", () => {
    const result = partitionUpcoming(
      [
        task({ id: "overdue", deadline: "2026-10-15T08:00:00Z" }),
        task({ id: "soon", deadline: "2026-10-16T08:00:00Z" }),
        task({ id: "late", deadline: "2026-10-30T08:00:00Z" }),
        task({ id: "undated" }),
        task({
          id: "done",
          deadline: "2026-10-16T07:00:00Z",
          status: "completed",
        }),
      ],
      [
        event({ id: "soon-event", starts_at: "2026-10-17T09:00:00Z" }),
        event({ id: "late-event", starts_at: "2026-11-01T09:00:00Z" }),
      ],
      new Date("2026-10-15T09:00:00Z"),
      7,
    );
    expect(result.overdue.map((item) => item.id)).toEqual(["overdue"]);
    expect(result.upcoming.map((item) => item.id)).toEqual([
      "soon",
      "soon-event",
    ]);
    expect(result.undated.map((item) => item.id)).toEqual(["undated"]);
  });
});
