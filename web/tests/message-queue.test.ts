import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { createSessionStore } from "../libs/stores/session-store";
import type { AgentMessage, Status } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    sendMessage: vi.fn(),
    sendAudioMessage: vi.fn(),
    getMessage: vi.fn(),
    getConversations: vi.fn(),
    getConversationHistory: vi.fn(),
    getCalendarHistory: vi.fn(),
  };
});

const emptyPage = { items: [], total: 0, limit: 100, offset: 0 };

function agentMessage(
  id: string,
  sequence: number,
  text: string | null,
  status: Status,
  conversation = "c1",
): AgentMessage {
  return {
    id,
    conversation_id: conversation,
    sequence,
    input_text: text,
    status,
    reply: status === "completed" ? `Ответ на ${text}` : null,
    display_items: [],
    operations: [],
    error: null,
    created_at: "2026-10-27T09:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("message queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getConversations).mockResolvedValue(emptyPage);
    vi.mocked(api.getCalendarHistory).mockResolvedValue(emptyPage);
  });

  it("never mixes another conversation into the selected timeline", async () => {
    const store = createSessionStore();
    store
      .getState()
      .receiveMessage(agentMessage("m1", 1, "первое", "completed"));
    store
      .getState()
      .receiveMessage(agentMessage("m2", 2, "второе", "completed"));
    store
      .getState()
      .receiveMessage(agentMessage("m3", 1, "третье", "completed", "other"));
    expect(store.getState().messages.map((m) => m.input_text)).toEqual([
      "первое",
      "второе",
    ]);
    expect(store.getState().conversation).toBe("c1");
  });

  it("reserves audio order before recording and ignores stale voice events", async () => {
    const store = createSessionStore();
    const reservation = store.getState().reserveAudio();
    await store.getState().sendText("второе");
    expect(api.sendMessage).not.toHaveBeenCalled();
    vi.mocked(api.sendAudioMessage).mockResolvedValue(
      agentMessage("m1", 1, "голос", "queued"),
    );
    vi.mocked(api.sendMessage).mockResolvedValue(
      agentMessage("m2", 2, "второе", "queued"),
    );
    vi.mocked(api.getMessage).mockImplementation(async (id) =>
      agentMessage(
        id,
        id === "m1" ? 1 : 2,
        id === "m1" ? "голос" : "второе",
        "completed",
      ),
    );
    store.getState().finishAudio(reservation, new Blob(["audio"]));
    await vi.waitFor(() => expect(store.getState().messages).toHaveLength(2));
    expect(store.getState().messages.map((m) => m.input_text)).toEqual([
      "голос",
      "второе",
    ]);
    const version = store.getState().selectionVersion;
    store.getState().startNewConversation();
    store
      .getState()
      .receiveMessage(agentMessage("late", 3, "позднее", "completed"), version);
    expect(store.getState().messages).toEqual([]);
  });

  it("holds text until a hands-free turn has finished playback", async () => {
    const store = createSessionStore();
    expect(store.getState().beginVoiceTurn()).toBe(true);
    await store.getState().sendText("второе");
    store
      .getState()
      .receiveMessage(agentMessage("m1", 1, "голос", "completed"));
    expect(api.sendMessage).not.toHaveBeenCalled();
    vi.mocked(api.sendMessage).mockResolvedValue(
      agentMessage("m2", 2, "второе", "completed"),
    );
    vi.mocked(api.getMessage).mockResolvedValue(
      agentMessage("m2", 2, "второе", "completed"),
    );
    store.getState().endVoiceTurn();
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith("второе", "c1"),
    );
  });

  it("does not regress completed messages when polling delivers an older state", () => {
    const store = createSessionStore();
    store.getState().receiveMessage(agentMessage("m1", 1, "first", "completed"));
    store.getState().receiveMessage(agentMessage("m2", 2, "second", "completed"));
    store.getState().receiveMessage(agentMessage("m1", 1, "first", "queued"));
    expect(store.getState().messages.map(m => [m.id, m.status])).toEqual([["m1", "completed"], ["m2", "completed"]]);
  });

  it("shows a message immediately and sends the next one only after the agent answers", async () => {
    const store = createSessionStore();
    const firstStatus = deferred<AgentMessage>();
    vi.mocked(api.sendMessage)
      .mockResolvedValueOnce(agentMessage("m1", 1, "первое", "queued"))
      .mockResolvedValueOnce(agentMessage("m2", 2, "второе", "queued"));
    vi.mocked(api.getMessage).mockImplementation(async (id) =>
      id === "m1"
        ? firstStatus.promise
        : agentMessage("m2", 2, "второе", "completed"),
    );

    const sent = store.getState().sendText("первое");
    expect(store.getState().queue[0]).toMatchObject({
      text: "первое",
      status: "sending",
    });
    await sent;
    await store.getState().sendText("второе");

    await vi.waitFor(() =>
      expect(store.getState().messages.map((item) => item.id)).toEqual(["m1"]),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenLastCalledWith("первое", null);
    expect(store.getState().queue.map((item) => item.text)).toEqual(["второе"]);

    firstStatus.resolve(agentMessage("m1", 1, "первое", "completed"));

    await vi.waitFor(() =>
      expect(store.getState().messages.map((item) => item.status)).toEqual([
        "completed",
        "completed",
      ]),
    );
    expect(api.sendMessage).toHaveBeenLastCalledWith("второе", "c1");
    expect(store.getState().queue).toEqual([]);
  });

  it("keeps a voice message ahead of text typed while it uploads", async () => {
    const store = createSessionStore();
    const upload = deferred<AgentMessage>();
    vi.mocked(api.sendAudioMessage).mockReturnValueOnce(upload.promise);
    vi.mocked(api.sendMessage).mockResolvedValueOnce(
      agentMessage("m2", 2, "текст", "queued"),
    );
    vi.mocked(api.getMessage).mockImplementation(async (id) =>
      id === "m1"
        ? agentMessage("m1", 1, "голос", "completed")
        : agentMessage("m2", 2, "текст", "completed"),
    );

    await store.getState().sendAudio(new Blob(["audio"]));
    await store.getState().sendText("текст");
    expect(api.sendMessage).not.toHaveBeenCalled();

    upload.resolve(agentMessage("m1", 1, null, "queued"));

    await vi.waitFor(() =>
      expect(store.getState().messages.map((item) => item.input_text)).toEqual([
        "голос",
        "текст",
      ]),
    );
    expect(api.sendMessage).toHaveBeenCalledWith("текст", "c1");
  });

  it("lets queued messages be edited or removed before they are sent", async () => {
    const store = createSessionStore();
    const first = deferred<AgentMessage>();
    vi.mocked(api.sendMessage)
      .mockResolvedValueOnce(agentMessage("m1", 1, "первое", "queued"))
      .mockResolvedValueOnce(agentMessage("m2", 2, "исправлено", "queued"));
    vi.mocked(api.getMessage).mockImplementation(async (id) =>
      id === "m1"
        ? first.promise
        : agentMessage("m2", 2, "исправлено", "completed"),
    );

    await store.getState().sendText("первое");
    await store.getState().sendText("второе");
    await store.getState().sendText("лишнее");
    await vi.waitFor(() => expect(store.getState().queue).toHaveLength(2));
    const [second, extra] = store.getState().queue;

    store.getState().removeQueued(extra.localId);
    store.getState().editQueued(second.localId);
    first.resolve(agentMessage("m1", 1, "первое", "completed"));
    await vi.waitFor(() =>
      expect(store.getState().messages[0]?.status).toBe("completed"),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    store.getState().saveQueued(second.localId, "исправлено");

    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenLastCalledWith("исправлено", "c1"),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("pauses on a failed send until it is retried", async () => {
    const store = createSessionStore();
    vi.mocked(api.sendMessage)
      .mockRejectedValueOnce(new Error("Сеть недоступна"))
      .mockResolvedValueOnce(agentMessage("m1", 1, "первое", "queued"))
      .mockResolvedValueOnce(agentMessage("m2", 2, "второе", "queued"));
    vi.mocked(api.getMessage).mockImplementation(async (id) =>
      id === "m1"
        ? agentMessage("m1", 1, "первое", "completed")
        : agentMessage("m2", 2, "второе", "completed"),
    );

    await store.getState().sendText("первое");
    await store.getState().sendText("второе");
    await vi.waitFor(() =>
      expect(store.getState().queue[0]?.status).toBe("failed"),
    );
    expect(store.getState().error).toBe("Сеть недоступна");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    store.getState().retryQueued(store.getState().queue[0].localId);

    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenLastCalledWith("второе", "c1"),
    );
  });

  it("drops unsent messages when another conversation is opened", async () => {
    const store = createSessionStore();
    const first = deferred<AgentMessage>();
    vi.mocked(api.sendMessage).mockReturnValueOnce(first.promise);
    vi.mocked(api.getConversationHistory).mockResolvedValue(emptyPage);

    await store.getState().sendText("первое");
    await store.getState().sendText("второе");
    await store.getState().openConversation("c2");
    first.resolve(agentMessage("m1", 1, "первое", "queued"));

    await vi.waitFor(() => expect(store.getState().queue).toEqual([]));
    expect(store.getState().messages).toEqual([]);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("waits for an unfinished message of a reopened conversation", async () => {
    const store = createSessionStore();
    vi.mocked(api.getConversationHistory).mockResolvedValue({
      ...emptyPage,
      items: [agentMessage("m1", 1, "старое", "processing")],
      total: 1,
    });
    vi.mocked(api.getMessage).mockResolvedValue(
      agentMessage("m1", 1, "старое", "completed"),
    );
    vi.mocked(api.sendMessage).mockResolvedValue(
      agentMessage("m2", 2, "новое", "completed"),
    );

    await store.getState().openConversation("c1");
    await store.getState().sendText("новое");

    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith("новое", "c1"),
    );
    expect(api.getMessage).toHaveBeenCalledWith("m1");
  });
});
