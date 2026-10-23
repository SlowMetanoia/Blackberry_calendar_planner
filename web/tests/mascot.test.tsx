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
      "/mascot/blackberry/idle/1.png",
    );
  });

  it("plays idle sprites 1, 2, 3, 1 after thirty seconds", () => {
    render(<Mascot />);

    act(() => vi.advanceTimersByTime(30_000));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/1.png",
    );
    act(() => vi.advanceTimersByTime(180));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/2.png",
    );
    act(() => vi.advanceTimersByTime(180));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/3.png",
    );
    act(() => vi.advanceTimersByTime(180));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/1.png",
    );
  });

  it("plays listen frames and uses processing frame", () => {
    const view = render(<Mascot mode="listen" />);

    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/listen/1.png",
    );
    act(() => vi.advanceTimersByTime(180 * 4));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/listen/5.png",
    );

    view.rerender(<Mascot mode="processing" />);
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/processing/1.png",
    );
  });

  it("plays listen frames backwards when returning to idle", () => {
    const view = render(<Mascot mode="listen" />);
    act(() => vi.advanceTimersByTime(180 * 4));

    view.rerender(<Mascot mode="idle" />);
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/listen/5.png",
    );
    act(() => vi.advanceTimersByTime(180));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/listen/4.png",
    );
    act(() => vi.advanceTimersByTime(180 * 4));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/1.png",
    );
  });

  it("switches directly from listen to processing without reverse animation", () => {
    const view = render(<Mascot mode="listen" />);
    act(() => vi.advanceTimersByTime(180 * 4));

    view.rerender(<Mascot mode="processing" />);
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/processing/1.png",
    );
  });

  it("returns through reverse listen after processing completes", () => {
    const view = render(<Mascot mode="processing" />);

    view.rerender(<Mascot mode="idle" />);
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/listen/5.png",
    );
    act(() => vi.advanceTimersByTime(180 * 5));
    expect(getMascotImage()).toHaveAttribute(
      "src",
      "/mascot/blackberry/idle/1.png",
    );
  });
});