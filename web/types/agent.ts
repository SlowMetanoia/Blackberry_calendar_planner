import type { CalendarOperation, CollisionNotice } from "./calendar";

export type Status =
  | "queued"
  | "transcribing"
  | "processing"
  | "needs_clarification"
  | "completed"
  | "failed";
export type DisplayItem = {
  resource: string;
  id: string;
  data: Record<string, unknown>;
};
export type AgentMessage = {
  id: string;
  conversation_id: string;
  sequence: number;
  input_text: string | null;
  status: Status;
  reply: string | null;
  speech_text?: string | null;
  collision_notices?: CollisionNotice[];
  display_items: DisplayItem[];
  operations: CalendarOperation[];
  error: string | null;
  requires_new_conversation?: boolean;
  created_at: string;
};
export type ConversationSummary = {
  id: string;
  preview: string;
  created_at: string;
  last_activity_at: string;
};
