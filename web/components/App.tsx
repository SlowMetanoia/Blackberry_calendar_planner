import {
  FormEvent,
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AudioLinesIcon,
  ArrowUpIcon,
  HistoryIcon,
  LogOutIcon,
  MenuIcon,
  MicIcon,
  NotebookPenIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
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
  formatSessionTimestamp,
} from "../libs/format";
import { extractIvoryCommand, OpenAirCapture } from "../libs/open-air";
import { collectPages } from "../libs/pagination";
import type {
  AgentMessage,
  CalendarOperation,
  ConversationSummary,
  OpenAirStatus,
  PlannerView,
} from "../types";
import { Alert, AlertAction, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NativeSelect } from "./ui/native-select";
import { ScrollArea } from "./ui/scroll-area";
import { AppSidebar } from "./AppSidebar";
import { CalendarView } from "./CalendarView";
import { HistoryPanel } from "./HistoryPanel";
import { MessageExchange } from "./MessageExchange";

const terminal = new Set(["needs_clarification", "completed", "failed"]);
const viewTitles: Record<PlannerView, string> = {
  chat: "Что запланируем?",
  calendar: "Календарь",
  history: "История изменений",
};
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
    [view, setView] = useState<PlannerView>("chat"),
    [navOpen, setNavOpen] = useState(false),
    [sessionsOpen, setSessionsOpen] = useState(false),
    [calendarRevision, setCalendarRevision] = useState(0);
  const [openAirEnabled, setOpenAirEnabled] = useState(false),
    [openAirStatus, setOpenAirStatus] = useState<OpenAirStatus>("off"),
    [openAirSilenceMs, setOpenAirSilenceMs] = useState(1500);
  const recorder = useRef<MediaRecorder | null>(null),
    chunks = useRef<Blob[]>([]),
    selectionVersion = useRef(0),
    chat = useRef<HTMLDivElement | null>(null),
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
    setNavOpen(false);
    setView("chat");
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
    setView("chat");
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
    setNavOpen(false);
    setView("chat");
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
      <main className="grid min-h-dvh place-items-center bg-secondary/40 p-5">
        <div className="w-full max-w-md">
          <Card className="gap-0 shadow-sm ring-border">
            <CardHeader className="gap-1.5 p-6 pb-0 sm:p-7 sm:pb-0">
              <span
                aria-hidden="true"
                className="mb-1 grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground"
              >
                <NotebookPenIcon className="size-4" />
              </span>
              <CardTitle asChild>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">
                  {register ? "Создать аккаунт" : "Войти в ежедневник"}
                </h1>
              </CardTitle>
              <CardDescription>
                Задачи и встречи голосом или текстом.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-6 pt-6 sm:p-7 sm:pt-6">
              <form className="grid gap-4" onSubmit={submitCredentials}>
                <div className="grid gap-1.5">
                  <Label htmlFor="auth-email">Email</Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="auth-password">Пароль</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button className="w-full" size="lg">
                  {register ? "Зарегистрироваться" : "Войти"}
                </Button>
              </form>
              <Button
                variant="link"
                className="mx-auto h-auto w-fit px-0 text-muted-foreground"
                onClick={() => setRegister(!register)}
              >
                {register ? "Уже есть аккаунт" : "Нет аккаунта? Создать"}
              </Button>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    );

  return (
    <div className="h-dvh w-full bg-[linear-gradient(to_right,var(--sidebar)_0%,var(--sidebar)_50%,var(--background)_50%,var(--background)_100%)]">
      <main className="mx-auto flex h-full w-full max-w-[1680px] overflow-hidden bg-background">
        <div
          aria-hidden="true"
          className={`fixed inset-0 z-40 bg-foreground/30 md:hidden ${
            navOpen ? "block" : "hidden"
          }`}
          onClick={() => setNavOpen(false)}
        />
        <AppSidebar
          view={view}
          open={navOpen}
          onSelect={(next) => {
            setView(next);
            setNavOpen(false);
          }}
          onClose={() => setNavOpen(false)}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col md:border-l md:border-border/60">
          <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-7">
            <div className="flex min-w-0 items-center gap-1.5">
              <Button
                className="shrink-0 md:hidden"
                variant="ghost"
                size="icon-sm"
                aria-label="Открыть меню"
                onClick={() => setNavOpen(true)}
              >
                <MenuIcon aria-hidden="true" />
              </Button>
              <h1 className="truncate font-heading text-xl font-semibold tracking-tight sm:text-2xl">
                {viewTitles[view]}
              </h1>
            </div>
            <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-1">
              {view === "chat" && (
                <>
                  <Button variant="ghost" size="sm" onClick={startNewConversation}>
                    <PlusIcon aria-hidden="true" />
                    Новый диалог
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSessionsOpen(true)}
                  >
                    <HistoryIcon aria-hidden="true" />
                    История сессий
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" onClick={() => void logout()}>
                <LogOutIcon aria-hidden="true" />
                Выйти
              </Button>
            </div>
          </header>

          <div
            className={
              view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <ScrollArea
              className="min-h-0 flex-1"
              viewportClassName="chat px-4 py-6 sm:px-8"
              viewportRef={chat}
              aria-live="polite"
            >
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                {messages.map((message) => (
                  <MessageExchange
                    key={message.id}
                    message={message}
                    startNewConversation={startNewConversation}
                  />
                ))}
              </div>
            </ScrollArea>

            <footer className="border-t bg-muted/30 px-4 py-3 sm:px-6">
              <form className="flex items-center gap-2" onSubmit={sendText}>
                <Input
                  aria-label="Сообщение"
                  placeholder="Напишите задачу или вопрос…"
                  className="h-11 flex-1 bg-card"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button
                  type="submit"
                  size="icon-lg"
                  aria-label="Отправить"
                  className="shrink-0"
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant={openAirEnabled ? "highlight" : "outline"}
                  size="lg"
                  className="shrink-0"
                  aria-label={`${openAirEnabled ? "Выключить" : "Включить"} open-air режим Ivory`}
                  aria-pressed={openAirEnabled}
                  onClick={() => void toggleOpenAir()}
                >
                  <AudioLinesIcon aria-hidden="true" />
                  Ivory
                </Button>
                <Button
                  type="button"
                  variant={recording ? "destructive" : "secondary"}
                  size="icon-lg"
                  className="mic shrink-0 touch-none"
                  disabled={openAirEnabled}
                  aria-label="Удерживайте для записи"
                  onPointerDown={startRecording}
                  onPointerUp={stopRecording}
                  onPointerCancel={stopRecording}
                >
                  {recording ? (
                    <SquareIcon aria-hidden="true" />
                  ) : (
                    <MicIcon aria-hidden="true" />
                  )}
                </Button>
              </form>
              <div className="mt-2 flex min-h-5 flex-wrap items-center justify-end gap-3">
                <small className="text-[11px] text-muted-foreground">
                  {openAirEnabled
                    ? openAirLabels[openAirStatus]
                    : recording
                      ? "Отпустите, чтобы отправить"
                      : "Удерживайте микрофон для записи"}
                </small>
                {openAirEnabled && (
                  <>
                    <Label
                      htmlFor="open-air-silence"
                      className="text-[11px] text-muted-foreground"
                    >
                      Пауза
                    </Label>
                    <span className="w-[76px] shrink-0">
                      <NativeSelect
                        id="open-air-silence"
                        aria-label="Пауза перед отправкой"
                        className="h-7 text-xs"
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
                      </NativeSelect>
                    </span>
                  </>
                )}
              </div>
            </footer>
          </div>

          <div
            className={
              view === "calendar" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <CalendarView
              revision={calendarRevision}
              onHistoryChanged={async () => {
                await refreshHistory();
                setCalendarRevision((value) => value + 1);
              }}
              onError={setError}
            />
          </div>

          <div
            className={
              view === "history" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <HistoryPanel items={history} undo={undo} />
          </div>

          {error && (
            <Alert
              variant="destructive"
              className="fixed top-4 left-1/2 z-[120] w-auto max-w-[calc(100vw-2rem)] -translate-x-1/2 bg-popover shadow-lg"
            >
              <AlertDescription>{error}</AlertDescription>
              <AlertAction>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Закрыть уведомление"
                  onClick={() => setError("")}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </AlertAction>
            </Alert>
          )}
        </section>

        <Dialog open={sessionsOpen} onOpenChange={setSessionsOpen}>
          <DialogContent
            closeLabel="Закрыть историю сессий"
            className="sm:max-w-lg"
          >
            <DialogHeader className="gap-1.5 pr-8">
              <DialogTitle className="text-xl">История сессий</DialogTitle>
              <DialogDescription>
                Вернитесь к прошлому разговору или начните новый.
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[55vh]">
              <div className="grid gap-1.5 pr-2">
                {sessions.map((session) => (
                  <Button
                    key={session.id}
                    variant={conversation === session.id ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal"
                    onClick={() => void openConversation(session.id)}
                  >
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="truncate text-sm font-medium">
                        {session.preview}
                      </span>
                      <time className="text-[11px] font-normal text-muted-foreground">
                        {formatSessionTimestamp(session.last_activity_at)}
                      </time>
                    </span>
                  </Button>
                ))}
                {!sessions.length && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Здесь появятся прошлые диалоги.
                  </p>
                )}
              </div>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
