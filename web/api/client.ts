const base = "/api";
export const TOKEN_KEY = "planner-token";
export const AUTH_EXPIRED_EVENT = "planner-auth-expired";
const authPaths = new Set(["/auth/login", "/auth/register"]);

export class AuthenticationRequiredError extends Error {}

export function getStoredToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  const legacy = sessionStorage.getItem(TOKEN_KEY);
  if (!legacy) return null;
  localStorage.setItem(TOKEN_KEY, legacy);
  sessionStorage.removeItem(TOKEN_KEY);
  return legacy;
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  sessionStorage.removeItem(TOKEN_KEY);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (token && !authPaths.has(path))
    headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(base + path, { ...options, headers });
  if (!response.ok) {
    const problem = await response
      .json()
      .catch(() => ({ detail: response.statusText }));
    if (response.status === 401 && token && !authPaths.has(path)) {
      if (localStorage.getItem(TOKEN_KEY) === token) {
        clearStoredToken();
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
      }
      throw new AuthenticationRequiredError(
        "Сессия истекла или недействительна. Войдите снова.",
      );
    }
    throw new Error(problem.detail || "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
