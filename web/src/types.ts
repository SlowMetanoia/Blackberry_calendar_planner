export type Status = "queued" | "transcribing" | "processing" | "needs_confirmation" | "needs_clarification" | "completed" | "failed";
export type Action = { id:string; ordinal:number; operation:string; resource:string; target_id:string|null; payload:Record<string,unknown>; status:string; result:Record<string,unknown>|null; error:string|null };
export type Plan = { id:string; status:string; actions:Action[]; expires_at:string|null };
export type AgentMessage = { id:string; conversation_id:string; sequence:number; input_text:string|null; status:Status; reply:string|null; reads:Array<{resource:string; id:string; data:Record<string,unknown>}>; plan_id:string|null; error:string|null; requires_new_conversation?:boolean; created_at:string };
export type Page<T> = { items:T[]; total:number; limit:number; offset:number };
