import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import type { CalendarState } from "./calendar-store";
import type { PlannerStores } from "./planner-stores";
import type { SessionState } from "./session-store";
import type { UiState } from "./ui-store";
import type { VoiceState } from "./voice-store";

const PlannerStoresContext = createContext<PlannerStores | null>(null);

export function PlannerStoresProvider({
  stores,
  children,
}: {
  stores: PlannerStores;
  children: ReactNode;
}) {
  return (
    <PlannerStoresContext.Provider value={stores}>
      {children}
    </PlannerStoresContext.Provider>
  );
}

export function usePlannerStores(): PlannerStores {
  const stores = useContext(PlannerStoresContext);
  if (!stores)
    throw new Error(
      "Planner stores are only available inside PlannerStoresProvider",
    );
  return stores;
}

export function useSessionStore<T>(selector: (state: SessionState) => T): T {
  return useStore(usePlannerStores().session, selector);
}

export function useCalendarStore<T>(selector: (state: CalendarState) => T): T {
  return useStore(usePlannerStores().calendar, selector);
}

export function useVoiceStore<T>(selector: (state: VoiceState) => T): T {
  return useStore(usePlannerStores().voice, selector);
}

export function useUiStore<T>(selector: (state: UiState) => T): T {
  return useStore(usePlannerStores().ui, selector);
}
