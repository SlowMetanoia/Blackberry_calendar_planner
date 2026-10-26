import type { Notification, Page } from "../types";
import { request } from "./client";

export type PushSubscriptionData = { endpoint: string; p256dh: string; auth: string };
export const getNotifications = (unread = false, limit = 100, offset = 0) => request<Page<Notification>>(`/notifications?unread=${unread}&limit=${limit}&offset=${offset}`);
export const markNotificationRead = (id: string) => request<Notification>(`/notifications/${id}/read`, {method:"PATCH"});
export const markAllNotificationsRead = () => request<void>("/notifications/read-all", {method:"POST"});
export const deleteNotification = (id: string) => request<void>(`/notifications/${id}`, {method:"DELETE"});
export const getPushConfig = () => request<{enabled: boolean; public_key: string | null}>("/notifications/push/config");
export const upsertPushSubscription = (data: PushSubscriptionData) => request<void>("/notifications/push/subscription", {method:"PUT", body:JSON.stringify(data)});
export const deletePushSubscription = (data: PushSubscriptionData) => request<void>("/notifications/push/subscription", {method:"DELETE", body:JSON.stringify(data)});
