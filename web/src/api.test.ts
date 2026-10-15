import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_EXPIRED_EVENT,
  AuthenticationRequiredError,
  TOKEN_KEY,
  request,
} from "./api";

describe("API authentication", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("clears a stored token and announces an authenticated 401", async () => {
    localStorage.setItem(TOKEN_KEY, "expired");
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired, {once:true});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({detail:"Invalid token"}),
      {status:401,headers:{"Content-Type":"application/json"}},
    )));

    await expect(request("/tasks")).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
  });

  it("announces only once when parallel requests receive 401", async () => {
    localStorage.setItem(TOKEN_KEY, "expired");
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({detail:"Invalid token"}),
      {status:401,headers:{"Content-Type":"application/json"}},
    ))));

    await Promise.allSettled([request("/tasks"), request("/events")]);
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  });

  it("keeps an invalid-credentials response on the login form", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired, {once:true});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({detail:"Invalid credentials"}),
      {status:401,headers:{"Content-Type":"application/json"}},
    )));

    await expect(request("/auth/login", {method:"POST"})).rejects.toThrow("Invalid credentials");
    expect(expired).not.toHaveBeenCalled();
  });
});
