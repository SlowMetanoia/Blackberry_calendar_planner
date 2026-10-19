import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../components/App";
import { HistoryItem } from "../components/HistoryItem";
import { MessageExchange } from "../components/MessageExchange";
import { ReadCard } from "../components/ReadCard";
import * as api from "../api";
import type { AgentMessage, CalendarOperation } from "../types";

const openAir = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  updateSilenceMs: vi.fn(),
  options: null as null | { onPhrase: (audio: Blob) => void },
}));
vi.mock("../libs/open-air", async () => {
  const actual =
    await vi.importActual<typeof import("../libs/open-air")>(
      "../libs/open-air",
    );
  return {
    ...actual,
    OpenAirCapture: class {
      constructor(options: { onPhrase: (audio: Blob) => void }) {
        openAir.options = options;
      }
      start = openAir.start;
      stop = openAir.stop;
      updateSilenceMs = openAir.updateSilenceMs;
    },
  };
});
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    authenticate: vi.fn(),
    logoutSession: vi.fn(),
    sendMessage: vi.fn(),
    sendAudioMessage: vi.fn(),
    syncTimeZone: vi.fn(),
    getMessage: vi.fn(),
    getConversations: vi.fn(),
    getConversationHistory: vi.fn(),
    getCalendarHistory: vi.fn(),
    undoOperation: vi.fn(),
    getUserPreferences: vi.fn(),
    updateUserPreferences: vi.fn(),
    transcribeAudio: vi.fn(),
    getTasks: vi.fn(),
    getEvents: vi.fn(),
    getOccurrences: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    updateTaskOccurrence: vi.fn(),
    deleteTaskOccurrence: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    updateEventOccurrence: vi.fn(),
    deleteEventOccurrence: vi.fn(),
  };
});
const operation: CalendarOperation = {
  id: "o1",
  sequence: 1,
  command_id: "c1",
  ordinal: 0,
  operation: "create",
  resource: "event",
  target_id: "e1",
  before: null,
  after: {
    id: "e1",
    title: "Релиз",
    starts_at: "2026-10-15T08:00:00Z",
    duration_minutes: 90,
    location: "Офис",
  },
  changes: {},
  origin: "agent",
  source_message_id: "m1",
  reverts_operation_id: null,
  created_at: "2026-10-15T09:00:00Z",
};

describe("planner chat", () => {
  afterEach(cleanup);
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.getConversations).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.getCalendarHistory).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.getUserPreferences).mockResolvedValue({
      timezone: "Europe/Moscow",
      upcoming_days: 7,
      open_air_silence_ms: 1500,
    });
    vi.mocked(api.getTasks).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.getEvents).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.getOccurrences).mockRejectedValue(
      new Error("legacy fallback"),
    );
    Element.prototype.scrollTo = vi.fn();
  });
  it("logs in and opens chat", async () => {
    vi.mocked(api.authenticate).mockResolvedValue("token");
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "a@example.test");
    await userEvent.type(screen.getByLabelText("Пароль"), "password1");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("Что запланируем?")).toBeInTheDocument();
  });
  it("shows calendar history in sidebar and sessions in a modal", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.getCalendarHistory).mockResolvedValue({
      items: [operation],
      total: 1,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.getConversations).mockResolvedValue({
      items: [
        {
          id: "s1",
          preview: "Старый диалог",
          created_at: "2026-10-14T09:59:00Z",
          last_activity_at: "2026-10-14T09:59:00Z",
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });
    render(<App />);
    expect(await screen.findByText("История изменений")).toBeInTheDocument();
    expect(screen.getByText("Релиз")).toBeInTheDocument();
    expect(
      screen.getByText(/запланировано на 15 октября 2026/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "История сессий" }),
    );
    expect(
      screen.getByRole("dialog", { name: "История сессий" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Старый диалог")).toBeInTheDocument();
  });
  it("undoes an operation and refreshes history", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.getCalendarHistory).mockResolvedValue({
      items: [operation],
      total: 1,
      limit: 100,
      offset: 0,
    });
    vi.mocked(api.undoOperation).mockResolvedValue({
      ...operation,
      id: "o2",
      operation: "delete",
    });
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Отменить создание" }),
    );
    await waitFor(() => expect(api.undoOperation).toHaveBeenCalledWith("o1"));
    expect(api.getCalendarHistory).toHaveBeenCalledTimes(2);
  });
  it("returns to login when the API announces an expired session", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    render(<App />);
    window.dispatchEvent(new CustomEvent(api.AUTH_EXPIRED_EVENT));
    expect(
      await screen.findByRole("heading", { name: "Войти в ежедневник" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Сессия истекла/)).toBeInTheDocument();
    expect(localStorage.getItem("planner-token")).toBeNull();
  });
  it("renders completed operations as receipts without confirmation", () => {
    const message: AgentMessage = {
      id: "m1",
      conversation_id: "s1",
      sequence: 1,
      input_text: "Создай встречу",
      status: "completed",
      reply: "Готово",
      display_items: [],
      operations: [operation],
      error: null,
      created_at: "2026-10-15T09:00:00Z",
    };
    render(
      <MessageExchange message={message} startNewConversation={vi.fn()} />,
    );
    expect(screen.getByText("Создано · Событие")).toBeInTheDocument();
    expect(screen.queryByText("Подтвердить")).not.toBeInTheDocument();
    expect(screen.getByText("Офис")).toBeInTheDocument();
  });
  it("keeps voice thinking hidden until text exists", () => {
    const message: AgentMessage = {
      id: "m1",
      conversation_id: "s1",
      sequence: 1,
      input_text: null,
      status: "transcribing",
      reply: null,
      display_items: [],
      operations: [],
      error: null,
      created_at: "2026-10-15T09:00:00Z",
    };
    const view = render(
      <MessageExchange message={message} startNewConversation={vi.fn()} />,
    );
    expect(screen.getByText("Распознаю…")).toBeInTheDocument();
    expect(screen.queryByText("Думаю…")).not.toBeInTheDocument();
    view.rerender(
      <MessageExchange
        message={{ ...message, input_text: "Текст", status: "processing" }}
        startNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByText("Думаю…")).toBeInTheDocument();
  });
  it("enables Ivory open-air, updates its pause, and cleans up", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.updateUserPreferences).mockResolvedValue({
      timezone: "Europe/Moscow",
      upcoming_days: 7,
      open_air_silence_ms: 2000,
    });
    const view = render(<App />);
    const toggle = await screen.findByRole("button", {
      name: "Включить open-air режим Ivory",
    });
    await userEvent.click(toggle);
    expect(openAir.start).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Удерживайте для записи" }),
    ).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText("Пауза перед отправкой"),
      "2000",
    );
    await waitFor(() =>
      expect(api.updateUserPreferences).toHaveBeenCalledWith({
        open_air_silence_ms: 2000,
      }),
    );
    expect(openAir.updateSilenceMs).toHaveBeenCalledWith(2000);
    view.unmount();
    expect(openAir.stop).toHaveBeenCalled();
  });
  it("sends only an Ivory phrase through the normal message chain", async () => {
    const message: AgentMessage = {
      id: "m1",
      conversation_id: "s1",
      sequence: 1,
      input_text: "Ivory создай задачу",
      status: "completed",
      reply: "Готово",
      display_items: [],
      operations: [],
      error: null,
      created_at: "2026-10-15T09:00:00Z",
    };
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.transcribeAudio)
      .mockResolvedValueOnce("обычный разговор")
      .mockResolvedValueOnce("шум перед именем, Ivory создай задачу");
    vi.mocked(api.getMessage).mockResolvedValue(message);
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Включить open-air режим Ivory",
      }),
    );
    vi.mocked(api.sendMessage).mockClear();
    vi.mocked(api.sendMessage).mockResolvedValue(message);
    openAir.options!.onPhrase(new Blob(["first"]));
    await waitFor(() => expect(api.transcribeAudio).toHaveBeenCalledTimes(1));
    expect(api.sendMessage).not.toHaveBeenCalled();
    openAir.options!.onPhrase(new Blob(["second"]));
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith("Ivory создай задачу", null),
    );
  });
  it("does not send an in-flight phrase after open-air is disabled", async () => {
    let finishTranscription: (value: string) => void = () => {};
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.transcribeAudio).mockReturnValue(
      new Promise((resolve) => {
        finishTranscription = resolve;
      }),
    );
    render(<App />);
    const toggle = await screen.findByRole("button", {
      name: "Включить open-air режим Ivory",
    });
    await userEvent.click(toggle);
    vi.mocked(api.sendMessage).mockClear();
    openAir.options!.onPhrase(new Blob(["voice"]));
    await waitFor(() => expect(api.transcribeAudio).toHaveBeenCalled());
    await userEvent.click(
      screen.getByRole("button", { name: "Выключить open-air режим Ivory" }),
    );
    finishTranscription("Ivory создай задачу");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("renders every known event field", () => {
    render(
      <ReadCard
        read={{ resource: "event", id: "e1", data: operation.after! }}
        timeZone="Europe/Moscow"
      />,
    );
    expect(
      screen.getByText("15 октября 2026, 11:00–12:30"),
    ).toBeInTheDocument();
    expect(screen.getByText("Место:").parentElement).toHaveTextContent("Офис");
  });
  it("shows calendar dots, day details, hover expansion, and edits a task", async () => {
    const deadlineDate = new Date(Date.now() + 86_400_000),
      deadline = deadlineDate.toISOString(),
      part = (value: number) => String(value).padStart(2, "0"),
      dateKey = `${deadlineDate.getFullYear()}-${part(deadlineDate.getMonth() + 1)}-${part(deadlineDate.getDate())}`;
    const task = {
      id: "t1",
      owner_id: "u1",
      title: "Подготовить отчёт",
      description: "Сверить цифры",
      deadline,
      estimated_minutes: 45,
      status: "open" as const,
    };
    const undated = {
      ...task,
      id: "t2",
      title: "Разобрать заметки",
      deadline: null,
    };
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({
      timezone: "Europe/Moscow",
    });
    vi.mocked(api.getTasks).mockImplementation(async (options) => ({
      items: options?.deadlinePresence === "undated" ? [undated] : [task],
      total: 1,
      limit: 100,
      offset: 0,
    }));
    vi.mocked(api.updateUserPreferences).mockResolvedValue({
      timezone: "Europe/Moscow",
      upcoming_days: 14,
      open_air_silence_ms: 1500,
    });
    vi.mocked(api.updateTask).mockResolvedValue({
      ...task,
      title: "Готовый отчёт",
    });
    const { container } = render(<App />);
    const taskButton = await screen.findByRole("button", {
      name: /Подготовить отчёт/,
    });
    expect(screen.getByText("Без срока")).toBeInTheDocument();
    await userEvent.hover(taskButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Сверить цифры",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Оценка: 45 минут");
    await userEvent.unhover(taskButton);
    await userEvent.selectOptions(
      screen.getByLabelText("Период ближайших дел"),
      "14",
    );
    await waitFor(() =>
      expect(api.updateUserPreferences).toHaveBeenCalledWith({
        upcoming_days: 14,
      }),
    );
    const dayCell = await waitFor(() => {
      const cell = container.querySelector<HTMLElement>(
        `.mini-calendar [data-date="${dateKey}"]`,
      );
      expect(cell).toHaveClass("calendar-day-occupied");
      return cell!;
    });
    expect(
      container.querySelector(".mini-calendar .fc-event"),
    ).not.toBeInTheDocument();
    fireEvent.mouseEnter(dayCell);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Подготовить отчёт",
    );
    fireEvent.mouseLeave(dayCell);
    await userEvent.click(dayCell);
    const dayDialog = await screen.findByRole("dialog", { name: /Дела на/ });
    expect(
      within(dayDialog).getByText("Сверить цифры", { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(dayDialog).getByRole("button", { name: "+ Событие" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dayDialog).getByRole("button", { name: /Подготовить отчёт/ }),
    );
    const title = screen.getByLabelText("Название");
    await userEvent.clear(title);
    await userEvent.type(title, "Готовый отчёт");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ title: "Готовый отчёт" }),
      ),
    );
  });
  it("edits one recurring occurrence or the selected and future series", async () => {
    const deadline = new Date(Date.now() + 86_400_000).toISOString(),
      task = {
        id: "series-1",
        owner_id: "u1",
        title: "Французский",
        description: null,
        deadline,
        estimated_minutes: 30,
        status: "open" as const,
        recurrence: {
          frequency: "daily" as const,
          interval: 1,
          end: { kind: "count" as const, count: 5 },
        },
        recurrence_timezone: "Europe/Moscow",
      },
      occurrence = {
        resource: "task" as const,
        series_id: task.id,
        occurrence_key: "occurrence-1",
        original_at: deadline,
        scheduled_at: deadline,
        recurring: true,
        data: task,
      };
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({
      timezone: "Europe/Moscow",
    });
    vi.mocked(api.getOccurrences).mockResolvedValue({
      items: [occurrence],
      total: 1,
      has_more: false,
      next_cursor: null,
    });
    vi.mocked(api.updateTask).mockResolvedValue(task);
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Французский/ }),
    );
    expect(screen.getByLabelText("Изменить")).toHaveValue("occurrence");
    expect(screen.getByLabelText("Повторять")).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Изменить"), "series");
    expect(screen.getByLabelText("Повторять")).toBeEnabled();
    expect(screen.getByLabelText("Интервал")).toHaveValue(1);
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        "series-1",
        expect.objectContaining({
          recurrence: expect.objectContaining({
            frequency: "daily",
            interval: 1,
          }),
          recurrence_timezone: "Europe/Moscow",
        }),
        "occurrence-1",
      ),
    );
  });
  it("loads more overdue occurrences with the returned cursor", async () => {
    const old = new Date(Date.now() - 86_400_000).toISOString(),
      task = {
        id: "t-old",
        owner_id: "u1",
        title: "Старый повтор",
        description: null,
        deadline: old,
        estimated_minutes: null,
        status: "open" as const,
      },
      occurrence = {
        resource: "task" as const,
        series_id: task.id,
        occurrence_key: "old-1",
        original_at: old,
        scheduled_at: old,
        recurring: true,
        data: task,
      };
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({
      timezone: "Europe/Moscow",
    });
    vi.mocked(api.getOccurrences).mockImplementation(async (options) =>
      options?.cursor
        ? { items: [], total: 1, has_more: false, next_cursor: null }
        : options?.from?.startsWith("1970")
          ? {
              items: [occurrence],
              total: 2,
              has_more: true,
              next_cursor: "page-2",
            }
          : { items: [], total: 0, has_more: false, next_cursor: null },
    );
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Показать ещё" }),
    );
    await waitFor(() =>
      expect(api.getOccurrences).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "page-2" }),
      ),
    );
  });
  it("shows a compact update and exposes its details on hover", async () => {
    const undo = vi.fn(),
      updated = {
        ...operation,
        operation: "update" as const,
        before: { title: "До" },
        after: { title: "После" },
        changes: { title: { before: "До", after: "После" } },
      };
    const { container } = render(<HistoryItem item={updated} undo={undo} />);
    const item = container.querySelector(".history-item")!;
    expect(item).toHaveClass("update");
    expect(screen.getByText("12:00")).toBeInTheDocument();
    expect(
      container.querySelector(".operation-letter"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.hover(item);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("До → После");
    expect(
      screen.getByRole("button", { name: "Отменить изменение" }),
    ).toBeInTheDocument();
  });
  it("labels a task deadline in history", () => {
    render(
      <HistoryItem
        item={{
          ...operation,
          resource: "task",
          after: { title: "Отчёт", deadline: "2026-10-16T08:00:00Z" },
        }}
        undo={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/запланировано к 16 октября 2026/),
    ).toBeInTheDocument();
  });
});
