import {
  ListTodoIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { formatSessionTimestamp } from "../../libs/format";
import { useUpcomingTasks } from "../../libs/hooks/use-upcoming-tasks";
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
import { ChatSidebarSection } from "./ChatSidebarSection";
import { SidebarUpcomingTasks } from "./SidebarUpcomingTasks";

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
  const { items: upcomingTasks, loading, error } = useUpcomingTasks();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatSidebarSection
        storageKey="planner-chat-sidebar-sessions"
        title="Диалоги"
        icon={MessagesSquareIcon}
        count={sessions.length}
        grow={3}
      >
        <div className={`px-2 pb-1 ${sheet ? "pr-11" : ""}`}>
          <Button
            variant="ghost"
            className="h-10 w-full justify-start gap-2 rounded-lg bg-sidebar-accent px-2.5 text-[14px] font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent/90 hover:text-sidebar-accent-foreground md:h-9"
            aria-label="Новый диалог"
            onClick={onNew}
          >
            <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
            Новый диалог
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
          <div className="grid gap-1">
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
                    className={`mt-0.5 size-4 shrink-0 ${
                      active ? "text-sidebar-primary" : ""
                    }`}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[13.5px] font-medium leading-[1.15rem]">
                      {session.preview}
                    </span>
                    <time className="truncate text-[11.5px] text-sidebar-foreground/45">
                      {formatSessionTimestamp(session.last_activity_at)}
                    </time>
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </ChatSidebarSection>

      <ChatSidebarSection
        storageKey="planner-chat-sidebar-tasks"
        title="Ближайшие задачи"
        icon={ListTodoIcon}
        count={upcomingTasks.length}
        grow={2}
        className="border-t border-sidebar-border/70"
      >
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="pb-1"
          aria-label="Список ближайших задач"
        >
          <SidebarUpcomingTasks
            items={upcomingTasks}
            loading={loading}
            error={error}
          />
        </ScrollArea>
      </ChatSidebarSection>

      <div className="shrink-0 border-t border-sidebar-border/70 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-2">
        <WeekHeatmap />
      </div>
    </div>
  );
}

export function ChatSidebar(props: ChatSidebarProps) {
  return (
    <aside
      id="chat-sidebar"
      aria-label="Диалоги и задачи"
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
          <DialogTitle>Диалоги и задачи</DialogTitle>
          <DialogDescription>
            История разговоров, ближайшие задачи и занятость по дням.
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
