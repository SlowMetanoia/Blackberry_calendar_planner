import {
  FormEvent,
  Fragment,
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUpIcon,
  CalendarDaysIcon,
  HistoryIcon,
  LogOutIcon,
  MenuIcon,
  MicIcon,
  PlusIcon,
  SparklesIcon,
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
import { Alert, AlertAction, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NativeSelect } from "./ui/native-select";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
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
      <main className="grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_18%_20%,color-mix(in_oklab,var(--accent)_62%,transparent),transparent_38%),radial-gradient(circle_at_82%_78%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_42%)] p-5">
        <div className="w-full max-w-md">
          <Card className="gap-0 overflow-visible shadow-2xl ring-border/80">
            <CardHeader className="gap-2 p-6 pb-0 sm:p-7 sm:pb-0">
              <Badge variant="secondary" className="w-fit">
                День за днём
              </Badge>
              <CardTitle asChild>
                <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                  {register ? "Создать аккаунт" : "Войти в ежедневник"}
                </h1>
              </CardTitle>
              <CardDescription>
                Задачи и встречи — просто скажите, что нужно.
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
        className={`session-sidebar operation-sidebar ${sidebarOpen ? "open" : ""} gap-3 px-3 py-5`}
      >
        <div className="flex items-start justify-between gap-2 px-1">
          <div>
            <Badge variant="secondary" className="w-fit">
              Календарь
            </Badge>
            <p className="mt-1.5 font-heading text-lg leading-none font-semibold">
              История изменений
            </p>
          </div>
          <Button
            className="sidebar-close"
            variant="ghost"
            size="icon-sm"
            aria-label="Закрыть историю"
            onClick={() => setSidebarOpen(false)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        <Separator />
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="operation-list px-1 py-0.5"
        >
          <nav
            className="flex flex-col"
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
                    <div className="my-2 flex items-center gap-2 text-[10px] whitespace-nowrap text-muted-foreground first:mt-0">
                      <span>{formatHistoryDate(item.created_at)}</span>
                      <Separator className="flex-1" />
                    </div>
                  )}
                  <HistoryItem item={item} undo={undo} />
                </Fragment>
              );
            })}
            {!history.length && (
              <p className="p-2 text-xs leading-relaxed text-muted-foreground">
                Изменения календаря появятся здесь.
              </p>
            )}
          </nav>
        </ScrollArea>
        <Separator />
        <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
          Каждая операция сохраняется и может быть отменена.
        </p>
      </aside>

      <section className="workspace">
        <header className="flex items-start justify-between gap-3 border-b bg-background px-4 py-4 sm:px-7">
          <div className="flex min-w-0 items-start gap-1.5">
            <Button
              className="sessions-toggle shrink-0"
              variant="ghost"
              size="icon-sm"
              aria-label="Открыть историю изменений"
              onClick={() => setSidebarOpen(true)}
            >
              <MenuIcon aria-hidden="true" />
            </Button>
            <div className="min-w-0">
              <Badge variant="outline" className="w-fit">
                Умный ежедневник
              </Badge>
              <h1 className="mt-1.5 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                Что запланируем?
              </h1>
            </div>
          </div>
          <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-1">
            <Button
              className="planner-toggle"
              variant="ghost"
              size="sm"
              onClick={() => setPlannerOpen(true)}
            >
              <CalendarDaysIcon aria-hidden="true" />
              Планы
            </Button>
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
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOutIcon aria-hidden="true" />
              Выйти
            </Button>
          </div>
        </header>

        <ScrollArea
          className="min-h-0"
          viewportClassName="chat px-4 py-6 sm:px-8"
          viewportRef={chat}
          aria-live="polite"
        >
          {!messages.length && (
            <Empty className="mx-auto my-[10vh] max-w-xl border-0">
              <EmptyMedia variant="icon">
                <SparklesIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Начните с простой просьбы</EmptyTitle>
                <EmptyDescription>
                  «Покажи задачи на сегодня» или «Напомни подготовить отчёт»
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {messages.map((message) => (
            <MessageExchange
              key={message.id}
              message={message}
              startNewConversation={startNewConversation}
            />
          ))}
        </ScrollArea>

        {error && (
          <Alert
            variant="destructive"
            className="fixed top-4 left-1/2 z-[120] w-auto max-w-[calc(100vw-2rem)] -translate-x-1/2 bg-popover shadow-xl"
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
              variant={openAirEnabled ? "default" : "outline"}
              size="lg"
              className="shrink-0"
              aria-label={`${openAirEnabled ? "Выключить" : "Включить"} open-air режим Ivory`}
              aria-pressed={openAirEnabled}
              onClick={() => void toggleOpenAir()}
            >
              <SparklesIcon aria-hidden="true" />
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
                  : "Удерживайте красную кнопку для записи"}
            </small>
            {openAirEnabled && (
              <>
                <Label
                  htmlFor="open-air-silence"
                  className="text-[11px] text-muted-foreground"
                >
                  Пауза
                </Label>
                <NativeSelect
                  id="open-air-silence"
                  aria-label="Пауза перед отправкой"
                  className="h-7 w-[76px] text-xs"
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
              </>
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

      <Dialog open={sessionsOpen} onOpenChange={setSessionsOpen}>
        <DialogContent
          closeLabel="Закрыть историю сессий"
          className="sm:max-w-lg"
        >
          <DialogHeader className="gap-1.5 pr-8">
            <Badge variant="secondary" className="w-fit">
              Диалоги
            </Badge>
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
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Здесь появятся прошлые диалоги.
                </p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </main>
  );
}
