import { useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { useSessionStore } from "../../libs/stores";
import type { TaskAction } from "../../libs/task-actions";
import type { CalendarEntry } from "../../types";
import { Button } from "../ui/button";

const actions: {
  action: TaskAction;
  label: string;
  icon: typeof CheckIcon;
  className: string;
}[] = [
  {
    action: "complete",
    label: "Завершить",
    icon: CheckIcon,
    className: "hover:text-primary",
  },
  {
    action: "cancel",
    label: "Отменить",
    icon: XIcon,
    className: "hover:text-destructive",
  },
];

// Hidden until the row is hovered or focused on pointer devices; always shown
// on touch screens, where there is no hover.
export function TaskActions({
  entry,
  className = "",
}: {
  entry: CalendarEntry;
  className?: string;
}) {
  const changeTask = useSessionStore((state) => state.changeTask);
  const [busy, setBusy] = useState(false);

  async function run(action: TaskAction) {
    setBusy(true);
    try {
      await changeTask(entry, action);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className={`flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/task:opacity-100 [@media(hover:hover)]:group-focus-within/task:opacity-100 ${className}`}
    >
      {actions.map(({ action, label, icon: Icon, className: tone }) => (
        <Button
          key={action}
          variant="ghost"
          size="icon-xs"
          className={`max-sm:size-8 ${tone}`}
          aria-label={`${label} «${entry.title}»`}
          title={label}
          disabled={busy}
          onClick={() => void run(action)}
        >
          <Icon aria-hidden="true" />
        </Button>
      ))}
    </span>
  );
}
