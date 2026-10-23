import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { CalendarItemDialog } from "../components/calendar/CalendarItemDialog";
import type { CalendarEntry, Event } from "../types";

vi.mock("../api", () => ({
  createEvent: vi.fn(),
  createTask: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventOccurrence: vi.fn(),
  deleteTask: vi.fn(),
  deleteTaskOccurrence: vi.fn(),
  updateEvent: vi.fn(),
  updateEventOccurrence: vi.fn(),
  updateTask: vi.fn(),
  updateTaskOccurrence: vi.fn(),
}));

const event: Event = {
  id: "event-1",
  owner_id: "owner-1",
  title: "Планёрка",
  description: null,
  starts_at: "2030-01-01T10:00:00Z",
  duration_minutes: 60,
  location: null,
};

const entry: CalendarEntry = {
  id: event.id,
  resource: "event",
  title: event.title,
  startsAt: event.starts_at,
  durationMinutes: event.duration_minutes,
  event,
};

describe("calendar item deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.deleteEvent).mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("asks for confirmation in the app style instead of using window.confirm", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const changed = vi.fn(async () => {});

    render(
      <CalendarItemDialog
        state={{ resource: "event", entry }}
        onClose={vi.fn()}
        onChanged={changed}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));

    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Удалить «Планёрка»?");
    expect(confirmation).toHaveTextContent(
      "Запись будет удалена без возможности восстановления.",
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(api.deleteEvent).not.toHaveBeenCalled();

    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Отмена" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(api.deleteEvent).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Удалить",
      }),
    );

    await waitFor(() =>
      expect(api.deleteEvent).toHaveBeenCalledWith("event-1"),
    );
    expect(changed).toHaveBeenCalled();
  });
});
