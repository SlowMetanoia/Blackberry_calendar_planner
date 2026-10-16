import type { AgentMessage, CalendarOperation, ConversationSummary, Event, Page, Task, UserPreferences } from "./types";

const base = "/api";
export const TOKEN_KEY = "planner-token";
export const AUTH_EXPIRED_EVENT = "planner-auth-expired";
const authPaths = new Set(["/auth/login", "/auth/register"]);

export class AuthenticationRequiredError extends Error {}

export function getStoredToken():string|null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  const legacy = sessionStorage.getItem(TOKEN_KEY);
  if (!legacy) return null;
  localStorage.setItem(TOKEN_KEY, legacy);
  sessionStorage.removeItem(TOKEN_KEY);
  return legacy;
}

export function storeToken(token:string):void {
  localStorage.setItem(TOKEN_KEY, token);
  sessionStorage.removeItem(TOKEN_KEY);
}

export function clearStoredToken():void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(path:string, options:RequestInit = {}):Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (token && !authPaths.has(path)) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(base + path, {...options, headers});
  if (!response.ok) {
    const problem = await response.json().catch(() => ({detail:response.statusText}));
    if (response.status === 401 && token && !authPaths.has(path)) {
      if (localStorage.getItem(TOKEN_KEY) === token) {
        clearStoredToken();
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
      }
      throw new AuthenticationRequiredError("Сессия истекла или недействительна. Войдите снова.");
    }
    throw new Error(problem.detail || "Request failed");
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const getMessage = (id:string) => request<AgentMessage>(`/agent/messages/${id}`);
export const getConversationHistory = (id:string, limit=100, offset=0) => request<Page<AgentMessage>>(`/agent/conversations/${id}/messages?limit=${limit}&offset=${offset}`);
export const getConversations = (limit=100, offset=0) => request<Page<ConversationSummary>>(`/agent/conversations?limit=${limit}&offset=${offset}`);
export const getCalendarHistory = (limit=100, offset=0) => request<Page<CalendarOperation>>(`/calendar/history?limit=${limit}&offset=${offset}`);
export const undoOperation = (id:string) => request<CalendarOperation>(`/calendar/history/${id}/undo`, {method:"POST"});
export const logoutSession = () => request<void>("/auth/logout", {method:"POST"});
export const getUserPreferences = () => request<UserPreferences>("/users/me/preferences");
export const updateUserPreferences = (data:Partial<UserPreferences>) => request<UserPreferences>("/users/me/preferences", {method:"PATCH",body:JSON.stringify(data)});
export async function transcribeAudio(audio:Blob):Promise<string> {
  const body=new FormData();body.append("audio",audio,"open-air.wav");
  return (await request<{text:string}>("/audio/transcriptions",{method:"POST",body})).text;
}

function query(path:string,values:Record<string,string|number|undefined>):string {
  const params=new URLSearchParams();
  Object.entries(values).forEach(([key,value])=>{if(value!==undefined)params.set(key,String(value));});
  const encoded=params.toString();
  return encoded?`${path}?${encoded}`:path;
}

export type TaskListOptions={limit?:number;offset?:number;deadlineFrom?:string;deadlineTo?:string;status?:"open"|"completed";deadlinePresence?:"dated"|"undated"|"any"};
export type EventListOptions={limit?:number;offset?:number;startsAtFrom?:string;startsAtTo?:string};
export const getTasks = (options:TaskListOptions={}) => request<Page<Task>>(query("/tasks",{limit:options.limit??100,offset:options.offset??0,deadline_from:options.deadlineFrom,deadline_to:options.deadlineTo,status:options.status,deadline_presence:options.deadlinePresence}));
export const getEvents = (options:EventListOptions={}) => request<Page<Event>>(query("/events",{limit:options.limit??100,offset:options.offset??0,starts_at_from:options.startsAtFrom,starts_at_to:options.startsAtTo}));
export const createTask = (data:Omit<Task,"id"|"owner_id">) => request<Task>("/tasks",{method:"POST",body:JSON.stringify(data)});
export const updateTask = (id:string,data:Partial<Omit<Task,"id"|"owner_id">>) => request<Task>(`/tasks/${id}`,{method:"PATCH",body:JSON.stringify(data)});
export const deleteTask = (id:string) => request<void>(`/tasks/${id}`,{method:"DELETE"});
export const createEvent = (data:Omit<Event,"id"|"owner_id">) => request<Event>("/events",{method:"POST",body:JSON.stringify(data)});
export const updateEvent = (id:string,data:Partial<Omit<Event,"id"|"owner_id">>) => request<Event>(`/events/${id}`,{method:"PATCH",body:JSON.stringify(data)});
export const deleteEvent = (id:string) => request<void>(`/events/${id}`,{method:"DELETE"});
