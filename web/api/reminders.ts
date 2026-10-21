import type { Page, Reminder } from "../types";
import { request } from "./client";

export type ReminderListOptions = { limit?: number; offset?: number; status?: Reminder["status"]; remindFrom?: string; remindTo?: string };
export const getReminders = (options: ReminderListOptions = {}) => {
  const params = new URLSearchParams({limit: String(options.limit ?? 100), offset: String(options.offset ?? 0)});
  if (options.status) params.set("status", options.status);
  if (options.remindFrom) params.set("remind_from", options.remindFrom);
  if (options.remindTo) params.set("remind_to", options.remindTo);
  return request<Page<Reminder>>(`/reminders?${params}`);
};
export const createReminder = (data: Omit<Reminder, "id" | "owner_id" | "status" | "cancelled_reason" | "fired_at" | "cancelled_at" | "created_at">) => request<Reminder>("/reminders", {method: "POST", body: JSON.stringify(data)});
export const updateReminder = (id: string, data: Partial<Pick<Reminder,"title" | "description" | "remind_at" | "status" | "relative_offset_minutes">>) => request<Reminder>(`/reminders/${id}`, {method:"PATCH", body:JSON.stringify(data)});
export const deleteReminder = (id: string) => request<void>(`/reminders/${id}`, {method:"DELETE"});
