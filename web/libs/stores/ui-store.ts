import { createStore } from "zustand/vanilla";
import type { PlannerView } from "../../types";

const SIDEBAR_STORAGE_KEY = "planner-sidebar-collapsed";

function storedSidebarCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

export type UiState = {
  view: PlannerView;
  navOpen: boolean;
  sidebarCollapsed: boolean;
  selectView: (view: PlannerView) => void;
  setNavOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  resetNavigation: () => void;
};

export function createUiStore() {
  return createStore<UiState>()((set) => ({
    view: "chat",
    navOpen: false,
    sidebarCollapsed: storedSidebarCollapsed(),

    selectView: (view) => set({ view, navOpen: false }),
    setNavOpen: (navOpen) => set({ navOpen }),

    toggleSidebar: () =>
      set((state) => {
        const sidebarCollapsed = !state.sidebarCollapsed;
        if (typeof localStorage !== "undefined")
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
        return { sidebarCollapsed };
      }),

    resetNavigation: () => set({ view: "chat", navOpen: false }),
  }));
}
