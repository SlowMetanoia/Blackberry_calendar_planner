import { createStore, type StoreApi } from "zustand/vanilla";
import {
  authenticate as authenticateRequest,
  clearStoredToken,
  exchangeGoogleLogin,
  getCalendarHistory,
  getConversationHistory,
  getConversations,
  getMessage,
  getStoredToken,
  logoutSession,
  sendAudioMessage,
  sendMessage,
  syncTimeZone,
  undoOperation,
} from "../../api";
import { browserTimeZone } from "../format";
import { collectPages } from "../pagination";
import {
  applyTaskAction,
  taskActionNotices,
  type TaskAction,
} from "../task-actions";
import type {
  AgentMessage,
  CalendarEntry,
  CalendarOperation,
  ConversationSummary,
} from "../../types";

const terminal = new Set(["needs_clarification", "completed", "failed"]);
const pollDelay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type QueuedMessageStatus =
  | "waiting"
  | "sending"
  | "editing"
  | "failed"
  | "capturing";

export type QueuedMessage = {
  localId: string;
  kind: "text" | "audio";
  text: string;
  audio?: Blob;
  createdAt: string;
  status: QueuedMessageStatus;
};

export type TaskNotice = {
  id: number;
  text: string;
  operationId: string | null;
};

export type SessionState = {
  selectionVersion: number;
  voiceTurnActive: boolean;
  beginVoiceTurn: () => boolean;
  endVoiceTurn: () => void;
  reserveAudio: () => string;
  finishAudio: (id: string, blob: Blob) => void;
  cancelAudio: (id: string) => void;
  token: string | null;
  messages: AgentMessage[];
  queue: QueuedMessage[];
  sessions: ConversationSummary[];
  history: CalendarOperation[];
  conversation: string | null;
  error: string;
  calendarRevision: number;
  taskNotice: TaskNotice | null;
  setError: (message: string) => void;
  clearError: () => void;
  authenticate: (
    email: string,
    password: string,
    register: boolean,
  ) => Promise<void>;
  completeGoogleLogin: (code: string) => Promise<void>;
  reset: (message?: string) => void;
  logout: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  bootstrap: () => Promise<void>;
  handleCalendarChanged: () => Promise<void>;
  acceptMessage: (message: AgentMessage) => Promise<void>;
  receiveMessage: (message: AgentMessage, version?: number) => void;
  sendText: (text: string) => Promise<void>;
  sendAudio: (blob: Blob) => Promise<void>;
  removeQueued: (localId: string) => void;
  editQueued: (localId: string) => void;
  saveQueued: (localId: string, text: string) => void;
  cancelEditQueued: (localId: string) => void;
  retryQueued: (localId: string) => void;
  openConversation: (id: string) => Promise<void>;
  startNewConversation: () => void;
  undo: (id: string) => Promise<void>;
  changeTask: (entry: CalendarEntry, action: TaskAction) => Promise<void>;
  undoTaskNotice: () => Promise<void>;
  dismissTaskNotice: () => void;
  getConversationId: () => string | null;
};

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  let selectionVersion = 0;
  let queueCounter = 0;
  let noticeCounter = 0;
  // The selection version whose queued message is currently being posted.
  let postingVersion: number | null = null;

  return createStore<SessionState>()((set, get) => {
    const mergeMessage = (message: AgentMessage) => {
      const state = get();
      if (state.conversation && state.conversation !== message.conversation_id)
        return false;
      const previous = state.messages.find((item) => item.id === message.id);
      if (
        previous &&
        terminal.has(previous.status) &&
        !terminal.has(message.status)
      )
        return false;
      set({
        conversation: message.conversation_id,
        messages: [
          ...state.messages.filter(
            (item) =>
              item.id !== message.id &&
              item.conversation_id === message.conversation_id,
          ),
          message,
        ].sort((left, right) => left.sequence - right.sequence),
      });
      return true;
    };

    const refreshSessions = async () => {
      set({
        sessions: await collectPages((offset) => getConversations(100, offset)),
      });
    };

    const refreshHistory = async () => {
      set({
        history: await collectPages((offset) =>
          getCalendarHistory(100, offset),
        ),
      });
    };

    const updateQueued = (
      localId: string,
      change: Partial<Omit<QueuedMessage, "localId">>,
    ) =>
      set((state) => ({
        queue: state.queue.map((item) =>
          item.localId === localId ? { ...item, ...change } : item,
        ),
      }));

    const agentBusy = () =>
      get().messages.some((message) => !terminal.has(message.status));

    // Queued messages are posted one at a time, and only after the agent has
    // answered the previous one, so the server sees them in the order typed.
    const dispatchQueue = () => {
      const version = selectionVersion;
      const next = get().queue[0];
      if (postingVersion === version || next?.status !== "waiting") return;
      if (agentBusy() || get().voiceTurnActive) return;
      postingVersion = version;
      updateQueued(next.localId, { status: "sending" });
      void (async () => {
        let message: AgentMessage;
        try {
          message =
            next.kind === "audio" && next.audio
              ? await sendAudioMessage(next.audio, get().conversation)
              : await sendMessage(next.text, get().conversation);
        } catch (error) {
          if (postingVersion === version) postingVersion = null;
          if (version !== selectionVersion) return dispatchQueue();
          updateQueued(next.localId, { status: "failed" });
          set({ error: (error as Error).message });
          return;
        }
        if (postingVersion === version) postingVersion = null;
        if (version !== selectionVersion) return dispatchQueue();
        set((state) => ({
          queue: state.queue.filter((item) => item.localId !== next.localId),
        }));
        try {
          await acceptWithVersion(message, version);
        } catch (error) {
          set({ error: (error as Error).message });
        }
      })();
    };

    const enqueue = (item: Pick<QueuedMessage, "kind" | "text" | "audio">) => {
      set((state) => ({
        queue: [
          ...state.queue,
          {
            ...item,
            localId: `local-${++queueCounter}`,
            createdAt: new Date().toISOString(),
            status: "waiting",
          },
        ],
      }));
      dispatchQueue();
    };

    const pollMessage = async (id: string, version: number) => {
      for (;;) {
        let message: AgentMessage;
        try {
          message = await getMessage(id);
        } catch (error) {
          if (version !== selectionVersion) return;
          set({ error: (error as Error).message });
          await pollDelay(2000);
          continue;
        }
        if (version !== selectionVersion) return;
        mergeMessage(message);
        if (terminal.has(message.status)) {
          dispatchQueue();
          await refreshHistory();
          set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
          return;
        }
        await pollDelay(700);
      }
    };

    const acceptWithVersion = async (
      message: AgentMessage,
      version: number,
    ) => {
      if (version !== selectionVersion) return;
      if (!mergeMessage(message)) return;
      void refreshSessions().catch((error) =>
        set({ error: (error as Error).message }),
      );
      await pollMessage(message.id, version);
      if (version === selectionVersion) await refreshSessions();
    };

    const acceptMessage = (message: AgentMessage) =>
      acceptWithVersion(message, selectionVersion);

    const reset = (message = "") => {
      clearStoredToken();
      selectionVersion++;
      set({
        selectionVersion,
        voiceTurnActive: false,
        token: null,
        messages: [],
        queue: [],
        sessions: [],
        history: [],
        conversation: null,
        error: message,
        calendarRevision: 0,
        taskNotice: null,
      });
    };

    return {
      selectionVersion: 0,
      voiceTurnActive: false,
      beginVoiceTurn: () => {
        if (
          get().voiceTurnActive ||
          agentBusy() ||
          get().queue.length ||
          postingVersion === selectionVersion
        )
          return false;
        set({ voiceTurnActive: true });
        return true;
      },
      endVoiceTurn: () => {
        set({ voiceTurnActive: false });
        dispatchQueue();
      },
      reserveAudio: () => {
        const localId = `local-${++queueCounter}`;
        set((state) => ({
          queue: [
            ...state.queue,
            {
              localId,
              kind: "audio",
              text: "",
              createdAt: new Date().toISOString(),
              status: "capturing",
            },
          ],
        }));
        return localId;
      },
      finishAudio: (id, blob) => {
        if (!blob.size) return get().cancelAudio(id);
        if (
          !get().queue.some(
            (item) => item.localId === id && item.status === "capturing",
          )
        )
          return;
        updateQueued(id, { audio: blob, status: "waiting" });
        dispatchQueue();
      },
      cancelAudio: (id) => {
        set((state) => ({
          queue: state.queue.filter((item) => item.localId !== id),
        }));
        dispatchQueue();
      },
      token: getStoredToken(),
      messages: [],
      queue: [],
      sessions: [],
      history: [],
      conversation: null,
      error: "",
      calendarRevision: 0,
      taskNotice: null,

      setError: (message) => set({ error: message }),
      clearError: () => set({ error: "" }),

      authenticate: async (email, password, register) => {
        set({ error: "" });
        try {
          set({ token: await authenticateRequest(email, password, register) });
        } catch (error) {
          set({ error: (error as Error).message });
        }
      },

      completeGoogleLogin: async (code) => {
        set({ error: "" });
        try {
          set({ token: await exchangeGoogleLogin(code) });
        } catch (error) {
          set({ error: (error as Error).message });
        }
      },

      reset,

      logout: async () => {
        try {
          await logoutSession();
        } catch {
          // The local session is cleared even when the server is unavailable.
        } finally {
          reset();
        }
      },

      refreshSessions,
      refreshHistory,

      bootstrap: async () => {
        const token = get().token;
        if (!token) return;
        try {
          await Promise.all([refreshSessions(), refreshHistory()]);
        } catch (error) {
          if (get().token === token) set({ error: (error as Error).message });
        }
        try {
          await syncTimeZone(browserTimeZone());
        } catch (error) {
          if (get().token === token) set({ error: (error as Error).message });
        }
      },

      handleCalendarChanged: async () => {
        await refreshHistory();
        set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
      },

      acceptMessage,
      receiveMessage: (message, version = selectionVersion) => {
        if (version !== selectionVersion || !mergeMessage(message)) return;
        if (terminal.has(message.status)) {
          dispatchQueue();
          void refreshHistory().catch((error) =>
            set({ error: (error as Error).message }),
          );
          set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
        }
        void refreshSessions().catch((error) =>
          set({ error: (error as Error).message }),
        );
      },

      sendText: async (text) => {
        if (!text.trim()) return;
        enqueue({ kind: "text", text: text.trim() });
      },

      sendAudio: async (blob) => {
        if (!blob.size) return;
        enqueue({ kind: "audio", text: "", audio: blob });
      },

      removeQueued: (localId) => {
        set((state) => ({
          queue: state.queue.filter(
            (item) => item.localId !== localId || item.status === "sending",
          ),
        }));
        dispatchQueue();
      },

      editQueued: (localId) => {
        const item = get().queue.find((entry) => entry.localId === localId);
        if (item?.kind !== "text" || item.status === "sending") return;
        updateQueued(localId, { status: "editing" });
      },

      saveQueued: (localId, text) => {
        const item = get().queue.find((entry) => entry.localId === localId);
        if (item?.status !== "editing") return;
        if (!text.trim()) {
          get().removeQueued(localId);
          return;
        }
        updateQueued(localId, { text: text.trim(), status: "waiting" });
        dispatchQueue();
      },

      cancelEditQueued: (localId) => {
        const item = get().queue.find((entry) => entry.localId === localId);
        if (item?.status !== "editing") return;
        updateQueued(localId, { status: "waiting" });
        dispatchQueue();
      },

      retryQueued: (localId) => {
        const item = get().queue.find((entry) => entry.localId === localId);
        if (item?.status !== "failed") return;
        updateQueued(localId, { status: "waiting" });
        dispatchQueue();
      },

      openConversation: async (id) => {
        const version = ++selectionVersion;
        set({
          selectionVersion: version,
          voiceTurnActive: false,
          conversation: id,
          messages: [],
          queue: [],
          error: "",
        });
        try {
          const all = await collectPages((offset) =>
            getConversationHistory(id, 100, offset),
          );
          if (version !== selectionVersion) return;
          set({
            messages: all
              .filter((m) => m.conversation_id === id)
              .sort((a, b) => a.sequence - b.sequence),
          });
          all
            .filter((message) => !terminal.has(message.status))
            .forEach((message) => void pollMessage(message.id, version));
          dispatchQueue();
        } catch (error) {
          if (version === selectionVersion)
            set({ error: (error as Error).message });
        }
      },

      startNewConversation: () => {
        selectionVersion++;
        set({
          selectionVersion,
          voiceTurnActive: false,
          conversation: null,
          messages: [],
          queue: [],
          error: "",
        });
      },

      undo: async (id) => {
        try {
          await undoOperation(id);
          await refreshHistory();
          set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
        } catch (error) {
          set({ error: (error as Error).message });
        }
      },

      changeTask: async (entry, action) => {
        try {
          await applyTaskAction(entry, action);
          await refreshHistory();
        } catch (error) {
          set({ error: (error as Error).message });
          return;
        } finally {
          set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
        }
        // History is newest first, so the first REST change of this task is ours.
        const operation = get().history.find(
          (item) => item.target_id === entry.id && item.origin === "rest",
        );
        set({
          taskNotice: {
            id: ++noticeCounter,
            text: `Задача «${entry.title}» ${taskActionNotices[action]}`,
            operationId: operation?.id ?? null,
          },
        });
      },

      undoTaskNotice: async () => {
        const notice = get().taskNotice;
        set({ taskNotice: null });
        if (notice?.operationId) await get().undo(notice.operationId);
      },

      dismissTaskNotice: () => set({ taskNotice: null }),

      getConversationId: () => get().conversation,
    };
  });
}
