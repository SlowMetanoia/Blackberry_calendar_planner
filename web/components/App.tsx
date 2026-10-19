import {
  FormEvent,
  Fragment,
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AUTH_EXPIRED_EVENT,
  authenticate,
  clearStoredToken,
  getCalendarHistory,
  getConversationHistory,
  getConversations,
  getMessage,
  getStoredToken,
  getUserPreferences,
  logoutSession,
  sendAudioMessage,
  sendMessage,
  syncTimeZone,
  transcribeAudio,
  undoOperation,
  updateUserPreferences,
} from "../api";
import {
  browserTimeZone,
  formatHistoryDate,
  formatSessionTimestamp,
  historyDateKey,
} from "../libs/format";
import { extractIvoryCommand, OpenAirCapture } from "../libs/open-air";
import { collectPages } from "../libs/pagination";
import type {
  AgentMessage,
  CalendarOperation,
  ConversationSummary,
  OpenAirStatus,
} from "../types";
import { HistoryItem } from "./HistoryItem";
import { MessageExchange } from "./MessageExchange";
import { PlannerSidebar } from "./PlannerSidebar";

const terminal = new Set(["needs_clarification", "completed", "failed"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const openAirLabels: Record<OpenAirStatus, string> = {
  off: "Ivory выключена",
  starting: "Подключаю микрофон…",
  listening: "Слушаю «Ivory»",
  hearing: "Слышу речь…",
  recognizing: "Распознаю обращение…",
  error: "Open-air временно недоступен",
};

export default function App() {
  const [token, setToken] = useState(getStoredToken);
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  const [text, setText] = useState(""),
    [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessions, setSessions] = useState<ConversationSummary[]>([]),
    [history, setHistory] = useState<CalendarOperation[]>([]);
  const [conversation, setConversation] = useState<string | null>(null),
    [error, setError] = useState("");
  const [recording, setRecording] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(false),
    [plannerOpen, setPlannerOpen] = useState(false),
    [sessionsOpen, setSessionsOpen] = useState(false),
    [calendarRevision, setCalendarRevision] = useState(0);
  const [openAirEnabled, setOpenAirEnabled] = useState(false),
    [openAirStatus, setOpenAirStatus] = useState<OpenAirStatus>("off"),
    [openAirSilenceMs, setOpenAirSilenceMs] = useState(1500);
  const recorder = useRef<MediaRecorder | null>(null),
    chunks = useRef<Blob[]>([]),
    selectionVersion = useRef(0),
    chat = useRef<HTMLElement | null>(null),
    conversationRef = useRef<string | null>(null),
    openAirCapture = useRef<OpenAirCapture | null>(null),
    openAirActive = useRef(false),
    openAirGeneration = useRef(0),
    openAirQueue = useRef<Promise<void>>(Promise.resolve());

  function stopOpenAir() {
    openAirGeneration.current++;
    openAirActive.current = false;
    openAirCapture.current?.stop();
    openAirCapture.current = null;
    setOpenAirEnabled(false);
    setOpenAirStatus("off");
  }
  function clearAuthentication(message = "") {
    stopOpenAir();
    clearStoredToken();
    selectionVersion.current++;
    conversationRef.current = null;
    setToken(null);
    setSessions([]);
    setHistory([]);
    setConversation(null);
    setMessages([]);
    setSessionsOpen(false);
    setSidebarOpen(false);
    setPlannerOpen(false);
    setError(message);
  }
  useEffect(() => {
    const expired = () =>
      clearAuthentication("Сессия истекла или недействительна. Войдите снова.");
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);

  async function refreshSessions() {
    setSessions(await collectPages((offset) => getConversations(100, offset)));
  }
  async function refreshHistory() {
    setHistory(await collectPages((offset) => getCalendarHistory(100, offset)));
  }
  useEffect(() => {
    if (!token) return;
    void Promise.all([
      refreshSessions(),
      refreshHistory(),
      getUserPreferences().then((preferences) =>
        setOpenAirSilenceMs(preferences.open_air_silence_ms),
      ),
    ]).catch((e) => setError((e as Error).message));
    syncTimeZone(browserTimeZone()).catch((e) =>
      setError((e as Error).message),
    );
  }, [token]);
  useEffect(() => {
    if (messages.length)
      requestAnimationFrame(() =>
        chat.current?.scrollTo({
          top: chat.current.scrollHeight,
          behavior: "smooth",
        }),
      );
  }, [messages]);
  useEffect(() => () => openAirCapture.current?.stop(), []);

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      setToken(await authenticate(email, password, register));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function mergeMessage(message: AgentMessage) {
    setMessages((old) =>
      [...old.filter((item) => item.id !== message.id), message].sort(
        (a, b) => a.sequence - b.sequence,
      ),
    );
  }
  async function pollMessage(id: string, version: number) {
    for (;;) {
      const message = await getMessage(id);
      if (version !== selectionVersion.current) return;
      mergeMessage(message);
      if (terminal.has(message.status)) {
        await refreshHistory();
        setCalendarRevision((value) => value + 1);
        return;
      }
      await delay(700);
    }
  }
  async function acceptMessage(message: AgentMessage, version: number) {
    if (version !== selectionVersion.current) return;
    mergeMessage(message);
    conversationRef.current = message.conversation_id;
    setConversation(message.conversation_id);
    void refreshSessions();
    await pollMessage(message.id, version);
    if (version === selectionVersion.current) await refreshSessions();
  }
  async function sendText(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const version = selectionVersion.current;
    setText("");
    try {
      await acceptMessage(
        await sendMessage(text.trim(), conversation),
        version,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function sendAudio(blob: Blob) {
    if (!blob.size) return;
    const version = selectionVersion.current;
    try {
      await acceptMessage(await sendAudioMessage(blob, conversation), version);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function processOpenAirPhrase(audio: Blob, generation: number) {
    openAirQueue.current = openAirQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          if (
            !openAirActive.current ||
            generation !== openAirGeneration.current
          )
            return;
          const command = extractIvoryCommand(await transcribeAudio(audio));
          if (
            !command ||
            !openAirActive.current ||
            generation !== openAirGeneration.current
          )
            return;
          const version = selectionVersion.current,
            message = await sendMessage(command, conversationRef.current);
          void acceptMessage(message, version);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          if (openAirActive.current && generation === openAirGeneration.current)
            setOpenAirStatus("listening");
        }
      });
  }
  async function toggleOpenAir() {
    if (openAirActive.current) {
      stopOpenAir();
      return;
    }
    setError("");
    const generation = ++openAirGeneration.current;
    openAirActive.current = true;
    setOpenAirEnabled(true);
    setOpenAirStatus("starting");
    const capture = new OpenAirCapture({
      silenceMs: openAirSilenceMs,
      onPhrase: (audio) => processOpenAirPhrase(audio, generation),
      onStatus: (status) => {
        if (openAirActive.current || status === "off") setOpenAirStatus(status);
      },
    });
    openAirCapture.current = capture;
    try {
      await capture.start();
    } catch {
      if (openAirCapture.current === capture) {
        stopOpenAir();
        setError("Не удалось запустить open-air: проверьте доступ к микрофону");
      }
    }
  }
  async function changeOpenAirSilence(value: number) {
    const previous = openAirSilenceMs;
    setOpenAirSilenceMs(value);
    openAirCapture.current?.updateSilenceMs(value);
    try {
      const preferences = await updateUserPreferences({
        open_air_silence_ms: value,
      });
      setOpenAirSilenceMs(preferences.open_air_silence_ms);
    } catch (e) {
      setOpenAirSilenceMs(previous);
      openAirCapture.current?.updateSilenceMs(previous);
      setError((e as Error).message);
    }
  }
  async function startRecording(event: PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      const media = new MediaRecorder(stream);
      recorder.current = media;
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        void sendAudio(
          new Blob(chunks.current, { type: media.mimeType || "audio/webm" }),
        );
      };
      media.start();
      setRecording(true);
    } catch {
      setError("Не удалось получить доступ к микрофону");
    }
  }
  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function openConversation(id: string) {
    const version = ++selectionVersion.current;
    conversationRef.current = id;
    setConversation(id);
    setMessages([]);
    setSessionsOpen(false);
    setError("");
    try {
      const all = await collectPages((offset) =>
        getConversationHistory(id, 100, offset),
      );
      if (version === selectionVersion.current) setMessages(all);
    } catch (e) {
      if (version === selectionVersion.current) setError((e as Error).message);
    }
  }
  function startNewConversation() {
    selectionVersion.current++;
    conversationRef.current = null;
    setConversation(null);
    setMessages([]);
    setSessionsOpen(false);
    setSidebarOpen(false);
    setPlannerOpen(false);
    setError("");
  }
  async function undo(id: string) {
    try {
      await undoOperation(id);
      await refreshHistory();
      setCalendarRevision((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function logout() {
    try {
      await logoutSession();
    } catch {
    } finally {
      clearAuthentication();
    }
  }

  if (!token)
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">День за днём</div>
          <h1>{register ? "Создать аккаунт" : "Войти в ежедневник"}</h1>
          <p>Задачи и встречи — просто скажите, что нужно.</p>
          <form onSubmit={submitCredentials}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Пароль
              <input
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary">
              {register ? "Зарегистрироваться" : "Войти"}
            </button>
          </form>
          <button className="link" onClick={() => setRegister(!register)}>
            {register ? "Уже есть аккаунт" : "Нет аккаунта? Создать"}
          </button>
          {error && <div className="error">{error}</div>}
        </section>
      </main>
    );

  return (
    <main className="app-shell">
      <div
        className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />
      <div
        className={`planner-scrim ${plannerOpen ? "visible" : ""}`}
        onClick={() => setPlannerOpen(false)}
      />
      <aside
        className={`session-sidebar operation-sidebar ${sidebarOpen ? "open" : ""}`}
      >
        <div className="sidebar-head">
          <div>
            <div className="eyebrow">Календарь</div>
            <b>История изменений</b>
          </div>
          <button
            className="sidebar-close"
            aria-label="Закрыть историю"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>
        <nav
          className="operation-list"
          aria-label="История изменений календаря"
        >
          {history.map((item, index) => {
            const showDate =
              index === 0 ||
              historyDateKey(item.created_at) !==
                historyDateKey(history[index - 1].created_at);
            return (
              <Fragment key={item.id}>
                {showDate && (
                  <div className="history-date">
                    <span>{formatHistoryDate(item.created_at)}</span>
                  </div>
                )}
                <HistoryItem item={item} undo={undo} />
              </Fragment>
            );
          })}
          {!history.length && (
            <p className="sessions-empty">
              Изменения календаря появятся здесь.
            </p>
          )}
        </nav>
      </aside>
      <section className="workspace">
        <header>
          <button
            className="sessions-toggle"
            aria-label="Открыть историю изменений"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <div>
            <div className="eyebrow">Умный ежедневник</div>
            <h1>Что запланируем?</h1>
          </div>
          <div className="header-actions">
            <button
              className="quiet planner-toggle"
              onClick={() => setPlannerOpen(true)}
            >
              Планы
            </button>
            <button className="quiet" onClick={startNewConversation}>
              Новый диалог
            </button>
            <button className="quiet" onClick={() => setSessionsOpen(true)}>
              История сессий
            </button>
            <button className="quiet" onClick={() => void logout()}>
              Выйти
            </button>
          </div>
        </header>
        <section className="chat" ref={chat} aria-live="polite">
          {!messages.length && (
            <div className="empty">
              <span>✦</span>
              <h2>Начните с простой просьбы</h2>
              <p>«Покажи задачи на сегодня» или «Напомни подготовить отчёт»</p>
            </div>
          )}
          {messages.map((message) => (
            <MessageExchange
              key={message.id}
              message={message}
              startNewConversation={startNewConversation}
            />
          ))}
        </section>
        {error && (
          <div className="toast">
            {error}
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        <footer>
          <form className="composer" onSubmit={sendText}>
            <input
              aria-label="Сообщение"
              placeholder="Напишите задачу или вопрос…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="send" aria-label="Отправить">
              ↑
            </button>
            <button
              type="button"
              className={`open-air-toggle ${openAirEnabled ? "active" : ""}`}
              aria-label={`${openAirEnabled ? "Выключить" : "Включить"} open-air режим Ivory`}
              aria-pressed={openAirEnabled}
              onClick={() => void toggleOpenAir()}
            >
              Ivory
            </button>
            <button
              type="button"
              disabled={openAirEnabled}
              className={`mic ${recording ? "recording" : ""}`}
              aria-label="Удерживайте для записи"
              onPointerDown={startRecording}
              onPointerUp={stopRecording}
              onPointerCancel={stopRecording}
            >
              {recording ? "■" : "●"}
            </button>
          </form>
          <div className="voice-footer">
            <small>
              {openAirEnabled
                ? openAirLabels[openAirStatus]
                : recording
                  ? "Отпустите, чтобы отправить"
                  : "Удерживайте красную кнопку для записи"}
            </small>
            {openAirEnabled && (
              <label className="open-air-setting">
                Пауза{" "}
                <select
                  aria-label="Пауза перед отправкой"
                  value={openAirSilenceMs}
                  onChange={(event) =>
                    void changeOpenAirSilence(Number(event.target.value))
                  }
                >
                  <option value={1000}>1 с</option>
                  <option value={1500}>1,5 с</option>
                  <option value={2000}>2 с</option>
                  <option value={3000}>3 с</option>
                  <option value={5000}>5 с</option>
                </select>
              </label>
            )}
          </div>
        </footer>
      </section>
      <PlannerSidebar
        open={plannerOpen}
        onClose={() => setPlannerOpen(false)}
        revision={calendarRevision}
        onHistoryChanged={async () => {
          await refreshHistory();
          setCalendarRevision((value) => value + 1);
        }}
        onError={setError}
      />
      {sessionsOpen && (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={() => setSessionsOpen(false)}
        >
          <section
            className="sessions-modal"
            role="dialog"
            aria-modal="true"
            aria-label="История сессий"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="sidebar-head">
              <div>
                <div className="eyebrow">Диалоги</div>
                <h2>История сессий</h2>
              </div>
              <button
                className="sidebar-close"
                aria-label="Закрыть историю сессий"
                onClick={() => setSessionsOpen(false)}
              >
                ×
              </button>
            </div>
            <nav className="session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item ${conversation === session.id ? "active" : ""}`}
                  onClick={() => void openConversation(session.id)}
                >
                  <span>{session.preview}</span>
                  <time>
                    {formatSessionTimestamp(session.last_activity_at)}
                  </time>
                </button>
              ))}
              {!sessions.length && (
                <p className="sessions-empty">
                  Здесь появятся прошлые диалоги.
                </p>
              )}
            </nav>
          </section>
        </div>
      )}
    </main>
  );
}
