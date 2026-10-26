import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  getGoogleIntegration,
  syncGoogleCalendar,
} from "../../api";
import type { GoogleIntegration } from "../../types";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { GoogleIcon } from "./GoogleIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

const REFRESH_MS = 60_000;
const SYNC_POLL_MS = 2_000;
const SYNC_POLL_LIMIT = 30;

function statusText(integration: GoogleIntegration): string {
  switch (integration.sync_status) {
    case "syncing":
      return "Идёт синхронизация…";
    case "error":
      return "Последняя синхронизация завершилась ошибкой.";
    case "reauth":
      return "Google отозвал доступ. Подключите календарь заново.";
    default:
      return integration.last_synced_at
        ? `Синхронизировано: ${new Date(integration.last_synced_at).toLocaleString("ru-RU")}`
        : "Первая синхронизация скоро начнётся.";
  }
}

export function GoogleCalendarButton({
  openOnMount = false,
  onError,
  onCalendarChanged,
}: {
  openOnMount?: boolean;
  onError: (message: string) => void;
  onCalendarChanged: () => void;
}) {
  const [integration, setIntegration] = useState<GoogleIntegration | null>(null);
  const [open, setOpen] = useState(openOnMount);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (openOnMount) setOpen(true);
  }, [openOnMount]);

  const refresh = useCallback(async () => {
    const next = await getGoogleIntegration();
    const previous = lastSynced.current;
    lastSynced.current = next.last_synced_at;
    setIntegration(next);
    // Imports from Google arrive in the background; refresh the calendar after each sync.
    if (previous && next.last_synced_at && next.last_synced_at !== previous)
      onCalendarChanged();
    return next;
  }, [onCalendarChanged]);

  useEffect(() => {
    let active = true;
    const update = () => {
      if (active) void refresh().catch(() => {});
    };
    update();
    const timer = window.setInterval(update, REFRESH_MS);
    window.addEventListener("focus", update);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);

  async function connect() {
    setBusy(true);
    try {
      const { authorization_url } = await connectGoogleCalendar();
      window.location.assign(authorization_url);
    } catch (error) {
      onError((error as Error).message);
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const before = lastSynced.current;
      await syncGoogleCalendar();
      for (let attempt = 0; attempt < SYNC_POLL_LIMIT; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
        const next = await refresh();
        if (next.sync_status === "error" || next.sync_status === "reauth") break;
        if (next.last_synced_at && next.last_synced_at !== before) {
          if (!before) onCalendarChanged();
          break;
        }
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectGoogleCalendar();
      setConfirmDisconnect(false);
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!integration?.available) return null;
  const needsAttention =
    integration.calendar_enabled &&
    (integration.sync_status === "error" || integration.sync_status === "reauth");

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="relative max-sm:size-9"
        aria-label="Google Календарь"
        onClick={() => setOpen(true)}
      >
        <GoogleIcon aria-hidden="true" />
        <span className="hidden lg:inline">Google</span>
        {needsAttention && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-destructive"
          />
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel="Закрыть Google Календарь" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Google Календарь</DialogTitle>
            <DialogDescription>
              События ежедневника и основного календаря Google синхронизируются в обе
              стороны. Напоминания к разовым событиям становятся уведомлениями Google,
              задачи и остальные напоминания остаются только здесь.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            {integration.linked && integration.email && (
              <p>
                Аккаунт Google: <strong>{integration.email}</strong>
              </p>
            )}
            {integration.calendar_enabled ? (
              <>
                <p className="text-muted-foreground">{statusText(integration)}</p>
                {integration.sync_status === "error" && integration.last_error && (
                  <Alert variant="destructive">
                    <AlertDescription>{integration.last_error}</AlertDescription>
                  </Alert>
                )}
                {integration.skipped_events > 0 && (
                  <Alert>
                    <AlertDescription>
                      Не импортировано событий из Google: {integration.skipped_events}. У
                      них правило повтора, которое ежедневник пока не поддерживает.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                  {integration.sync_status === "reauth" ? (
                    <Button disabled={busy} onClick={() => void connect()}>
                      Подключить заново
                    </Button>
                  ) : (
                    <Button disabled={busy} onClick={() => void syncNow()}>
                      <RefreshCwIcon
                        aria-hidden="true"
                        className={busy ? "animate-spin" : undefined}
                      />
                      Синхронизировать сейчас
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    Отключить
                  </Button>
                </div>
              </>
            ) : (
              <Button className="w-fit" disabled={busy} onClick={() => void connect()}>
                Подключить Google Календарь
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Отключить Google Календарь?"
        description="Синхронизация остановится. Уже перенесённые события останутся в обоих календарях."
        confirmLabel="Отключить"
        busy={busy}
        onConfirm={() => void disconnect()}
      />
    </>
  );
}
