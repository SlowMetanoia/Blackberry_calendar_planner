import { useEffect, useState } from "react";

const ANIMATION_INTERVAL_MS = 30_000;
const FRAME_INTERVAL_MS = 350;
const frames = [1, 2, 3, 1] as const;

export function Mascot() {
  const [frame, setFrame] = useState(1);

  useEffect(() => {
    let frameTimer: ReturnType<typeof setInterval> | undefined;
    const animationTimer = setInterval(() => {
      let frameIndex = 0;
      setFrame(frames[frameIndex]);
      frameTimer = setInterval(() => {
        frameIndex += 1;
        if (frameIndex >= frames.length) {
          if (frameTimer) clearInterval(frameTimer);
          frameTimer = undefined;
          return;
        }
        setFrame(frames[frameIndex]);
      }, FRAME_INTERVAL_MS);
    }, ANIMATION_INTERVAL_MS);

    return () => {
      clearInterval(animationTimer);
      if (frameTimer) clearInterval(frameTimer);
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute bottom-20 left-3 hidden w-44 sm:block md:left-6 md:w-52"
      data-testid="blackberry-mascot"
      aria-hidden="true"
    >
      <img
        src={`/mascot/blackberry/idle/blackberry-idle-${frame}.png`}
        alt=""
        className="block h-auto w-full"
      />
    </div>
  );
}