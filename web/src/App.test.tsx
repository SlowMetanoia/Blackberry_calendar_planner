import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { MessageExchange, PlanCard, ReadCard } from "./App";
import * as api from "./api";
import type { AgentMessage, ConversationSummary, Plan } from "./types";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, request: vi.fn(), getMessage: vi.fn(), getPlan: vi.fn(), getHistory: vi.fn(), getConversations: vi.fn() };
});

describe("planner chat", () => {
  afterEach(cleanup);
  beforeEach(() => {
    sessionStorage.clear(); vi.clearAllMocks();
    vi.mocked(api.getHistory).mockResolvedValue({items:[], total:0, limit:100, offset:0});
    vi.mocked(api.getConversations).mockResolvedValue({items:[], total:0, limit:100, offset:0});
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
  });

  it("logs in and opens the chat", async () => {
    vi.mocked(api.request).mockResolvedValue({ access_token: "token" });
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "a@example.test");
    await userEvent.type(screen.getByLabelText("Пароль"), "password1");
    await userEvent.click(screen.getByRole("button", {name:"Войти"}));
    expect(await screen.findByText("Что запланируем?")).toBeInTheDocument();
    expect(sessionStorage.getItem("planner-token")).toBe("token");
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/users/me/timezone", {
      method: "PUT",
      body: JSON.stringify({timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    }));
  });

  it("synchronizes timezone for an authenticated session", async () => {
    sessionStorage.setItem("planner-token", "token");
    vi.mocked(api.request).mockResolvedValue({timezone:"UTC"});
    render(<App />);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/users/me/timezone", {
      method: "PUT",
      body: JSON.stringify({timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    }));
  });

  it("sends a text message and renders the agent reply", async () => {
    sessionStorage.setItem("planner-token", "token");
    const queued:AgentMessage = {id:"m1",conversation_id:"c1",sequence:1,input_text:"Мои задачи",status:"queued",reply:null,reads:[],plan_id:null,error:null,created_at:"2026-01-01"};
    const done:AgentMessage = {...queued,status:"completed",reply:"Задач нет"};
    vi.mocked(api.request).mockResolvedValue(queued);
    vi.mocked(api.getMessage).mockResolvedValue(done);
    render(<App />);
    await userEvent.type(screen.getByLabelText("Сообщение"), "Мои задачи");
    await userEvent.click(screen.getByLabelText("Отправить"));
    expect(await screen.findByText("Задач нет")).toBeInTheDocument();
    await waitFor(()=>expect(Element.prototype.scrollTo).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("starts and stops push-to-talk recording", async () => {
    sessionStorage.setItem("planner-token", "token");
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})}});
    class Recorder {
      state="inactive"; mimeType="audio/webm"; ondataavailable:(e:{data:Blob})=>void=()=>{}; onstop:()=>void=()=>{};
      constructor(_stream:unknown){} start(){this.state="recording";} stop(){this.ondataavailable({data:new Blob(["voice"])});this.state="inactive";this.onstop();}
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    vi.mocked(api.request).mockResolvedValue({id:"m1",conversation_id:"c1",sequence:1,input_text:null,status:"failed",reply:null,reads:[],plan_id:null,error:"stop",created_at:"2026"});
    render(<App />); const button=screen.getByLabelText("Удерживайте для записи");
    fireEvent.pointerDown(button,{pointerId:1}); await waitFor(()=>expect(screen.getByText("Отпустите, чтобы отправить")).toBeInTheDocument());
    fireEvent.pointerUp(button,{pointerId:1}); await waitFor(()=>expect(stop).toHaveBeenCalled());
  });

  it("starts a new conversation after context overflow", async () => {
    sessionStorage.setItem("planner-token", "token");
    vi.mocked(api.request).mockResolvedValue({timezone:"Europe/Moscow"});
    vi.mocked(api.getConversations).mockResolvedValue({
      items:[{id:"full-conversation",preview:"Продолжим",created_at:"2026-10-14T09:00:00Z",last_activity_at:"2026-10-14T09:00:00Z"}],
      total:1,limit:100,offset:0,
    });
    vi.mocked(api.getHistory).mockResolvedValue({
      items:[{id:"m1",conversation_id:"full-conversation",sequence:1,input_text:"Продолжим",status:"needs_clarification",reply:"Начните новый диалог",reads:[],plan_id:null,error:null,requires_new_conversation:true,created_at:"2026"}],
      total:1,limit:100,offset:0,
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", {name:/Продолжим/}));
    const button = await screen.findByRole("button", {name:"Начать новый диалог"});
    await userEvent.click(button);
    expect(screen.getByText("Начните с простой просьбы")).toBeInTheDocument();
  });

  it("keeps assistant time inside the bubble at its lower-left hook", () => {
    const createdAt = new Date();
    createdAt.setMinutes(7, 0, 0);
    const message:AgentMessage = {id:"m1",conversation_id:"c1",sequence:1,input_text:"Привет",status:"completed",reply:"Здравствуйте",reads:[],plan_id:null,error:null,created_at:createdAt.toISOString()};
    render(<MessageExchange message={message} plans={{}} command={vi.fn()} startNewConversation={vi.fn()} />);
    const times = screen.getAllByText(/:07$/);
    expect(times).toHaveLength(2);
    expect(times[1]).toHaveClass("bot-time");
    expect(times[1].closest(".bot")).toBeInTheDocument();
  });

  it("starts blank and opens a saved session from the sidebar with its plans", async () => {
    sessionStorage.setItem("planner-token", "token");
    sessionStorage.setItem("planner-conversation", "must-not-restore");
    const conversation:ConversationSummary = {id:"c1",preview:"Первая фраза",created_at:"2026-10-13T08:00:00Z",last_activity_at:"2026-10-14T09:00:00Z"};
    const historical:AgentMessage = {id:"m1",conversation_id:"c1",sequence:1,input_text:"Первая фраза",status:"needs_confirmation",reply:"План готов",reads:[],plan_id:"p1",error:null,created_at:"2026-10-13T08:00:00Z"};
    const plan:Plan = {id:"p1",status:"pending",expires_at:null,actions:[]};
    vi.mocked(api.getConversations).mockResolvedValue({items:[conversation],total:1,limit:100,offset:0});
    vi.mocked(api.getHistory).mockResolvedValue({items:[historical],total:1,limit:100,offset:0});
    vi.mocked(api.getPlan).mockResolvedValue(plan);
    render(<App />);
    expect(await screen.findByText("Начните с простой просьбы")).toBeInTheDocument();
    expect(api.getHistory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", {name:/Первая фраза/}));
    expect(await screen.findByText("План готов")).toBeInTheDocument();
    await waitFor(()=>expect(api.getPlan).toHaveBeenCalledWith("p1"));
  });

  it("does not think about audio before transcription becomes text", () => {
    const queued:AgentMessage = {id:"m1",conversation_id:"c1",sequence:1,input_text:null,status:"transcribing",reply:null,reads:[],plan_id:null,error:null,created_at:"2026-10-14T09:00:00Z"};
    const view = render(<MessageExchange message={queued} plans={{}} command={vi.fn()} startNewConversation={vi.fn()} />);
    expect(screen.getByText("Распознаю…")).toBeInTheDocument();
    expect(screen.queryByText("Думаю…")).not.toBeInTheDocument();
    view.rerender(<MessageExchange message={{...queued,input_text:"Распознанный текст",status:"processing"}} plans={{}} command={vi.fn()} startNewConversation={vi.fn()} />);
    expect(screen.getByText("Распознанный текст")).toBeInTheDocument();
    expect(screen.getByText("Думаю…")).toBeInTheDocument();
  });

  it("renders a safe transcription failure without a thinking state", () => {
    const failed:AgentMessage = {
      id:"m1",conversation_id:"c1",sequence:1,input_text:null,status:"failed",reply:null,
      reads:[],plan_id:null,
      error:"Не удалось связаться с сервисом распознавания речи. Проверьте, что GigaAM запущен, и попробуйте записать сообщение ещё раз.",
      created_at:"2026-10-14T09:00:00Z",
    };
    render(<MessageExchange message={failed} plans={{}} command={vi.fn()} startNewConversation={vi.fn()} />);
    expect(screen.getByText(/Не удалось связаться с сервисом распознавания речи/)).toBeInTheDocument();
    expect(screen.queryByText("Думаю…")).not.toBeInTheDocument();
    expect(screen.queryByText("Распознаю…")).not.toBeInTheDocument();
  });

  it("renders every known field in a read event", () => {
    render(<ReadCard read={{resource:"event",id:"e1",data:{title:"Лекция",starts_at:"2026-10-15T09:00:00Z",duration_minutes:90,location:"Политех",description:"Параллельное программирование"}}} timeZone="Europe/Moscow" />);
    expect(screen.getByText("Лекция")).toBeInTheDocument();
    expect(screen.getByText("15 октября 2026, 12:00–13:30")).toBeInTheDocument();
    expect(screen.getByText("Длительность:").parentElement).toHaveTextContent("1 час 30 минут");
    expect(screen.getByText("Место:").parentElement).toHaveTextContent("Политех");
    expect(screen.getByText("Описание:").parentElement).toHaveTextContent("Параллельное программирование");
  });

  it("shows every known event detail with localized labels", () => {
    const plan:Plan = {
      id:"p1", status:"completed", expires_at:null,
      actions:[{
        id:"a1", ordinal:0, operation:"create", resource:"event", target_id:null,
        payload:{
          title:"Встреча по поводу релиза",
          starts_at:"2026-10-15T08:00:00Z",
          duration_minutes:90,
          location:"Переговорная",
          description:"Обсудить подготовку релиза",
        },
        status:"completed", result:{id:"event-1"}, error:null,
      }],
    };
    render(<PlanCard plan={plan} command={vi.fn()} timeZone="Europe/Moscow" />);
    expect(screen.getByText("Создать событие")).toBeInTheDocument();
    expect(screen.getByText("Встреча по поводу релиза")).toBeInTheDocument();
    expect(screen.getByText("15 октября 2026, 11:00–12:30")).toBeInTheDocument();
    expect(screen.getByText("Длительность:").parentElement).toHaveTextContent("Длительность:1 час 30 минут");
    expect(screen.getByText("Место:").parentElement).toHaveTextContent("Место:Переговорная");
    expect(screen.getByText("Описание:").parentElement).toHaveTextContent("Описание:Обсудить подготовку релиза");
    expect(screen.getByText("Выполнен")).toBeInTheDocument();
    expect(screen.getByText("Выполнено")).toBeInTheDocument();
    expect(screen.queryByText("create · event")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name:"Подтвердить"})).not.toBeInTheDocument();
  });

  it("renders task updates and delete fallbacks without empty metadata", () => {
    const plan:Plan = {
      id:"p2", status:"pending", expires_at:null,
      actions:[
        {id:"a1",ordinal:0,operation:"update",resource:"task",target_id:"task-1",payload:{deadline:"2026-10-16T09:00:00Z",estimated_minutes:30,status:"completed"},status:"pending",result:null,error:null},
        {id:"a2",ordinal:1,operation:"delete",resource:"event",target_id:"event-2",payload:{},status:"failed",result:null,error:"Событие не найдено"},
      ],
    };
    render(<PlanCard plan={plan} command={vi.fn()} timeZone="Europe/Moscow" />);
    expect(screen.getByText("Изменить задачу")).toBeInTheDocument();
    expect(screen.getByText("Изменяемые данные")).toBeInTheDocument();
    expect(screen.getByText("Срок:").parentElement).toHaveTextContent("Срок:16 октября 2026, 12:00");
    expect(screen.getByText("Оценка:").parentElement).toHaveTextContent("Оценка:30 минут");
    expect(screen.getByText("Статус задачи:").parentElement).toHaveTextContent("Статус задачи:Выполнена");
    expect(screen.getByText("Удалить событие")).toBeInTheDocument();
    expect(screen.getByText("ID: event-2")).toBeInTheDocument();
    expect(screen.getByText("Событие не найдено")).toBeInTheDocument();
  });

  it("shows the complete resulting title in an update plan", () => {
    const plan:Plan = {
      id:"p3",status:"pending",expires_at:null,
      actions:[{
        id:"a1",ordinal:0,operation:"update",resource:"task",target_id:"task-1",
        payload:{title:"Подготовить доклад на pythonn про tagless final"},
        status:"pending",result:null,error:null,
      }],
    };
    render(<PlanCard plan={plan} command={vi.fn()} />);
    expect(screen.getByText("Подготовить доклад на pythonn про tagless final")).toBeInTheDocument();
  });
});
