import { useCallback, useRef } from "react";
import type { TouchEvent } from "react";

type TouchStart = {
  x: number;
  y: number;
  time: number;
};

/**
 * Detects a deliberate horizontal swipe while leaving vertical page scrolling
 * to the browser. A click that follows a swipe is suppressed once, so tapping
 * still opens a day while swiping changes month or day.
 */
export function useHorizontalSwipe(
  onSwipe: (direction: 1 | -1) => void,
  {
    threshold = 48,
    maxDuration = 700,
    dominance = 1.2,
  }: { threshold?: number; maxDuration?: number; dominance?: number } = {},
) {
  const start = useRef<TouchStart | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | null>(null);

  const releaseSuppression = useCallback(() => {
    if (suppressTimer.current !== null) {
      window.clearTimeout(suppressTimer.current);
      suppressTimer.current = null;
    }
  }, []);

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      start.current = null;
      return;
    }
    const touch = event.touches[0];
    start.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  };

  const onTouchEnd = (event: TouchEvent) => {
    const origin = start.current;
    start.current = null;
    if (!origin) return;

    const touch = event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    const duration = Date.now() - origin.time;

    if (
      duration > maxDuration ||
      Math.abs(dx) < threshold ||
      Math.abs(dx) < Math.abs(dy) * dominance
    ) {
      return;
    }

    releaseSuppression();
    suppressClick.current = true;
    suppressTimer.current = window.setTimeout(() => {
      suppressClick.current = false;
      suppressTimer.current = null;
    }, 350);
    onSwipe(dx < 0 ? 1 : -1);
  };

  const onTouchCancel = () => {
    start.current = null;
  };

  const shouldIgnoreClick = useCallback(() => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    releaseSuppression();
    return true;
  }, [releaseSuppression]);

  return { onTouchStart, onTouchEnd, onTouchCancel, shouldIgnoreClick };
}
