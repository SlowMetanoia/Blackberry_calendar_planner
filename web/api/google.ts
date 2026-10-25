import type { AuthResponse, GoogleIntegration } from "../types";
import { request, storeToken } from "./client";

export const GOOGLE_LOGIN_URL = "/api/auth/google/login";

export const getGoogleConfig = () =>
  request<{ enabled: boolean }>("/auth/google/config");

export async function exchangeGoogleLogin(code: string): Promise<string> {
  const data = await request<AuthResponse>("/auth/google/exchange", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  storeToken(data.access_token);
  return data.access_token;
}

export const getGoogleIntegration = () =>
  request<GoogleIntegration>("/integrations/google");
export const connectGoogleCalendar = () =>
  request<{ authorization_url: string }>("/integrations/google/connect", {
    method: "POST",
  });
export const syncGoogleCalendar = () =>
  request<{ status: string }>("/integrations/google/sync", { method: "POST" });
export const disconnectGoogleCalendar = () =>
  request<void>("/integrations/google", { method: "DELETE" });
