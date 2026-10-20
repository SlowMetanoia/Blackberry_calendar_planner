import { useCallback, useEffect, useRef, useState } from "react";
import {
  authenticate,
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

export function usePlannerSession() {
  const [token, setToken] = useState<string | null>(getStoredToken);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [history, setHistory] = useState<CalendarOperation[]>([]);
  const [conversation, setConversation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [calendarRevision, setCalendarRevision] = useState(0);
  const selectionVersion = useRef(0);
  const conversationRef = useRef<string | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessions(await collectPages((offset) => getConversations(100, offset)));
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory(await collectPages((offset) => getCalendarHistory(100, offset)));
  }, []);

  const reset = useCallback((message = "") => {
    clearStoredToken();
    selectionVersion.current++;
    conversationRef.current = null;
    setToken(null);
    setSessions([]);
    setHistory([]);
    setConversation(null);
    setMessages([]);
    setError(message);
  }, []);

  useEffect(() => {
    if (!token) return;
    void Promise.all([refreshSessions(), refreshHistory()]).catch((e) =>
      setError((e as Error).message),
    );
    syncTimeZone(browserTimeZone()).catch((e) =>
      setError((e as Error).message),
    );
  }, [token, refreshHistory, refreshSessions]);

  const authenticateUser = useCallback(
    async (email: string, password: string, register: boolean) => {
      setError("");
      try {
        setToken(await authenticate(email, password, register));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  const mergeMessage = useCallback((message: AgentMessage) => {
    setMessages((old) =>
      [...old.filter((item) => item.id !== message.id), message].sort(
        (a, b) => a.sequence - b.sequence,
      ),
    );
  }, []);

  const pollMessage = useCallback(
    async (id: string, version: number) => {
      for (;;) {
        const message = await getMessage(id);
        if (version !== selectionVersion.current) return;
        mergeMessage(message);
        if (terminal.has(message.status)) {
          await refreshHistory();
          setCalendarRevision((value) => value + 1);
          return;
        }
        await pollDelay(700);
      }
    },
    [mergeMessage, refreshHistory],
  );

  const acceptWithVersion = useCallback(
    async (message: AgentMessage, version: number) => {
      if (version !== selectionVersion.current) return;
      mergeMessage(message);
      conversationRef.current = message.conversation_id;
      setConversation(message.conversation_id);
      void refreshSessions();
      await pollMessage(message.id, version);
      if (version === selectionVersion.current) await refreshSessions();
    },
    [mergeMessage, pollMessage, refreshSessions],
  );

  const acceptMessage = useCallback(
    (message: AgentMessage) =>
      acceptWithVersion(message, selectionVersion.current),
    [acceptWithVersion],
  );

  const sendText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      const version = selectionVersion.current;
      try {
        await acceptWithVersion(
          await sendMessage(text.trim(), conversationRef.current),
          version,
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [acceptWithVersion],
  );

  const sendAudio = useCallback(
    async (blob: Blob) => {
      if (!blob.size) return;
      const version = selectionVersion.current;
      try {
        await acceptWithVersion(
          await sendAudioMessage(blob, conversationRef.current),
          version,
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [acceptWithVersion],
  );

  const openConversation = useCallback(async (id: string) => {
    const version = ++selectionVersion.current;
    conversationRef.current = id;
    setConversation(id);
    setMessages([]);
    setError("");
    try {
      const all = await collectPages((offset) =>
        getConversationHistory(id, 100, offset),
      );
      if (version === selectionVersion.current) setMessages(all);
    } catch (e) {
      if (version === selectionVersion.current) setError((e as Error).message);
    }
  }, []);

  const startNewConversation = useCallback(() => {
    selectionVersion.current++;
    conversationRef.current = null;
    setConversation(null);
    setMessages([]);
    setError("");
  }, []);

  const undo = useCallback(
    async (id: string) => {
      try {
        await undoOperation(id);
        await refreshHistory();
        setCalendarRevision((value) => value + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshHistory],
  );

  const handleCalendarChanged = useCallback(async () => {
    await refreshHistory();
    setCalendarRevision((value) => value + 1);
  }, [refreshHistory]);

  const logout = useCallback(async () => {
    try {
      await logoutSession();
    } catch {
      // The local session is cleared even when the server is unavailable.
    } finally {
      reset();
    }
  }, [reset]);

  const getConversationId = useCallback(() => conversationRef.current, []);
  const clearError = useCallback(() => setError(""), []);

  return {
    token,
    messages,
    sessions,
    history,
    conversation,
    error,
    calendarRevision,
    setError,
    clearError,
    authenticate: authenticateUser,
    reset,
    logout,
    refreshSessions,
    refreshHistory,
    handleCalendarChanged,
    acceptMessage,
    sendText,
    sendAudio,
    openConversation,
    startNewConversation,
    undo,
    getConversationId,
  };
}
