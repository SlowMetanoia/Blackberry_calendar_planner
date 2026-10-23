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
import { HistoryItem } from "../components/history/HistoryItem";
import { MessageExchange } from "../components/chat/MessageExchange";
import { ReadCard } from "../components/chat/ReadCard";
import * as api from "../api";
import type {
  AgentMessage,
  CalendarOccurrence,
  CalendarOperation,
} from "../types";

const openAir = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  updateSilenceMs: vi.fn(),
  options: null as null | { onPhrase: (audio: Blob) => void },
}));
const handsFree = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  stopConversation: vi.fn(),
  repeat: vi.fn(),
  updateSilenceMs: vi.fn(),
  updateActiveTimeout: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  options: null as null | {
    onMessage: (message: AgentMessage) => void;
    onStatus: (status: string) => void;
  },
}));
vi.mock("../libs/hands-free", async () => {
  const actual =
    await vi.importActual<typeof import("../libs/hands-free")>(
      "../libs/hands-free",
    );
  return {
    ...actual,
    HandsFreeSession: class {
      constructor(options: NonNullable<typeof handsFree.options>) {
        handsFree.options = options;
      }
      start = handsFree.start;
      stop = handsFree.stop;
      stopConversation = handsFree.stopConversation;
      repeat = handsFree.repeat;
      updateSilenceMs = handsFree.updateSilenceMs;
      updateActiveTimeout = handsFree.updateActiveTimeout;
      pause = handsFree.pause;
      resume = handsFree.resume;
    },
  };
});
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
    getReminders: vi.fn(),
    getNotifications: vi.fn(),
    updateReminder: vi.fn(),
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
    vi.mocked(api.getReminders).mockResolvedValue({items:[],total:0,limit:100,offset:0});
    vi.mocked(api.getNotifications).mockResolvedValue({items:[],total:0,limit:100,offset:0});
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
  it("keeps reminders editable in the new calendar UI", async () => {
    localStorage.setItem("planner-token", "token");
    const reminder = {id:"reminder-1",owner_id:"u1",title:"Позвонить врачу",description:"Согласовать время",remind_at:new Date(Date.now()+86400000).toISOString(),status:"active" as const,linked_resource:null,linked_id:null,relative_offset_minutes:null,cancelled_reason:null,fired_at:null,cancelled_at:null,created_at:new Date().toISOString()};
    vi.mocked(api.getReminders).mockResolvedValue({items:[reminder],total:1,limit:100,offset:0});
    vi.mocked(api.updateReminder).mockResolvedValue({...reminder,title:"Позвонить в клинику"});
    render(<App/>);
    await userEvent.click(await screen.findByRole("button",{name:"Календарь"}));
    await userEvent.click(await screen.findByRole("button",{name:/Позвонить врачу/}));
    const dialog = await screen.findByRole("dialog",{name:"Напоминание"});
    const title = within(dialog).getByLabelText("Название");
    await userEvent.clear(title);
    await userEvent.type(title,"Позвонить в клинику");
    await userEvent.click(within(dialog).getByRole("button",{name:"Сохранить"}));
    await waitFor(()=>expect(api.updateReminder).toHaveBeenCalledWith("reminder-1",expect.objectContaining({title:"Позвонить в клинику"})));
  });
  it("prefills a new reminder with the clicked week time", async () => {
    localStorage.setItem("planner-token", "token");
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Календарь" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Неделя" }),
    );
    const day = document.querySelector<HTMLElement>("[data-week-date]");
    expect(day).not.toBeNull();
    const date = day!.dataset.weekDate!;
    fireEvent.click(day!, { clientY: 48 * 10 + 1 });
    await userEvent.click(
      await screen.findByRole("button", { name: "Напоминание" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Новое напоминание",
    });
    expect(within(dialog).getByLabelText("Напомнить в")).toHaveValue(
      `${date}T10:00`,
    );
  });
  it("switches chat, calendar and history from the sidebar", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    vi.mocked(api.getCalendarHistory).mockResolvedValue({
      items: [operation],
      total: 1,
      limit: 100,
      offset: 0,
    });
    render(<App />);
    const sidebar = await screen.findByRole("navigation", { name: "Разделы" });
    const chat = within(sidebar).getByRole("button", { name: "Чат" });
    const calendar = within(sidebar).getByRole("button", { name: "Календарь" });
    const history = within(sidebar).getByRole("button", {
      name: "История изменений",
    });
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "Что запланируем?" }),
    ).toBeInTheDocument();

    await userEvent.click(calendar);
    expect(calendar).toHaveAttribute("aria-current", "page");
    expect(chat).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("heading", { name: "Календарь" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Развернуть календарь" }),
    ).toBeInTheDocument();

    await userEvent.click(history);
    expect(history).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "История изменений" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отменить создание" }),
    ).toBeInTheDocument();
  });
  it("renders a section only after it is selected", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Что запланируем?" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Календарь месяца" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(api.getOccurrences).toHaveBeenCalled());
    const callsBeforeCalendar =
      vi.mocked(api.getOccurrences).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Календарь" }));
    expect(
      await screen.findByRole("region", { name: "Календарь месяца" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi.mocked(api.getOccurrences).mock.calls.length,
      ).toBeGreaterThan(callsBeforeCalendar),
    );
  });
  it("switches the calendar month and year independently", async () => {
    localStorage.setItem("planner-token", "token");
    const { container } = render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Календарь" }),
    );
    const month = await screen.findByRole("combobox", { name: "Месяц" });
    const year = screen.getByRole("combobox", { name: "Год" });

    await userEvent.selectOptions(month, "0");
    await userEvent.selectOptions(year, "2030");

    expect(month).toHaveValue("0");
    expect(year).toHaveValue("2030");
    expect(
      container.querySelector('[data-date="2030-01-01"]'),
    ).toBeInTheDocument();
  });
  it("shows a week timeline with entry blocks sized by duration", async () => {
    const startsAt = new Date();
    startsAt.setHours(9, 0, 0, 0);
    const occurrence = {
      resource: "event" as const,
      series_id: "e1",
      occurrence_key: "e1",
      original_at: startsAt.toISOString(),
      scheduled_at: startsAt.toISOString(),
      recurring: false,
      data: {
        id: "e1",
        owner_id: "u1",
        title: "Планёрка",
        description: null,
        starts_at: startsAt.toISOString(),
        duration_minutes: 90,
        location: null,
      },
    };
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.getOccurrences).mockResolvedValue({
      items: [occurrence],
      total: 1,
      has_more: false,
      next_cursor: null,
    });
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Календарь" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Неделя" }));

    expect(
      await screen.findByRole("button", {
        name: "Планёрка, 09:00–10:30",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Месяц" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Неделя" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("prefills the clicked week slot when creating an entry", async () => {
    const now = new Date();
    const part = (value: number) => String(value).padStart(2, "0");
    const dayKey = `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`;
    localStorage.setItem("planner-token", "token");
    const { container } = render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Календарь" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Неделя" }));

    const column = container.querySelector<HTMLElement>(
      `[data-week-date="${dayKey}"]`,
    );
    expect(column).not.toBeNull();
    fireEvent.click(column!, { clientY: 14 * 48 + 5 });

    const dayDialog = await screen.findByRole("dialog", { name: /Дела на/ });
    await userEvent.click(
      within(dayDialog).getByRole("button", { name: "Событие" }),
    );
    expect(await screen.findByLabelText("Начало")).toHaveValue(
      `${dayKey}T14:00`,
    );
  });
  it("collapses the sidebar template and keeps the main section", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    render(<App />);
    const sidebar = screen.getByLabelText("Разделы ежедневника");
    expect(sidebar).toHaveClass("md:w-[264px]");
    await userEvent.click(
      await screen.findByRole("button", { name: "Свернуть панель" }),
    );
    expect(
      screen.getByRole("button", { name: "Развернуть панель" }),
    ).toBeInTheDocument();
    expect(sidebar).toHaveClass("md:w-[76px]");
    expect(sidebar).not.toHaveClass("md:w-[264px]");
    await waitFor(() =>
      expect(localStorage.getItem("planner-sidebar-collapsed")).toBe("true"),
    );
    expect(
      screen.getByRole("heading", { name: "Что запланируем?" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Развернуть панель" }),
    );
    expect(sidebar).toHaveClass("md:w-[264px]");
    expect(sidebar).not.toHaveClass("md:w-[76px]");
    await waitFor(() =>
      expect(localStorage.getItem("planner-sidebar-collapsed")).toBe("false"),
    );
  });
  it("shows calendar history and opens chat sessions from the always-open right panel", async () => {
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
    vi.mocked(api.getConversationHistory).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    render(<App />);
    const panel = screen.getByRole("complementary", { name: "Диалоги и задачи" });
    expect(
      within(panel).getByRole("button", { name: "Новый диалог" }),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "Свернуть панель диалогов" }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("button", { name: "История изменений" }),
    );
    expect(screen.getByText("Релиз")).toBeInTheDocument();
    expect(
      screen.getByText(/запланировано на 15 октября 2026/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Диалоги и задачи" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Чат" }));
    const reopenedPanel = screen.getByRole("complementary", {
      name: "Диалоги и задачи",
    });

    const session = within(reopenedPanel).getByRole("button", {
      name: "Старый диалог",
    });
    await userEvent.click(session);
    await waitFor(() =>
      expect(api.getConversationHistory).toHaveBeenCalledWith("s1", 100, 0),
    );
    expect(
      screen.getByRole("complementary", { name: "Диалоги и задачи" }),
    ).toBeInTheDocument();
  });
  it("shows upcoming tasks in a collapsible lower sidebar section", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    const deadline = new Date(Date.now() + 2 * 86_400_000);
    deadline.setHours(15, 30, 0, 0);
    vi.mocked(api.getTasks).mockResolvedValue({
      items: [
        {
          id: "t-near",
          owner_id: "u1",
          title: "Подготовить отчёт",
          description: null,
          deadline: deadline.toISOString(),
          estimated_minutes: 45,
          status: "open",
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });

    render(<App />);
    const tasksRegion = await screen.findByRole("region", {
      name: "Ближайшие задачи",
    });
    expect(
      within(tasksRegion).getByText("Подготовить отчёт"),
    ).toBeInTheDocument();
    expect(within(tasksRegion).getByText(/15:30/)).toBeInTheDocument();

    await userEvent.click(
      within(tasksRegion).getByRole("button", {
        name: "Свернуть раздел «Ближайшие задачи»",
      }),
    );
    expect(
      within(tasksRegion).queryByRole("list"),
    ).not.toBeInTheDocument();
    expect(
      within(tasksRegion).getByRole("button", {
        name: "Развернуть раздел «Ближайшие задачи»",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Занятость недели" }),
    ).toBeInTheDocument();

    const sessionsRegion = screen.getByRole("region", { name: "Диалоги" });
    await userEvent.click(
      within(sessionsRegion).getByRole("button", {
        name: "Свернуть раздел «Диалоги»",
      }),
    );
    expect(
      within(sessionsRegion).queryByRole("button", {
        name: "Новый диалог",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the chat sessions panel open when starting a new conversation", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    render(<App />);
    await screen.findByRole("heading", { name: "Что запланируем?" });
    const panel = screen.getByRole("complementary", { name: "Диалоги и задачи" });
    await userEvent.click(
      within(panel).getByRole("button", { name: "Новый диалог" }),
    );
    expect(
      screen.getByRole("complementary", { name: "Диалоги и задачи" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Что запланируем?" }),
    ).toBeInTheDocument();
  });
  it("shows weekly busyness in the chat sidebar", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    const monday = new Date();
    monday.setHours(10, 0, 0, 0);
    const weekday = monday.getDay();
    monday.setDate(monday.getDate() - (weekday === 0 ? 6 : weekday - 1));
    const wednesday = new Date(monday);
    wednesday.setDate(wednesday.getDate() + 2);
    wednesday.setHours(14, 0, 0, 0);
    const meeting: CalendarOccurrence = {
      resource: "event",
      series_id: "e1",
      occurrence_key: "e1",
      original_at: monday.toISOString(),
      scheduled_at: monday.toISOString(),
      recurring: false,
      data: {
        id: "e1",
        owner_id: "u1",
        title: "Планёрка",
        description: null,
        starts_at: monday.toISOString(),
        duration_minutes: 90,
        location: null,
      },
    };
    const report: CalendarOccurrence = {
      resource: "task",
      series_id: "t1",
      occurrence_key: "t1",
      original_at: wednesday.toISOString(),
      scheduled_at: wednesday.toISOString(),
      recurring: false,
      data: {
        id: "t1",
        owner_id: "u1",
        title: "Подготовить отчёт",
        description: null,
        deadline: wednesday.toISOString(),
        estimated_minutes: 60,
        status: "open",
      },
    };
    vi.mocked(api.getOccurrences).mockResolvedValue({
      items: [meeting, report],
      total: 2,
      has_more: false,
      next_cursor: null,
    });

    render(<App />);
    const heatmap = await screen.findByRole("region", {
      name: "Занятость недели",
    });
    const grid = within(heatmap).getByRole("img", {
      name: /Понедельник.*1 час 30 минут/,
    });
    expect(within(heatmap).getByText("Пн")).toBeInTheDocument();

    await userEvent.hover(grid);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(grid);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
      await screen.findByRole("button", { name: "История изменений" }),
    );
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
    expect(handsFree.start).toHaveBeenCalledWith();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Скажите «Айвори»")).toBeInTheDocument();
    handsFree.options!.onStatus("hearing_wake");
    expect(await screen.findByText("Слышу обращение…")).toBeInTheDocument();
    handsFree.options!.onStatus("ready");
    expect(
      await screen.findByText("Скажите, что нужно сделать"),
    ).toBeInTheDocument();
    handsFree.options!.onStatus("hearing_command");
    expect(await screen.findByText("Слушаю команду…")).toBeInTheDocument();
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
    expect(handsFree.updateSilenceMs).toHaveBeenCalledWith(2000);
    view.unmount();
    expect(handsFree.stop).toHaveBeenCalled();
  });
  it("renders a message received by the hands-free session", async () => {
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
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Включить open-air режим Ivory",
      }),
    );
    handsFree.options!.onMessage(message);
    expect(await screen.findByText("Ivory создай задачу")).toBeInTheDocument();
    expect(await screen.findByText("Готово")).toBeInTheDocument();
  });
  it("stops and releases the hands-free session", async () => {
    localStorage.setItem("planner-token", "token");
    vi.mocked(api.syncTimeZone).mockResolvedValue({ timezone: "UTC" });
    render(<App />);
    const toggle = await screen.findByRole("button", {
      name: "Включить open-air режим Ivory",
    });
    await userEvent.click(toggle);
    await userEvent.click(
      screen.getByRole("button", { name: "Выключить open-air режим Ivory" }),
    );
    expect(handsFree.stop).toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Календарь" }),
    );
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
        `.planner-calendar [data-date="${dateKey}"]`,
      );
      expect(cell).toHaveClass("calendar-day-occupied");
      return cell!;
    });
    expect(
      container.querySelector(".planner-calendar .fc-event"),
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
      within(dayDialog).getByRole("button", { name: "Событие" }),
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
      await screen.findByRole("button", { name: "Календарь" }),
    );
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
      await screen.findByRole("button", { name: "Календарь" }),
    );
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
