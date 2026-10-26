export type ListeningState = "idle" | "started" | "speaking" | "finished";
export type OpenAirStatus =
  | "off"
  | "armed"
  | "hearing_wake"
  | "recognizing_wake"
  | "ready"
  | "hearing_command"
  | "processing"
  | "speaking"
  | "paused"
  | "error";
