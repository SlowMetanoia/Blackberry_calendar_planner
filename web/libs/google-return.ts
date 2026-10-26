export type GoogleReturn = {
  loginCode: string | null;
  error: string | null;
  connected: boolean;
};

const errorMessages: Record<string, string> = {
  state: "Сессия входа через Google устарела. Попробуйте ещё раз.",
  denied: "Доступ к Google не был предоставлен.",
  email_unverified: "Google не подтвердил адрес почты этого аккаунта.",
  linked_elsewhere:
    "Этот Google-аккаунт уже привязан к другому пользователю ежедневника.",
  calendar_scope:
    "Чтобы синхронизировать события, разрешите доступ к Google Календарю.",
  failed: "Не удалось связаться с Google. Попробуйте позже.",
};

export function googleErrorMessage(code: string): string {
  return errorMessages[code] ?? errorMessages.failed;
}

let consumed: GoogleReturn | null = null;

/**
 * Read the OAuth redirect result once and strip it from the address bar, so a
 * reload or a StrictMode re-render cannot replay the one-time login code.
 */
export function takeGoogleReturn(): GoogleReturn {
  if (consumed) return { loginCode: null, error: null, connected: false };
  const url = new URL(window.location.href);
  consumed = {
    loginCode: url.searchParams.get("google_login"),
    error: url.searchParams.get("google_error"),
    connected: url.searchParams.get("google") === "connected",
  };
  for (const key of ["google_login", "google_error", "google"])
    url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url.toString());
  return consumed;
}

export function resetGoogleReturnForTests() {
  consumed = null;
}
