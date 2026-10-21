import type { TimezoneResponse, UserPreferences } from "../types";
import { request } from "./client";

export const getUserPreferences = () =>
  request<UserPreferences>("/users/me/preferences");
export const updateUserPreferences = (data: Partial<UserPreferences>) =>
  request<UserPreferences>("/users/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(data),
  });
export const syncTimeZone = (timezone: string) =>
  request<TimezoneResponse>("/users/me/timezone", {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  });
