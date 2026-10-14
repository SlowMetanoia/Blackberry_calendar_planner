import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import type { AgentMessage } from "./types";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, request: vi.fn(), getMessage: vi.fn(), getPlan: vi.fn(), getHistory: vi.fn() };
});

describe("planner chat", () => {
  afterEach(cleanup);
  beforeEach(() => {
    sessionStorage.clear(); vi.clearAllMocks();
    vi.mocked(api.getHistory).mockResolvedValue({items:[], total:0, limit:50, offset:0});
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

  it("synchronizes timezone for a restored session", async () => {
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
    sessionStorage.setItem("planner-conversation", "full-conversation");
    vi.mocked(api.request).mockResolvedValue({timezone:"Europe/Moscow"});
    vi.mocked(api.getHistory).mockResolvedValue({
      items:[{id:"m1",conversation_id:"full-conversation",sequence:1,input_text:"Продолжим",status:"needs_clarification",reply:"Начните новый диалог",reads:[],plan_id:null,error:null,requires_new_conversation:true,created_at:"2026"}],
      total:1,limit:50,offset:0,
    });
    render(<App />);
    const button = await screen.findByRole("button", {name:"Начать новый диалог"});
    await userEvent.click(button);
    expect(sessionStorage.getItem("planner-conversation")).toBeNull();
    expect(screen.getByText("Начните с простой просьбы")).toBeInTheDocument();
  });
});
