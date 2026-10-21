import type { AgentMessage, CalendarOccurrence, CalendarOperation, ConversationSummary, CursorPage, Event, Notification, Page, Reminder, Task, UserPreferences } from "./types";

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
export const updateTask = (id:string,data:Partial<Omit<Task,"id"|"owner_id">>,effectiveFrom?:string) => request<Task>(query(`/tasks/${id}`,{effective_from_occurrence_key:effectiveFrom}),{method:"PATCH",body:JSON.stringify(data)});
export const deleteTask = (id:string) => request<void>(`/tasks/${id}`,{method:"DELETE"});
export const createEvent = (data:Omit<Event,"id"|"owner_id">) => request<Event>("/events",{method:"POST",body:JSON.stringify(data)});
export const updateEvent = (id:string,data:Partial<Omit<Event,"id"|"owner_id">>,effectiveFrom?:string) => request<Event>(query(`/events/${id}`,{effective_from_occurrence_key:effectiveFrom}),{method:"PATCH",body:JSON.stringify(data)});
export const deleteEvent = (id:string) => request<void>(`/events/${id}`,{method:"DELETE"});
export type ReminderListOptions={limit?:number;offset?:number;status?:Reminder["status"];remindFrom?:string;remindTo?:string};
export const getReminders=(options:ReminderListOptions={})=>request<Page<Reminder>>(query("/reminders",{limit:options.limit??100,offset:options.offset??0,status:options.status,remind_from:options.remindFrom,remind_to:options.remindTo}));
export const createReminder=(data:Omit<Reminder,"id"|"owner_id"|"status"|"cancelled_reason"|"fired_at"|"cancelled_at"|"created_at">)=>request<Reminder>("/reminders",{method:"POST",body:JSON.stringify(data)});
export const updateReminder=(id:string,data:Partial<Pick<Reminder,"title"|"description"|"remind_at"|"status"|"relative_offset_minutes">>)=>request<Reminder>(`/reminders/${id}`,{method:"PATCH",body:JSON.stringify(data)});
export const deleteReminder=(id:string)=>request<void>(`/reminders/${id}`,{method:"DELETE"});
export const getNotifications=(unread=false,limit=100,offset=0)=>request<Page<Notification>>(query("/notifications",{unread:unread?1:undefined,limit,offset}));
export const markNotificationRead=(id:string)=>request<Notification>(`/notifications/${id}/read`,{method:"PATCH"});
export const markAllNotificationsRead=()=>request<void>("/notifications/read-all",{method:"POST"});
export const deleteNotification=(id:string)=>request<void>(`/notifications/${id}`,{method:"DELETE"});
export const getPushConfig=()=>request<{enabled:boolean;public_key:string|null}>("/notifications/push/config");
export const upsertPushSubscription=(data:{endpoint:string;p256dh:string;auth:string})=>request<void>("/notifications/push/subscription",{method:"PUT",body:JSON.stringify(data)});
export const deletePushSubscription=(data:{endpoint:string;p256dh:string;auth:string})=>request<void>("/notifications/push/subscription",{method:"DELETE",body:JSON.stringify(data)});
export type OccurrenceListOptions={resource?:"all"|"task"|"event";seriesId?:string;from?:string;to?:string;status?:"open"|"completed";limit?:number;cursor?:string};
export const getOccurrences=(options:OccurrenceListOptions={})=>request<CursorPage<CalendarOccurrence>>(query("/calendar/occurrences",{resource:options.resource,series_id:options.seriesId,from:options.from,to:options.to,status:options.status,limit:options.limit??100,cursor:options.cursor}));
export const updateTaskOccurrence=(id:string,key:string,data:Partial<Omit<Task,"id"|"owner_id">>)=>request<CalendarOccurrence>(`/tasks/${id}/occurrences/${encodeURIComponent(key)}`,{method:"PATCH",body:JSON.stringify(data)});
export const deleteTaskOccurrence=(id:string,key:string)=>request<void>(`/tasks/${id}/occurrences/${encodeURIComponent(key)}`,{method:"DELETE"});
export const updateEventOccurrence=(id:string,key:string,data:Partial<Omit<Event,"id"|"owner_id">>)=>request<CalendarOccurrence>(`/events/${id}/occurrences/${encodeURIComponent(key)}`,{method:"PATCH",body:JSON.stringify(data)});
export const deleteEventOccurrence=(id:string,key:string)=>request<void>(`/events/${id}/occurrences/${encodeURIComponent(key)}`,{method:"DELETE"});
