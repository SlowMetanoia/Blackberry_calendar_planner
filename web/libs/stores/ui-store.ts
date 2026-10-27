import { createStore } from "zustand/vanilla";
import type { EntryRef } from "../entry-loader";
import type { CalendarEntry, PlannerView } from "../../types";

const SIDEBAR_STORAGE_KEY = "planner-sidebar-collapsed";

function storedSidebarCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

// A record to open in the editor: either already loaded or to be fetched.
export type EntryRequest = { entry: CalendarEntry } | { ref: EntryRef };

export type UiState = {
  view: PlannerView;
  navOpen: boolean;
  sidebarCollapsed: boolean;
  // A day opened from the sidebars; shown as a dialog over the current view.
  dayDialogDate: string | null;
  entryRequest: EntryRequest | null;
  selectView: (view: PlannerView) => void;
  setNavOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  openDay: (date: string) => void;
  closeDay: () => void;
  openEntry: (request: EntryRequest) => void;
  clearEntryRequest: () => void;
  resetNavigation: () => void;
};

export function createUiStore() {
  return createStore<UiState>()((set) => ({
    view: "chat",
    navOpen: false,
    sidebarCollapsed: storedSidebarCollapsed(),
    dayDialogDate: null,
    entryRequest: null,

    selectView: (view) => set({ view, navOpen: false }),
    setNavOpen: (navOpen) => set({ navOpen }),

    toggleSidebar: () =>
      set((state) => {
        const sidebarCollapsed = !state.sidebarCollapsed;
        if (typeof localStorage !== "undefined")
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
        return { sidebarCollapsed };
      }),

    openDay: (date) => set({ navOpen: false, dayDialogDate: date }),
    closeDay: () => set({ dayDialogDate: null }),
    openEntry: (entryRequest) => set({ navOpen: false, entryRequest }),
    clearEntryRequest: () => set({ entryRequest: null }),

    resetNavigation: () => set({ view: "chat", navOpen: false }),
  }));
}
