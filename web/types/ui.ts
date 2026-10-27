import type { CalendarEntry, Resource } from "./calendar";

export type PlannerView = "chat" | "calendar" | "history";
export type EditorState = {
  resource: Resource;
  entry?: CalendarEntry;
  date?: string;
  time?: string;
};
export type AnchorRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};
export type DayHover = { date: string; anchor: AnchorRect };
export type PreviewAnchor = { x: number; y: number };
export type ResourceMetadataItem = { label?: string; value: string };
