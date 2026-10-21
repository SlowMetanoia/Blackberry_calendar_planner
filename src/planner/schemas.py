import uuid
from datetime import date, datetime
from typing import Generic, Literal, TypeVar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .models import MessageStatus

MAX_TEXT_LENGTH = 10_000
MAX_INTEGER = 2_147_483_647


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class AuthRequest(StrictInput):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).lower()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TranscriptionResponse(BaseModel):
    text: str


class TimezoneValue(StrictInput):
    timezone: str = Field(min_length=1, max_length=64)

    @field_validator("timezone")
    @classmethod
    def valid_iana_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value


class UserPreferencesResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    timezone: str
    upcoming_days: int
    open_air_silence_ms: int


class UserPreferencesUpdate(StrictInput):
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    upcoming_days: int | None = Field(default=None, strict=True, ge=1, le=90)
    open_air_silence_ms: int | None = Field(default=None, strict=True, ge=500, le=5000)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value

    @model_validator(mode="after")
    def valid_patch(self):
        if not self.model_fields_set:
            raise ValueError("preference update must contain at least one field")
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class RecurrenceEnd(StrictInput):
    kind: Literal["never", "until", "count"] = "never"
    until: date | None = None
    count: int | None = Field(default=None, strict=True, ge=1, le=10_000)

    @model_validator(mode="after")
    def valid_end(self):
        if self.kind == "until" and self.until is None:
            raise ValueError("until is required for an until recurrence")
        if self.kind == "count" and self.count is None:
            raise ValueError("count is required for a count recurrence")
        if self.kind != "until" and self.until is not None:
            raise ValueError("until is only valid for an until recurrence")
        if self.kind != "count" and self.count is not None:
            raise ValueError("count is only valid for a count recurrence")
        return self


class MonthlyPattern(StrictInput):
    kind: Literal["day_of_month", "nth_weekday", "last_day"]
    day: int | None = Field(default=None, strict=True, ge=1, le=31)
    ordinal: int | None = Field(default=None, strict=True)
    weekday: Literal["MO", "TU", "WE", "TH", "FR", "SA", "SU"] | None = None

    @model_validator(mode="after")
    def valid_pattern(self):
        if self.kind == "day_of_month" and self.day is None:
            raise ValueError("day is required for a day-of-month recurrence")
        if self.kind == "nth_weekday" and (
            self.ordinal not in {1, 2, 3, 4, -1} or self.weekday is None
        ):
            raise ValueError("nth-weekday recurrence requires ordinal and weekday")
        return self


class RecurrenceRule(StrictInput):
    frequency: Literal["daily", "weekly", "monthly", "yearly"]
    interval: int = Field(default=1, strict=True, ge=1, le=MAX_INTEGER)
    weekdays: list[Literal["MO", "TU", "WE", "TH", "FR", "SA", "SU"]] | None = None
    monthly: MonthlyPattern | None = None
    end: RecurrenceEnd = Field(default_factory=RecurrenceEnd)

    @model_validator(mode="after")
    def valid_rule(self):
        if self.frequency == "weekly" and self.weekdays is not None and not self.weekdays:
            raise ValueError("weekdays cannot be empty")
        if self.frequency != "weekly" and self.weekdays is not None:
            raise ValueError("weekdays are only valid for weekly recurrence")
        if self.frequency != "monthly" and self.monthly is not None:
            raise ValueError("monthly pattern is only valid for monthly recurrence")
        return self


class TaskCreate(StrictInput):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, strict=True, ge=1, le=MAX_INTEGER)
    status: Literal["open", "completed"] = "open"
    recurrence: RecurrenceRule | None = None
    recurrence_timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def valid_recurrence(self):
        if self.recurrence is not None and self.deadline is None:
            raise ValueError("a recurring task requires a deadline")
        if self.recurrence is None and self.recurrence_timezone is not None:
            raise ValueError("recurrence_timezone requires recurrence")
        if self.recurrence_timezone is not None:
            TimezoneValue(timezone=self.recurrence_timezone)
        return self


class TaskUpdate(StrictInput):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, strict=True, ge=1, le=MAX_INTEGER)
    status: Literal["open", "completed"] | None = None
    recurrence: RecurrenceRule | None = None
    recurrence_timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def valid_update(self):
        if not self.model_fields_set:
            raise ValueError("update payload must contain at least one field")
        for field in {"title", "status"} & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        if self.recurrence_timezone is not None:
            TimezoneValue(timezone=self.recurrence_timezone)
        return self


class EventCreate(StrictInput):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    starts_at: datetime
    duration_minutes: int | None = Field(default=None, strict=True, ge=1, le=MAX_INTEGER)
    location: str | None = Field(default=None, max_length=500)
    recurrence: RecurrenceRule | None = None
    recurrence_timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def valid_recurrence(self):
        if self.recurrence is None and self.recurrence_timezone is not None:
            raise ValueError("recurrence_timezone requires recurrence")
        if self.recurrence_timezone is not None:
            TimezoneValue(timezone=self.recurrence_timezone)
        return self


class EventUpdate(StrictInput):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    starts_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, strict=True, ge=1, le=MAX_INTEGER)
    location: str | None = Field(default=None, max_length=500)
    recurrence: RecurrenceRule | None = None
    recurrence_timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def valid_update(self):
        if not self.model_fields_set:
            raise ValueError("update payload must contain at least one field")
        for field in {"title", "starts_at"} & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        if self.recurrence_timezone is not None:
            TimezoneValue(timezone=self.recurrence_timezone)
        return self


class ReminderCreate(StrictInput):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    remind_at: datetime | None = None
    linked_resource: Literal["task", "event"] | None = None
    linked_id: uuid.UUID | None = None
    relative_offset_minutes: int | None = Field(default=None, strict=True)

    @field_validator("remind_at")
    @classmethod
    def aware_remind_at(cls, value: datetime | None) -> datetime | None:
        return _require_aware(value)

    @model_validator(mode="after")
    def valid_link(self):
        if self.remind_at is None and self.relative_offset_minutes is None:
            raise ValueError("remind_at is required for absolute reminders")
        if self.relative_offset_minutes is not None and (
            self.linked_resource is None or self.linked_id is None
        ):
            raise ValueError("relative reminders require a linked resource")
        if (self.linked_resource is None) != (self.linked_id is None):
            raise ValueError("linked_resource and linked_id must be provided together")
        return self


class ReminderUpdate(StrictInput):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    remind_at: datetime | None = None
    status: Literal["active", "cancelled"] | None = None
    relative_offset_minutes: int | None = Field(default=None, strict=True)

    @field_validator("remind_at")
    @classmethod
    def aware_remind_at(cls, value: datetime | None) -> datetime | None:
        return _require_aware(value)

    @model_validator(mode="after")
    def non_empty(self):
        if not self.model_fields_set:
            raise ValueError("update payload must contain at least one field")
        for name in {"title", "remind_at", "status"} & self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class ReminderResponse(ReminderCreate):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID
    remind_at: datetime
    status: Literal["active", "fired", "cancelled"]
    cancelled_reason: str | None = None
    fired_at: datetime | None = None
    cancelled_at: datetime | None = None
    created_at: datetime

    @field_validator("remind_at")
    @classmethod
    def aware_remind_at(cls, value: datetime) -> datetime:
        from datetime import UTC

        return value if value.tzinfo else value.replace(tzinfo=UTC)


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    reminder_id: uuid.UUID
    title: str
    body: str | None
    read_at: datetime | None
    created_at: datetime


class PushSubscriptionPayload(StrictInput):
    endpoint: str = Field(min_length=1, max_length=4096)
    p256dh: str = Field(min_length=1, max_length=512)
    auth: str = Field(min_length=1, max_length=512)

    @field_validator("endpoint")
    @classmethod
    def valid_push_service(cls, value: str) -> str:
        from urllib.parse import urlsplit

        url = urlsplit(value)
        providers = (
            "googleapis.com",
            "push.services.mozilla.com",
            "notify.windows.com",
            "push.apple.com",
        )
        host = (url.hostname or "").lower()
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port not in {None, 443}
            or not any(host == provider or host.endswith("." + provider) for provider in providers)
        ):
            raise ValueError("endpoint must belong to a supported HTTPS browser push service")
        return value


class PushConfigResponse(BaseModel):
    enabled: bool
    public_key: str | None = None


class TaskResponse(TaskCreate):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID


class EventResponse(EventCreate):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID


class AgentInput(StrictInput):
    text: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    conversation_id: uuid.UUID | None = None


class ConversationSummary(BaseModel):
    id: uuid.UUID
    preview: str
    created_at: datetime
    last_activity_at: datetime


class CalendarOperationResponse(BaseModel):
    id: uuid.UUID
    sequence: int
    command_id: uuid.UUID
    ordinal: int
    operation: Literal["create", "update", "delete"]
    resource: Literal["task", "event", "reminder"]
    target_id: uuid.UUID
    scope: Literal["series", "occurrence"] = "series"
    occurrence_key: str | None = None
    effective_from_occurrence_key: str | None = None
    before: dict | None
    after: dict | None
    changes: dict
    origin: Literal["agent", "rest", "undo"]
    source_message_id: uuid.UUID | None
    reverts_operation_id: uuid.UUID | None
    created_at: datetime

    @classmethod
    def from_operation(cls, operation):
        return cls(
            id=operation.id,
            sequence=operation.sequence,
            command_id=operation.command_id,
            ordinal=operation.ordinal,
            operation=operation.operation,
            resource=operation.resource,
            target_id=operation.target_id,
            scope=operation.scope,
            occurrence_key=operation.occurrence_key,
            effective_from_occurrence_key=operation.effective_from_occurrence_key,
            before=operation.before_state,
            after=operation.after_state,
            changes=operation.changes,
            origin=operation.origin,
            source_message_id=operation.source_message_id,
            reverts_operation_id=operation.reverts_operation_id,
            created_at=operation.created_at,
        )


class AgentDisplayItemResponse(BaseModel):
    resource: Literal["task", "event", "reminder"]
    id: uuid.UUID
    data: dict


class CalendarOccurrenceResponse(BaseModel):
    resource: Literal["task", "event"]
    series_id: uuid.UUID
    occurrence_key: str
    original_at: datetime
    scheduled_at: datetime
    recurring: bool
    data: dict


T = TypeVar("T")


class CursorPage(BaseModel, Generic[T]):
    items: list[T]
    total: int
    has_more: bool
    next_cursor: str | None = None


class AgentMessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    status: MessageStatus
    sequence: int
    input_text: str | None = None
    error: str | None = None
    reply: str | None = None
    display_items: list[AgentDisplayItemResponse] = Field(default_factory=list)
    operations: list[CalendarOperationResponse] = Field(default_factory=list)
    requires_new_conversation: bool = False
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ProblemFieldError(BaseModel):
    location: str
    message: str
    error_type: str


class ProblemDetail(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str
    code: str
    errors: list[ProblemFieldError] | None = None


class DecisionTimeRange(StrictInput):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)
    from_datetime: datetime = Field(alias="from")
    to_datetime: datetime = Field(alias="to")

    @model_validator(mode="after")
    def valid_half_open_range(self):
        if self.from_datetime.tzinfo is None or self.to_datetime.tzinfo is None:
            raise ValueError("time range datetimes must include UTC offsets")
        if self.from_datetime >= self.to_datetime:
            raise ValueError("time range must satisfy from < to")
        return self


def _require_aware(value: datetime | None) -> datetime | None:
    if value is not None and (value.tzinfo is None or value.utcoffset() is None):
        raise ValueError("datetime must include a UTC offset")
    return value


class DecisionTaskCreatePayload(TaskCreate):
    @field_validator("deadline")
    @classmethod
    def aware_deadline(cls, value: datetime | None) -> datetime | None:
        return _require_aware(value)


class DecisionTaskUpdatePayload(TaskUpdate):
    model_config = ConfigDict(
        extra="forbid", json_schema_extra={"minProperties": 1}, str_strip_whitespace=True
    )

    @field_validator("deadline")
    @classmethod
    def aware_deadline(cls, value: datetime | None) -> datetime | None:
        return _require_aware(value)


class DecisionEventCreatePayload(EventCreate):
    @field_validator("starts_at")
    @classmethod
    def aware_starts_at(cls, value: datetime) -> datetime:
        return _require_aware(value)


class DecisionEventUpdatePayload(EventUpdate):
    model_config = ConfigDict(
        extra="forbid", json_schema_extra={"minProperties": 1}, str_strip_whitespace=True
    )

    @field_validator("starts_at")
    @classmethod
    def aware_starts_at(cls, value: datetime | None) -> datetime | None:
        return _require_aware(value)


class DecisionDeletePayload(StrictInput):
    pass


class DecisionTaskCreateAction(StrictInput):
    operation: Literal["create"]
    resource: Literal["task"]
    target_id: None = None
    payload: DecisionTaskCreatePayload


class DecisionTaskUpdateAction(StrictInput):
    operation: Literal["update"]
    resource: Literal["task"]
    target_id: uuid.UUID
    payload: DecisionTaskUpdatePayload
    scope: Literal["series", "occurrence"] = "series"
    occurrence_key: str | None = None
    effective_from_occurrence_key: str | None = None


class DecisionTaskDeleteAction(StrictInput):
    operation: Literal["delete"]
    resource: Literal["task"]
    target_id: uuid.UUID
    payload: DecisionDeletePayload
    scope: Literal["series", "occurrence"] = "series"
    occurrence_key: str | None = None


class DecisionEventCreateAction(StrictInput):
    operation: Literal["create"]
    resource: Literal["event"]
    target_id: None = None
    payload: DecisionEventCreatePayload


class DecisionEventUpdateAction(StrictInput):
    operation: Literal["update"]
    resource: Literal["event"]
    target_id: uuid.UUID
    payload: DecisionEventUpdatePayload
    scope: Literal["series", "occurrence"] = "series"
    occurrence_key: str | None = None
    effective_from_occurrence_key: str | None = None


class DecisionEventDeleteAction(StrictInput):
    operation: Literal["delete"]
    resource: Literal["event"]
    target_id: uuid.UUID
    payload: DecisionDeletePayload
    scope: Literal["series", "occurrence"] = "series"
    occurrence_key: str | None = None


class DecisionReminderCreateAction(StrictInput):
    operation: Literal["create"]
    resource: Literal["reminder"]
    target_id: None = None
    payload: ReminderCreate


class DecisionReminderUpdateAction(StrictInput):
    operation: Literal["update"]
    resource: Literal["reminder"]
    target_id: uuid.UUID
    payload: ReminderUpdate


class DecisionReminderDeleteAction(StrictInput):
    operation: Literal["delete"]
    resource: Literal["reminder"]
    target_id: uuid.UUID
    payload: DecisionDeletePayload


DecisionAction = (
    DecisionTaskCreateAction
    | DecisionTaskUpdateAction
    | DecisionTaskDeleteAction
    | DecisionEventCreateAction
    | DecisionEventUpdateAction
    | DecisionEventDeleteAction
    | DecisionReminderCreateAction
    | DecisionReminderUpdateAction
    | DecisionReminderDeleteAction
)
