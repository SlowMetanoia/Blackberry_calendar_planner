import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  operationSchedule,
  operationWords,
  resourceMetadata,
  stringField,
  undoWords,
} from "../libs/calendar-view";
import { formatHistoryTime } from "../libs/format";
import type { CalendarOperation, PreviewAnchor } from "../types";
import { Changes } from "./Changes";
import { Metadata } from "./Metadata";

export function HistoryItem({
  item,
  undo,
}: {
  item: CalendarOperation;
  undo: (id: string) => void;
}) {
  const data = item.after || item.before || {},
    title = stringField(data, "title") || item.target_id,
    scheduled = operationSchedule(item.resource, data);
  const [anchor, setAnchor] = useState<PreviewAnchor | null>(null),
    [position, setPosition] = useState<PreviewAnchor | null>(null);
  const itemRef = useRef<HTMLElement | null>(null),
    previewRef = useRef<HTMLDivElement | null>(null),
    lastPointerType = useRef("");
  const previewId = `history-preview-${item.id}`;
  const anchorToItem = () => {
    const rect = itemRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.right, y: rect.top });
  };

  useLayoutEffect(() => {
    if (!anchor || !previewRef.current) return;
    const margin = 8,
      offset = 12,
      rect = previewRef.current.getBoundingClientRect();
    let x = anchor.x + offset,
      y = anchor.y + offset;
    if (x + rect.width > window.innerWidth - margin)
      x = anchor.x - rect.width - offset;
    if (y + rect.height > window.innerHeight - margin)
      y = anchor.y - rect.height - offset;
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(
        margin,
        Math.min(y, window.innerHeight - rect.height - margin),
      ),
    });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!itemRef.current?.contains(event.target as Node)) setAnchor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [anchor]);

  const preview =
    anchor &&
    createPortal(
      <div
        id={previewId}
        ref={previewRef}
        role="tooltip"
        className="history-preview"
        style={{
          left: position?.x ?? anchor.x + 12,
          top: position?.y ?? anchor.y + 12,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <b>
          {operationWords[item.operation]}: {title}
        </b>
        <Metadata items={resourceMetadata(item.resource, data)} />
        {item.operation === "update" && <Changes changes={item.changes} />}
        <small>
          Источник: {item.origin}
          {item.reverts_operation_id ? " · компенсирующая операция" : ""}
        </small>
      </div>,
      document.body,
    );

  return (
    <article
      ref={itemRef}
      className={`history-item ${item.operation}`}
      tabIndex={0}
      aria-label={`${operationWords[item.operation]}: ${title}${scheduled ? `. ${scheduled}` : ""}`}
      aria-describedby={anchor ? previewId : undefined}
      onPointerDown={(event) => {
        lastPointerType.current = event.pointerType;
        if (!(event.target as HTMLElement).closest("button"))
          event.preventDefault();
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse")
          setAnchor({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" && anchor)
          setAnchor({ x: event.clientX, y: event.clientY });
      }}
      onPointerLeave={() => {
        if (!itemRef.current?.contains(document.activeElement)) setAnchor(null);
      }}
      onPointerUp={(event) => {
        if (
          event.pointerType !== "mouse" &&
          !(event.target as HTMLElement).closest("button")
        )
          setAnchor((current) =>
            current ? null : { x: event.clientX, y: event.clientY },
          );
      }}
      onFocus={() => {
        if (
          lastPointerType.current !== "touch" &&
          lastPointerType.current !== "pen"
        )
          anchorToItem();
        lastPointerType.current = "";
      }}
      onBlur={(event) => {
        if (!itemRef.current?.contains(event.relatedTarget as Node))
          setAnchor(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setAnchor(null);
          itemRef.current?.blur();
        }
      }}
    >
      <time dateTime={item.created_at}>
        {formatHistoryTime(item.created_at)}
      </time>
      <span className="history-copy">
        <span className="history-title">{title}</span>
        {scheduled && <small>{scheduled}</small>}
      </span>
      <button
        className="history-undo"
        aria-label={`Отменить ${undoWords[item.operation]}`}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          undo(item.id);
        }}
      >
        <span aria-hidden="true">↶</span>
        <span className="undo-label">Отменить {undoWords[item.operation]}</span>
      </button>
      {preview}
    </article>
  );
}
