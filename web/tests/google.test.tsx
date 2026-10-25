import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { LoginScreen } from "../components/auth/LoginScreen";
import { GoogleCalendarButton } from "../components/integrations/GoogleCalendarButton";
import {
  googleErrorMessage,
  resetGoogleReturnForTests,
  takeGoogleReturn,
} from "../libs/google-return";
import type { GoogleIntegration } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getGoogleConfig: vi.fn(),
    getGoogleIntegration: vi.fn(),
    connectGoogleCalendar: vi.fn(),
    syncGoogleCalendar: vi.fn(),
    disconnectGoogleCalendar: vi.fn(),
  };
});

const connected: GoogleIntegration = {
  available: true,
  linked: true,
  email: "person@gmail.com",
  calendar_enabled: true,
  sync_status: "ok",
  last_synced_at: "2030-01-01T10:00:00Z",
  last_error: null,
  skipped_events: 2,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Google sign-in", () => {
  it("offers Google sign-in only when the server enables it", async () => {
    vi.mocked(api.getGoogleConfig).mockResolvedValue({ enabled: true });
    render(<LoginScreen error="" onAuthenticate={vi.fn()} />);

    const link = await screen.findByRole("link", { name: "Войти через Google" });
    expect(link).toHaveAttribute("href", "/api/auth/google/login");
  });

  it("hides Google sign-in when it is not configured", async () => {
    vi.mocked(api.getGoogleConfig).mockResolvedValue({ enabled: false });
    render(<LoginScreen error="" onAuthenticate={vi.fn()} />);

    await waitFor(() => expect(api.getGoogleConfig).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /Google/ })).not.toBeInTheDocument();
  });

  it("consumes the OAuth result once and strips it from the address", () => {
    resetGoogleReturnForTests();
    window.history.replaceState(null, "", "/?google_login=code-1&view=chat");

    expect(takeGoogleReturn()).toEqual({
      loginCode: "code-1",
      error: null,
      connected: false,
    });
    expect(window.location.search).toBe("?view=chat");
    expect(takeGoogleReturn().loginCode).toBeNull();
  });

  it("explains known OAuth errors", () => {
    expect(googleErrorMessage("linked_elsewhere")).toMatch(/другому пользователю/);
    expect(googleErrorMessage("unexpected")).toMatch(/Не удалось связаться/);
  });
});

describe("Google Calendar settings", () => {
  beforeEach(() => {
    vi.mocked(api.getGoogleIntegration).mockResolvedValue(connected);
  });

  it("is hidden when the server has no Google integration", async () => {
    vi.mocked(api.getGoogleIntegration).mockResolvedValue({
      ...connected,
      available: false,
      linked: false,
    });
    render(<GoogleCalendarButton onError={vi.fn()} onCalendarChanged={vi.fn()} />);

    await waitFor(() => expect(api.getGoogleIntegration).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Google Календарь" })).toBeNull();
  });

  it("starts the calendar connection in the browser", async () => {
    vi.mocked(api.getGoogleIntegration).mockResolvedValue({
      ...connected,
      calendar_enabled: false,
    });
    vi.mocked(api.connectGoogleCalendar).mockResolvedValue({
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    });
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    });
    render(<GoogleCalendarButton onError={vi.fn()} onCalendarChanged={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Google Календарь" }));
    await userEvent.click(screen.getByRole("button", { name: "Подключить Google Календарь" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
    );
  });

  it("shows the sync state, skipped events and disconnects after confirmation", async () => {
    vi.mocked(api.disconnectGoogleCalendar).mockResolvedValue(undefined);
    render(
      <GoogleCalendarButton openOnMount onError={vi.fn()} onCalendarChanged={vi.fn()} />,
    );

    expect(await screen.findByText(/Синхронизировано:/)).toBeInTheDocument();
    expect(screen.getByText(/person@gmail.com/)).toBeInTheDocument();
    expect(screen.getByText(/Не импортировано событий из Google: 2/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Отключить" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Отключить",
      )!,
    );
    await waitFor(() => expect(api.disconnectGoogleCalendar).toHaveBeenCalled());
  });

  it("explains a failed sync", async () => {
    vi.mocked(api.getGoogleIntegration).mockResolvedValue({
      ...connected,
      sync_status: "error",
      last_error: "В проекте Google Cloud не включён Google Calendar API.",
    });
    render(
      <GoogleCalendarButton openOnMount onError={vi.fn()} onCalendarChanged={vi.fn()} />,
    );

    expect(
      await screen.findByText("В проекте Google Cloud не включён Google Calendar API."),
    ).toBeInTheDocument();
  });

  it("refreshes the calendar when a background sync finishes", async () => {
    const changed = vi.fn();
    vi.mocked(api.getGoogleIntegration)
      .mockResolvedValueOnce(connected)
      .mockResolvedValue({ ...connected, last_synced_at: "2030-01-01T10:01:00Z" });
    render(<GoogleCalendarButton onError={vi.fn()} onCalendarChanged={changed} />);
    await screen.findByRole("button", { name: "Google Календарь" });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });
});
