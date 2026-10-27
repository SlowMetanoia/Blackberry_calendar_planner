import { useCallback, useState } from "react";
import type {
  CalendarEntry,
  CollisionReport,
  EditorState,
  Resource,
} from "../../types";
import { useSessionStore } from "../../libs/stores";
import { CalendarItemDialog } from "./CalendarItemDialog";
import { CollisionWarning } from "./CollisionWarning";
import { ReminderDialog, type ReminderLink } from "./ReminderDialog";

// Editor dialogs for calendar entries, shared by every place that lists them.
export function useEntryEditors(onChanged: () => Promise<unknown> | unknown) {
  const onError = useSessionStore((state) => state.setError);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [collisions, setCollisions] = useState<CollisionReport | null>(null);
  const [reminderLink, setReminderLink] = useState<ReminderLink>();

  function close() {
    setEditor(null);
    setReminderLink(undefined);
  }

  async function changed() {
    close();
    await onChanged();
  }

  const dialogs = (
    <>
      {collisions && (
        <CollisionWarning
          report={collisions}
          onClose={() => setCollisions(null)}
        />
      )}
      {(editor?.resource === "reminder" || reminderLink) && (
        <ReminderDialog
          reminder={editor?.entry?.reminder}
          date={editor?.date}
          time={editor?.time}
          link={reminderLink}
          onClose={close}
          onChanged={changed}
          onError={onError}
        />
      )}
      {editor && editor.resource !== "reminder" && !reminderLink && (
        <CalendarItemDialog
          state={editor}
          onClose={() => setEditor(null)}
          onChanged={changed}
          onError={onError}
          onCollisions={setCollisions}
          onAddReminder={(entry) => {
            if (entry.resource !== "reminder")
              setReminderLink({
                resource: entry.resource,
                id: entry.id,
                title: entry.title,
                at: entry.startsAt,
              });
          }}
        />
      )}
    </>
  );

  const openEntry = useCallback(
    (entry: CalendarEntry) => setEditor({ resource: entry.resource, entry }),
    [],
  );
  const createEntry = useCallback(
    (resource: Resource, date: string, time?: string) =>
      setEditor({ resource, date, time }),
    [],
  );

  return { dialogs, openEntry, createEntry };
}
