import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CollisionWarning } from "../components/calendar/CollisionWarning";
import type { CollisionReport } from "../types";
import * as api from "../api";
import { useCalendarItemForm } from "../libs/hooks/use-item-form";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("forwards the create response warning before closing the saved form", async () => {
  const report: CollisionReport = { checked_from: null, checked_to: null, groups: [{
    id: "pair", occurrences: [{ kind: "point",
      first: { series_id: "one", occurrence_key: "a", scheduled_at: "2026-10-25T12:00:00Z", data: { title: "First", duration_minutes: null } },
      second: { series_id: "two", occurrence_key: "b", scheduled_at: "2026-10-25T12:00:00Z", data: { title: "Second", duration_minutes: null } },
    }],
  }] };
  vi.spyOn(api, "createEvent").mockResolvedValue({ id: "two", owner_id: "owner", title: "Second",
    description: null, location: null, duration_minutes: null, starts_at: "2026-10-25T12:00:00Z", collision_report: report });
  const onChanged = vi.fn(async () => {});
  const onCollisions = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useCalendarItemForm({
    state: { resource: "event", date: "2026-10-25" }, onChanged, onCollisions, onError,
  }));
  await act(() => result.current.save());
  expect(onCollisions).toHaveBeenCalledWith(report);
  expect(onChanged).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it("shows a non-blocking saved warning, all recurrence dates and a close control", async () => {
  const pair = {
    first: { series_id: "one", occurrence_key: "a", scheduled_at: "2026-10-25T12:00:00Z",
      data: { title: "Политех", duration_minutes: 120 } },
    second: { series_id: "two", occurrence_key: "b", scheduled_at: "2026-10-25T13:00:00Z",
      data: { title: "Пара", duration_minutes: null } },
    kind: "point" as const,
  };
  const report: CollisionReport = { checked_from: null, checked_to: null,
    groups: [{ id: "collision", occurrences: [pair, {
      ...pair, first: { ...pair.first, occurrence_key: "next-a", scheduled_at: "2026-10-26T12:00:00Z" },
    }] }] };
  const close = vi.fn();
  render(<CollisionWarning report={report} onClose={close} />);
  expect(screen.getByText("Событие сохранено. Есть пересечения")).toBeInTheDocument();
  expect(screen.getAllByText(/длительность неизвестна/)).toHaveLength(2);
  await userEvent.click(screen.getByText(/Всего пересечений: 2/));
  expect(screen.getByText(/26 октября/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Закрыть предупреждение" }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Подтвердить" })).not.toBeInTheDocument();
});
