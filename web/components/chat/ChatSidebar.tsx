import { MessageSquarePlusIcon, MessagesSquareIcon } from "lucide-react";
import { formatSessionTimestamp } from "../../libs/format";
import type { ConversationSummary } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { WeekHeatmap } from "../calendar/WeekHeatmap";

type ChatSidebarProps = {
  sessions: ConversationSummary[];
  conversation: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
};

function ChatSidebarBody({
  sessions,
  conversation,
  onNew,
  onSelect,
  sheet = false,
}: ChatSidebarProps & { sheet?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`flex items-start gap-2.5 px-4 pt-5 pb-3 ${
          sheet ? "pr-12" : ""
        }`}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-accent text-sidebar-accent-foreground">
          <MessagesSquareIcon aria-hidden="true" className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate font-heading text-sm font-semibold">
            Диалоги
          </h2>
          <p className="truncate text-[10.5px] text-sidebar-foreground/50">
            История ваших разговоров
          </p>
        </div>
      </div>

      <div className="px-3 pb-1">
        <Button
          variant="ghost"
          className="h-10 w-full justify-start gap-2 rounded-lg bg-sidebar-accent px-2.5 text-[13px] font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent/90 hover:text-sidebar-accent-foreground md:h-9"
          aria-label="Новый диалог"
          onClick={onNew}
        >
          <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
          Новый диалог
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-3">
        <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/40">
          Недавние
        </p>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="pr-1">
          <div className="grid gap-1 pb-2">
            {sessions.map((session) => {
              const active = conversation === session.id;
              return (
                <button
                  key={session.id}
                  type="button"
                  aria-label={session.preview}
                  aria-current={active ? "true" : undefined}
                  title={session.preview}
                  onClick={() => onSelect(session.id)}
                  className={`group relative flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 md:min-h-0 ${
                    active
                      ? "bg-sidebar-accent/15 text-sidebar-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/10 hover:text-sidebar-foreground"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <MessagesSquareIcon
                    aria-hidden="true"
                    className={`mt-0.5 size-3.5 shrink-0 ${
                      active ? "text-sidebar-primary" : ""
                    }`}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[12.5px] font-medium leading-4">
                      {session.preview}
                    </span>
                    <time className="truncate text-[10.5px] text-sidebar-foreground/45">
                      {formatSessionTimestamp(session.last_activity_at)}
                    </time>
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      <div className="shrink-0 border-t border-sidebar-border/70 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:border-t-0 md:pb-3">
        <WeekHeatmap />
      </div>
    </div>
  );
}

export function ChatSidebar(props: ChatSidebarProps) {
  return (
    <aside
      id="chat-sidebar"
      aria-label="Диалоги"
      className="hidden w-[16rem] shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
    >
      <ChatSidebarBody {...props} />
    </aside>
  );
}

export function ChatHistorySheet({
  open,
  onOpenChange,
  ...props
}: ChatSidebarProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        closeLabel="Закрыть диалоги"
        className="top-auto bottom-0 left-0 flex h-[88dvh] max-h-[92dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-2xl rounded-b-none border-0 bg-sidebar p-0 pt-0 pb-0 text-sidebar-foreground ring-sidebar-border sm:max-w-none data-open:slide-in-from-bottom-4 data-closed:slide-out-to-bottom-4"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Диалоги и занятость недели</DialogTitle>
          <DialogDescription>
            История разговоров и распределение занятости по дням.
          </DialogDescription>
        </DialogHeader>
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1.5 w-11 shrink-0 rounded-full bg-sidebar-foreground/20"
        />
        <ChatSidebarBody {...props} sheet />
      </DialogContent>
    </Dialog>
  );
}
