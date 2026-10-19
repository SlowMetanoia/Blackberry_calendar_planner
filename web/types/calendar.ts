export type Resource = "task" | "event";
export type OperationKind = "create" | "update" | "delete";
export type OperationOrigin = "agent" | "rest" | "undo";
export type OperationScope = "series" | "occurrence";
export type TaskStatus = "open" | "completed";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type RecurrenceRule = {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays?: Weekday[] | null;
  monthly?: {
    kind: "day_of_month" | "nth_weekday" | "last_day";
    day?: number | null;
    ordinal?: number | null;
    weekday?: Weekday | null;
  } | null;
  end: {
    kind: "never" | "until" | "count";
    until?: string | null;
    count?: number | null;
  };
};
export type CalendarOperation = {
  id: string;
  sequence: number;
  command_id: string;
  ordinal: number;
  operation: OperationKind;
  resource: Resource;
  target_id: string;
  scope?: OperationScope;
  occurrence_key?: string | null;
  effective_from_occurrence_key?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changes: Record<string, { before: unknown; after: unknown }>;
  origin: OperationOrigin;
  source_message_id: string | null;
  reverts_operation_id: string | null;
  created_at: string;
};
export type Task = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  estimated_minutes: number | null;
  status: TaskStatus;
  recurrence?: RecurrenceRule | null;
  recurrence_timezone?: string | null;
};
export type Event = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  duration_minutes: number | null;
  location: string | null;
  recurrence?: RecurrenceRule | null;
  recurrence_timezone?: string | null;
};
export type CalendarOccurrence = {
  resource: Resource;
  series_id: string;
  occurrence_key: string;
  original_at: string;
  scheduled_at: string;
  recurring: boolean;
  data: Task | Event;
};
export type CursorPage<T> = {
  items: T[];
  total: number;
  has_more: boolean;
  next_cursor: string | null;
};
export type CalendarEntry = {
  id: string;
  resource: Resource;
  title: string;
  startsAt: string;
  durationMinutes: number | null;
  occurrenceKey?: string;
  recurring?: boolean;
  task?: Task;
  event?: Event;
};
export type TaskListOptions = {
  limit?: number;
  offset?: number;
  deadlineFrom?: string;
  deadlineTo?: string;
  status?: TaskStatus;
  deadlinePresence?: "dated" | "undated" | "any";
};
export type EventListOptions = {
  limit?: number;
  offset?: number;
  startsAtFrom?: string;
  startsAtTo?: string;
};
export type OccurrenceListOptions = {
  resource?: "all" | Resource;
  seriesId?: string;
  from?: string;
  to?: string;
  status?: TaskStatus;
  limit?: number;
  cursor?: string;
};
