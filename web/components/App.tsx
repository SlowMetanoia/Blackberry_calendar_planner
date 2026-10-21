import { useCallback, useEffect, useState } from "react";
import { LogOutIcon } from "lucide-react";
import { AUTH_EXPIRED_EVENT } from "../api";
import {
  PlannerStoresProvider,
  createPlannerStores,
  usePlannerStores,
  useSessionStore,
  useUiStore,
} from "../libs/stores";
import type { PlannerView } from "../types";
import { Button } from "./ui/button";
import { LoginScreen } from "./auth/LoginScreen";
import { CalendarView } from "./calendar/CalendarView";
import { ChatHistorySheet, ChatSidebar } from "./chat/ChatSidebar";
import { ChatView } from "./chat/ChatView";
import { HistoryPanel } from "./history/HistoryPanel";
import { AppSidebar } from "./shared/AppSidebar";
import { ErrorToast } from "./shared/ErrorToast";
import { PlannerHeader } from "./shared/PlannerHeader";
import { ViewPanel } from "./shared/ViewPanel";
import { detachPushSubscription, NotificationCenter } from "./notifications/NotificationCenter";

const viewTitles: Record<PlannerView, string> = {
  chat: "Что запланируем?",
  calendar: "Календарь",
  history: "История изменений",
};

export default function App() {
  const [stores] = useState(createPlannerStores);
  return (
    <PlannerStoresProvider stores={stores}>
      <PlannerApp />
    </PlannerStoresProvider>
  );
}

function PlannerApp() {
  const stores = usePlannerStores();
  const token = useSessionStore((state) => state.token);
  const authenticate = useSessionStore((state) => state.authenticate);
  const error = useSessionStore((state) => state.error);
  const clearError = useSessionStore((state) => state.clearError);
  const historyCount = useSessionStore((state) => state.history.length);
  const sessions = useSessionStore((state) => state.sessions);
  const conversation = useSessionStore((state) => state.conversation);
  const view = useUiStore((state) => state.view);
  const navOpen = useUiStore((state) => state.navOpen);
  const navCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const selectView = useUiStore((state) => state.selectView);
  const setNavOpen = useUiStore((state) => state.setNavOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (view !== "chat") setHistoryOpen(false);
  }, [view]);

  useEffect(() => {
    if (!token) return;
    void stores.session.getState().bootstrap();
    void stores.voice.getState().loadPreferences();
  }, [stores, token]);

  useEffect(() => () => stores.voice.getState().dispose(), [stores]);

  const handleAuthExpired = useCallback(() => {
    stores.voice.getState().reset();
    stores.session
      .getState()
      .reset("Сессия истекла или недействительна. Войдите снова.");
    stores.calendar.getState().reset();
    stores.ui.getState().resetNavigation();
  }, [stores]);

  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () =>
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [handleAuthExpired]);

  const handleNewConversation = useCallback(() => {
    stores.session.getState().startNewConversation();
    stores.ui.getState().resetNavigation();
    setHistoryOpen(false);
  }, [stores]);

  const handleOpenConversation = useCallback(
    async (id: string) => {
      setHistoryOpen(false);
      stores.ui.getState().resetNavigation();
      await stores.session.getState().openConversation(id);
    },
    [stores],
  );

  const handleLogout = useCallback(async () => {
    setHistoryOpen(false);
    stores.voice.getState().reset();
    try { await detachPushSubscription(); } catch { /* logout must remain available */ }
    await stores.session.getState().logout();
    stores.calendar.getState().reset();
    stores.ui.getState().resetNavigation();
  }, [stores]);

  if (!token)
    return <LoginScreen error={error} onAuthenticate={authenticate} />;

  return (
    <div className="h-dvh w-full bg-background">
      <main className="flex h-full w-full flex-col overflow-hidden bg-background md:flex-row">
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
          historyCount={historyCount}
          onSelect={selectView}
          onClose={() => setNavOpen(false)}
          onToggleCollapsed={toggleSidebar}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col md:border-l md:border-border/60">
          <PlannerHeader
            title={viewTitles[view]}
            onOpenNav={() => setNavOpen(true)}
          >
            <NotificationCenter onError={stores.session.getState().setError} />
            <Button
              variant="ghost"
              size="sm"
              className="max-sm:size-9"
              aria-label="Выйти"
              onClick={() => void handleLogout()}
            >
              <LogOutIcon aria-hidden="true" />
              <span className="hidden lg:inline">Выйти</span>
            </Button>
          </PlannerHeader>

          <ViewPanel active={view === "chat"}>
            <ChatView
              startNewConversation={handleNewConversation}
              sessionCount={sessions.length}
              onOpenHistory={() => setHistoryOpen(true)}
            />
          </ViewPanel>

          <ViewPanel active={view === "calendar"}>
            <CalendarView />
          </ViewPanel>

          <ViewPanel active={view === "history"}>
            <HistoryPanel />
          </ViewPanel>

          <ErrorToast message={error} onDismiss={clearError} />
        </section>

        {view === "chat" && (
          <ChatSidebar
            sessions={sessions}
            conversation={conversation}
            onNew={handleNewConversation}
            onSelect={(id) => void handleOpenConversation(id)}
          />
        )}

        <ChatHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          sessions={sessions}
          conversation={conversation}
          onNew={handleNewConversation}
          onSelect={(id) => void handleOpenConversation(id)}
        />
      </main>
    </div>
  );
}
