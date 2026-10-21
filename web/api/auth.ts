import type { AuthResponse } from "../types";
import { request, storeToken } from "./client";

export async function authenticate(
  email: string,
  password: string,
  register = false,
): Promise<string> {
  const data = await request<AuthResponse>(
    register ? "/auth/register" : "/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
  );
  storeToken(data.access_token);
  return data.access_token;
}

export const logoutSession = () =>
  request<void>("/auth/logout", { method: "POST" });
