import { useEffect, useRef, useState } from "react";

const IDLE_INTERVAL_MS = 30_000;
const FRAME_INTERVAL_MS = 180;
const idleFrames = [1, 2, 3, 1] as const;
const listenFrames = [1, 2, 3, 4, 5] as const;

export type MascotMode = "idle" | "listen" | "processing";

export function Mascot({ mode = "idle" }: { mode?: MascotMode }) {
  const [frame, setFrame] = useState(1);
  const [animation, setAnimation] = useState<"idle" | "listen" | "reverse">(
    "idle",
  );
  const previousMode = useRef<MascotMode>(mode);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let idleTimer: ReturnType<typeof setInterval> | undefined;

    const clearTimers = () => {
      if (timer) clearInterval(timer);
      if (idleTimer) clearInterval(idleTimer);
    };

    if (mode === "processing") {
      setAnimation("idle");
      setFrame(1);
    } else if (mode === "listen") {
      setAnimation("listen");
      setFrame(1);
      let index = 1;
      timer = setInterval(() => {
        if (index >= listenFrames.length) {
          if (timer) clearInterval(timer);
          timer = undefined;
          return;
        }
        setFrame(listenFrames[index]);
        index += 1;
      }, FRAME_INTERVAL_MS);
    } else if (previousMode.current !== "idle") {
      setAnimation("reverse");
      let index = listenFrames.length - 1;
      setFrame(listenFrames[index]);
      timer = setInterval(() => {
        index -= 1;
        if (index < 0) {
          if (timer) clearInterval(timer);
          timer = undefined;
          setAnimation("idle");
          setFrame(1);
          idleTimer = setInterval(() => {
            let idleIndex = 0;
            setFrame(idleFrames[idleIndex]);
            timer = setInterval(() => {
              idleIndex += 1;
              if (idleIndex >= idleFrames.length) {
                if (timer) clearInterval(timer);
                timer = undefined;
                return;
              }
              setFrame(idleFrames[idleIndex]);
            }, FRAME_INTERVAL_MS);
          }, IDLE_INTERVAL_MS);
          return;
        }
        setFrame(listenFrames[index]);
      }, FRAME_INTERVAL_MS);
    } else {
      setAnimation("idle");
      setFrame(1);
      idleTimer = setInterval(() => {
        let index = 0;
        setFrame(idleFrames[index]);
        timer = setInterval(() => {
          index += 1;
          if (index >= idleFrames.length) {
            if (timer) clearInterval(timer);
            timer = undefined;
            return;
          }
          setFrame(idleFrames[index]);
        }, FRAME_INTERVAL_MS);
      }, IDLE_INTERVAL_MS);
    }

    previousMode.current = mode;
    return clearTimers;
  }, [mode]);

  const folder =
    mode === "processing"
      ? "processing"
      : animation === "idle"
        ? "idle"
        : animation === "reverse"
          ? "listen"
          : "listen";

  return (
    <div
      className="pointer-events-none absolute bottom-20 left-3 hidden w-52 sm:block md:left-6 md:w-60"
      data-testid="blackberry-mascot"
      aria-hidden="true"
    >
      <img
        src={`/mascot/blackberry/${folder}/${frame}.png`}
        alt=""
        className="block h-auto w-full"
      />
    </div>
  );
}