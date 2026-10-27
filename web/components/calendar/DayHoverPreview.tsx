import { useLayoutEffect, useRef, useState } from "react";
import { placeDayPreview } from "../../libs/calendar-utils";
import type { AnchorRect, CalendarEntry } from "../../types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EntryDetails } from "./EntryDetails";

const PREVIEW_LIMIT = 4;

export function DayHoverPreview({
  date,
  entries,
  anchor,
}: {
  date: string;
  entries: CalendarEntry[];
  anchor: AnchorRect;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const label = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00`));

  // The height depends on the entries, so the place is computed after layout.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    setPosition(
      placeDayPreview(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, entries.length]);

  return (
    <Card
      ref={card}
      className="day-hover-preview fixed z-[110] max-h-[calc(100dvh-16px)] w-[300px] max-w-[calc(100vw-16px)] gap-2 overflow-hidden p-3 shadow-lg select-none"
      role="tooltip"
      // Purely informational: the pointer passes through to the days below.
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
        pointerEvents: "none",
      }}
    >
      <CardHeader className="gap-0 px-0">
        <CardTitle className="text-sm first-letter:uppercase">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-0">
        {entries.slice(0, PREVIEW_LIMIT).map((entry) => (
          <EntryDetails
            entry={entry}
            brief
            key={`${entry.resource}:${entry.occurrenceKey || entry.id}`}
          />
        ))}
        {entries.length > PREVIEW_LIMIT && (
          <small className="text-xs text-muted-foreground">
            Ещё {entries.length - PREVIEW_LIMIT}. Нажмите на день, чтобы
            увидеть все.
          </small>
        )}
      </CardContent>
    </Card>
  );
}
