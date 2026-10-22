import { createStore, type StoreApi } from "zustand/vanilla";
import {
  authenticate as authenticateRequest,
  clearStoredToken,
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
import type {
  AgentMessage,
  CalendarOperation,
  ConversationSummary,
} from "../../types";

const terminal = new Set(["needs_clarification", "completed", "failed"]);
const pollDelay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type SessionState = {
  token: string | null;
  messages: AgentMessage[];
  sessions: ConversationSummary[];
  history: CalendarOperation[];
  conversation: string | null;
  error: string;
  calendarRevision: number;
  setError: (message: string) => void;
  clearError: () => void;
  authenticate: (
    email: string,
    password: string,
    register: boolean,
  ) => Promise<void>;
  reset: (message?: string) => void;
  logout: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  bootstrap: () => Promise<void>;
  handleCalendarChanged: () => Promise<void>;
  acceptMessage: (message: AgentMessage) => Promise<void>;
  receiveMessage: (message: AgentMessage) => void;
  sendText: (text: string) => Promise<void>;
  sendAudio: (blob: Blob) => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  startNewConversation: () => void;
  undo: (id: string) => Promise<void>;
  getConversationId: () => string | null;
};

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  let selectionVersion = 0;

  return createStore<SessionState>()((set, get) => {
    const mergeMessage = (message: AgentMessage) =>
      set((state) => ({
        messages: [
          ...state.messages.filter((item) => item.id !== message.id),
          message,
        ].sort((left, right) => left.sequence - right.sequence),
      }));

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

    const pollMessage = async (id: string, version: number) => {
      for (;;) {
        const message = await getMessage(id);
        if (version !== selectionVersion) return;
        mergeMessage(message);
        if (terminal.has(message.status)) {
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
      mergeMessage(message);
      set({ conversation: message.conversation_id });
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
        token: null,
        messages: [],
        sessions: [],
        history: [],
        conversation: null,
        error: message,
        calendarRevision: 0,
      });
    };

    return {
      token: getStoredToken(),
      messages: [],
      sessions: [],
      history: [],
      conversation: null,
      error: "",
      calendarRevision: 0,

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
          if (get().token === token)
            set({ error: (error as Error).message });
        }
        try {
          await syncTimeZone(browserTimeZone());
        } catch (error) {
          if (get().token === token)
            set({ error: (error as Error).message });
        }
      },

      handleCalendarChanged: async () => {
        await refreshHistory();
        set((state) => ({ calendarRevision: state.calendarRevision + 1 }));
      },

      acceptMessage,
      receiveMessage: (message) => {
        mergeMessage(message);
        set({ conversation: message.conversation_id });
        if (terminal.has(message.status)) {
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
        const version = selectionVersion;
        try {
          await acceptWithVersion(
            await sendMessage(text.trim(), get().conversation),
            version,
          );
        } catch (error) {
          set({ error: (error as Error).message });
        }
      },

      sendAudio: async (blob) => {
        if (!blob.size) return;
        const version = selectionVersion;
        try {
          await acceptWithVersion(
            await sendAudioMessage(blob, get().conversation),
            version,
          );
        } catch (error) {
          set({ error: (error as Error).message });
        }
      },

      openConversation: async (id) => {
        const version = ++selectionVersion;
        set({ conversation: id, messages: [], error: "" });
        try {
          const all = await collectPages((offset) =>
            getConversationHistory(id, 100, offset),
          );
          if (version === selectionVersion) set({ messages: all });
        } catch (error) {
          if (version === selectionVersion)
            set({ error: (error as Error).message });
        }
      },

      startNewConversation: () => {
        selectionVersion++;
        set({ conversation: null, messages: [], error: "" });
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

      getConversationId: () => get().conversation,
    };
  });
}
