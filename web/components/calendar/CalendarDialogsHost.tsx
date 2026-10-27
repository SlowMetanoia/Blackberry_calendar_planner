import { useEffect } from "react";
import { loadEntry } from "../../libs/entry-loader";
import { useDayEntries } from "../../libs/hooks/use-day-entries";
import { useSessionStore, useUiStore } from "../../libs/stores";
import { DayDialog } from "./DayDialog";
import { useEntryEditors } from "./EntryEditors";

// Calendar dialogs opened from outside the calendar section: a day from the
// mini calendar or the week heatmap, or a record from the sidebar and chat.
// They stay over the current view instead of switching sections.
export function CalendarDialogsHost() {
  const date = useUiStore((state) => state.dayDialogDate);
  const closeDay = useUiStore((state) => state.closeDay);
  const entryRequest = useUiStore((state) => state.entryRequest);
  const clearEntryRequest = useUiStore((state) => state.clearEntryRequest);
  const onCalendarChanged = useSessionStore(
    (state) => state.handleCalendarChanged,
  );
  const setError = useSessionStore((state) => state.setError);
  const entries = useDayEntries(date);
  const editors = useEntryEditors(onCalendarChanged);
  const { openEntry } = editors;

  useEffect(() => {
    if (!entryRequest) return;
    clearEntryRequest();
    if ("entry" in entryRequest) {
      openEntry(entryRequest.entry);
      return;
    }
    void loadEntry(entryRequest.ref)
      .then(openEntry)
      .catch(() =>
        setError("Не удалось открыть запись: возможно, она уже удалена."),
      );
  }, [entryRequest, clearEntryRequest, openEntry, setError]);

  return (
    <>
      {date && (
        <DayDialog
          date={date}
          entries={entries}
          onClose={closeDay}
          onOpen={openEntry}
          onCreate={(resource) => editors.createEntry(resource, date)}
        />
      )}
      {editors.dialogs}
    </>
  );
}
