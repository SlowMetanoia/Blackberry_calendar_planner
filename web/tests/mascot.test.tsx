import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot } from "../components/chat/Mascot";

function getMascotImage() {
  return screen.getByTestId("blackberry-mascot").querySelector("img");
}

describe("Mascot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts on sprite 1", () => {
    render(<Mascot />);

    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/blackberry-idle-1.png",
    );
  });

  it("plays sprites 1, 2, 3, 1 after thirty seconds", () => {
    render(<Mascot />);

    act(() => vi.advanceTimersByTime(30_000));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/blackberry-idle-1.png",
    );
    act(() => vi.advanceTimersByTime(350));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/blackberry-idle-2.png",
    );
    act(() => vi.advanceTimersByTime(350));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/blackberry-idle-3.png",
    );
    act(() => vi.advanceTimersByTime(350));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/blackberry-idle-1.png",
    );
  });
});