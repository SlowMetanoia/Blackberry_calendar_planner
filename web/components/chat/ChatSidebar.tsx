import {
  HistoryIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { formatSessionTimestamp } from "../../libs/format";
import type { ConversationSummary } from "../../types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { WeekHeatmap } from "../calendar/WeekHeatmap";

export function ChatSidebar({
  sessions,
  conversation,
  onNew,
  onSelect,
}: {
  sessions: ConversationSummary[];
  conversation: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      id="chat-sidebar"
      aria-label="Диалоги"
      className="flex w-[16rem] shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground max-md:h-[42%] max-md:w-full max-md:border-t max-md:border-l-0"
    >
      <div className="flex items-start gap-2.5 px-4 pt-5 pb-3">
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
          className="h-9 w-full justify-start gap-2 rounded-lg bg-sidebar-accent px-2.5 text-[13px] font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent/90 hover:text-sidebar-accent-foreground"
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
                  className={`group relative flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 ${
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

      <div className="shrink-0 px-3 py-3">
        <WeekHeatmap />
      </div>
    </aside>
  );
}
