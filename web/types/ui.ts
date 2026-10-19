import type { CalendarEntry, Resource } from "./calendar";

export type EditorState = {
  resource: Resource;
  entry?: CalendarEntry;
  date?: string;
};
export type DayHover = { date: string; x: number; y: number };
export type PreviewAnchor = { x: number; y: number };
export type ResourceMetadataItem = { label?: string; value: string };
