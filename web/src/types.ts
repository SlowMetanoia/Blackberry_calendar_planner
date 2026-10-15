export type Status = "queued" | "transcribing" | "processing" | "needs_clarification" | "completed" | "failed";
export type CalendarOperation = { id:string; sequence:number; command_id:string; ordinal:number; operation:"create"|"update"|"delete"; resource:"task"|"event"; target_id:string; before:Record<string,unknown>|null; after:Record<string,unknown>|null; changes:Record<string,{before:unknown;after:unknown}>; origin:"agent"|"rest"|"undo"; source_message_id:string|null; reverts_operation_id:string|null; created_at:string };
export type AgentMessage = { id:string; conversation_id:string; sequence:number; input_text:string|null; status:Status; reply:string|null; reads:Array<{resource:string; id:string; data:Record<string,unknown>}>; operations:CalendarOperation[]; error:string|null; requires_new_conversation?:boolean; created_at:string };
export type ConversationSummary = { id:string; preview:string; created_at:string; last_activity_at:string };
export type Page<T> = { items:T[]; total:number; limit:number; offset:number };
export type TaskStatus = "open" | "completed";
export type Task = { id:string; owner_id:string; title:string; description:string|null; deadline:string|null; estimated_minutes:number|null; status:TaskStatus };
export type Event = { id:string; owner_id:string; title:string; description:string|null; starts_at:string; duration_minutes:number|null; location:string|null };
export type UserPreferences = { timezone:string; upcoming_days:number };
export type CalendarEntry = {
  id:string;
  resource:"task"|"event";
  title:string;
  startsAt:string;
  durationMinutes:number|null;
  task?:Task;
  event?:Event;
};
