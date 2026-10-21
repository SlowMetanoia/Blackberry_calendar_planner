import { createCalendarStore } from "./calendar-store";
import { createSessionStore } from "./session-store";
import { createUiStore } from "./ui-store";
import { createVoiceStore } from "./voice-store";

export function createPlannerStores() {
  const session = createSessionStore();
  return {
    session,
    calendar: createCalendarStore(session),
    voice: createVoiceStore(session),
    ui: createUiStore(),
  };
}

export type PlannerStores = ReturnType<typeof createPlannerStores>;
