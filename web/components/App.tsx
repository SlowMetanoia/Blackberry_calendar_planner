import { useCallback, useEffect, useState } from "react";
import { HistoryIcon, LogOutIcon, PlusIcon } from "lucide-react";
import { AUTH_EXPIRED_EVENT } from "../api";
import { usePlannerSession } from "../libs/hooks/use-planner-session";
import { useVoiceAssistant } from "../libs/hooks/use-voice-assistant";
import type { PlannerView } from "../types";
import { Button } from "./ui/button";
import { LoginScreen } from "./auth/LoginScreen";
import { CalendarView } from "./calendar/CalendarView";
import { ChatView } from "./chat/ChatView";
import { SessionHistoryDialog } from "./chat/SessionHistoryDialog";
import { HistoryPanel } from "./history/HistoryPanel";
import { AppSidebar } from "./shared/AppSidebar";
import { ErrorToast } from "./shared/ErrorToast";
import { PlannerHeader } from "./shared/PlannerHeader";
import { useSidebarCollapsed } from "../libs/hooks/use-sidebar-collapsed";
import { ViewPanel } from "./shared/ViewPanel";

const viewTitles: Record<PlannerView, string> = {
  chat: "Что запланируем?",
  calendar: "Календарь",
  history: "История изменений",
};

export default function App() {
  const session = usePlannerSession();
  const voice = useVoiceAssistant({
    token: session.token,
    acceptMessage: session.acceptMessage,
    getConversationId: session.getConversationId,
    onAudio: session.sendAudio,
    onError: session.setError,
  });
  const [view, setView] = useState<PlannerView>("chat");
  const [navOpen, setNavOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const { collapsed: navCollapsed, toggle: toggleNavCollapsed } =
    useSidebarCollapsed();

  const resetNavigation = useCallback(() => {
    setView("chat");
    setNavOpen(false);
    setSessionsOpen(false);
  }, []);
  const { reset, startNewConversation, openConversation, logout } = session;
  const { stopOpenAir } = voice;

  const handleAuthExpired = useCallback(() => {
    stopOpenAir();
    reset("Сессия истекла или недействительна. Войдите снова.");
    resetNavigation();
  }, [reset, resetNavigation, stopOpenAir]);

  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () =>
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [handleAuthExpired]);

  const handleNewConversation = useCallback(() => {
    startNewConversation();
    resetNavigation();
  }, [resetNavigation, startNewConversation]);

  const handleOpenConversation = useCallback(
    async (id: string) => {
      resetNavigation();
      await openConversation(id);
    },
    [openConversation, resetNavigation],
  );

  const handleLogout = useCallback(async () => {
    stopOpenAir();
    await logout();
    resetNavigation();
  }, [logout, resetNavigation, stopOpenAir]);

  if (!session.token)
    return (
      <LoginScreen
        error={session.error}
        onAuthenticate={session.authenticate}
      />
    );

  return (
    <div className="h-dvh w-full bg-secondary/30">
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
          collapsed={navCollapsed}
          historyCount={session.history.length}
          onSelect={(next) => {
            setView(next);
            setNavOpen(false);
          }}
          onClose={() => setNavOpen(false)}
          onToggleCollapsed={toggleNavCollapsed}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col md:border-l md:border-border/60">
          <PlannerHeader
            title={viewTitles[view]}
            onOpenNav={() => setNavOpen(true)}
          >
            {view === "chat" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Новый диалог"
                  onClick={handleNewConversation}
                >
                  <PlusIcon aria-hidden="true" />
                  <span className="hidden lg:inline">Новый диалог</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="История сессий"
                  onClick={() => setSessionsOpen(true)}
                >
                  <HistoryIcon aria-hidden="true" />
                  <span className="hidden lg:inline">История сессий</span>
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Выйти"
              onClick={() => void handleLogout()}
            >
              <LogOutIcon aria-hidden="true" />
              <span className="hidden lg:inline">Выйти</span>
            </Button>
          </PlannerHeader>

          <ViewPanel active={view === "chat"}>
            <ChatView
              messages={session.messages}
              startNewConversation={handleNewConversation}
              recording={voice.recording}
              openAirEnabled={voice.openAirEnabled}
              openAirStatus={voice.openAirStatus}
              openAirSilenceMs={voice.openAirSilenceMs}
              onSendText={session.sendText}
              onToggleOpenAir={voice.toggleOpenAir}
              onChangeOpenAirSilence={voice.changeOpenAirSilence}
              onStartRecording={voice.startRecording}
              onStopRecording={voice.stopRecording}
            />
          </ViewPanel>

          <ViewPanel active={view === "calendar"}>
            <CalendarView
              revision={session.calendarRevision}
              onHistoryChanged={session.handleCalendarChanged}
              onError={session.setError}
            />
          </ViewPanel>

          <ViewPanel active={view === "history"}>
            <HistoryPanel items={session.history} undo={session.undo} />
          </ViewPanel>

          <ErrorToast message={session.error} onDismiss={session.clearError} />
        </section>

        <SessionHistoryDialog
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          sessions={session.sessions}
          conversation={session.conversation}
          onSelect={(id) => void handleOpenConversation(id)}
        />
      </main>
    </div>
  );
}
