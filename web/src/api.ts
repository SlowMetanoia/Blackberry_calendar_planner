import type { AgentMessage, CalendarOperation, ConversationSummary, Page } from "./types";

const base = "/api";
export async function request<T>(path:string, options:RequestInit = {}):Promise<T> {
  const token = sessionStorage.getItem("planner-token");
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(base + path, {...options, headers});
  if (!response.ok) {
    const problem = await response.json().catch(() => ({detail:response.statusText}));
    throw new Error(problem.detail || "Request failed");
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const getMessage = (id:string) => request<AgentMessage>(`/agent/messages/${id}`);
export const getConversationHistory = (id:string, limit=100, offset=0) => request<Page<AgentMessage>>(`/agent/conversations/${id}/messages?limit=${limit}&offset=${offset}`);
export const getConversations = (limit=100, offset=0) => request<Page<ConversationSummary>>(`/agent/conversations?limit=${limit}&offset=${offset}`);
export const getCalendarHistory = (limit=100, offset=0) => request<Page<CalendarOperation>>(`/calendar/history?limit=${limit}&offset=${offset}`);
export const undoOperation = (id:string) => request<CalendarOperation>(`/calendar/history/${id}/undo`, {method:"POST"});
