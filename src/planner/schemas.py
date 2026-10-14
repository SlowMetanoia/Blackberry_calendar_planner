import uuid
from datetime import datetime
from typing import Generic, Literal, TypeVar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .models import MessageStatus


class AuthRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TimezoneValue(BaseModel):
    timezone: str = Field(min_length=1, max_length=64)

    @field_validator("timezone")
    @classmethod
    def valid_iana_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = None
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    status: Literal["open", "completed"] = "open"


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    status: Literal["open", "completed"] | None = None

    @model_validator(mode="after")
    def required_fields_cannot_be_null(self):
        for field in {"title", "status"} & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class EventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    description: str | None = None
    starts_at: datetime
    duration_minutes: int | None = Field(default=None, ge=1)
    location: str | None = Field(default=None, max_length=500)


class EventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    starts_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=1)
    location: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def required_fields_cannot_be_null(self):
        for field in {"title", "starts_at"} & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class TaskResponse(TaskCreate):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID


class EventResponse(EventCreate):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID


class AgentMessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    status: MessageStatus
    sequence: int
    input_text: str | None = None
    error: str | None = None
    reply: str | None = None
    reads: list[dict] = Field(default_factory=list)
    operations: list[dict] = Field(default_factory=list)
    requires_new_conversation: bool = False
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentInput(BaseModel):
    text: str = Field(min_length=1)
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
    resource: Literal["task", "event"]
    target_id: uuid.UUID
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
            id=operation.id, sequence=operation.sequence, command_id=operation.command_id,
            ordinal=operation.ordinal, operation=operation.operation, resource=operation.resource,
            target_id=operation.target_id, before=operation.before_state,
            after=operation.after_state, changes=operation.changes, origin=operation.origin,
            source_message_id=operation.source_message_id,
            reverts_operation_id=operation.reverts_operation_id, created_at=operation.created_at,
        )


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ProblemDetail(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str
    code: str

class DecisionTimeRange(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_datetime: datetime = Field(alias="from")
    to_datetime: datetime = Field(alias="to")

    @model_validator(mode="after")
    def valid_half_open_range(self):
        if self.from_datetime.tzinfo is None or self.to_datetime.tzinfo is None:
            raise ValueError("time range datetimes must include UTC offsets")
        if self.from_datetime >= self.to_datetime:
            raise ValueError("time range must satisfy from < to")
        return self


class DecisionListRead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["list"]
    resource: Literal["task", "event"]
    target_id: None = None
    time_range: DecisionTimeRange | None = None


class DecisionGetRead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["get"]
    resource: Literal["task", "event"]
    target_id: uuid.UUID


DecisionRead = DecisionListRead | DecisionGetRead


class DecisionTaskCreatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=500)
    description: str | None = None
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    status: str = "open"


class DecisionTaskUpdatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"minProperties": 1})
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    deadline: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    status: str | None = None

    @model_validator(mode="after")
    def at_least_one_field(self):
        if not self.model_fields_set:
            raise ValueError("update payload must contain at least one field")
        return self


class DecisionEventCreatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=500)
    description: str | None = None
    starts_at: datetime
    duration_minutes: int | None = Field(default=None, ge=1)
    location: str | None = Field(default=None, max_length=500)


class DecisionEventUpdatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"minProperties": 1})
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    starts_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=1)
    location: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def at_least_one_field(self):
        if not self.model_fields_set:
            raise ValueError("update payload must contain at least one field")
        return self


class DecisionDeletePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DecisionTaskCreateAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["create"]
    resource: Literal["task"]
    target_id: None = None
    payload: DecisionTaskCreatePayload


class DecisionTaskUpdateAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["update"]
    resource: Literal["task"]
    target_id: uuid.UUID
    payload: DecisionTaskUpdatePayload


class DecisionTaskDeleteAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["delete"]
    resource: Literal["task"]
    target_id: uuid.UUID
    payload: DecisionDeletePayload


class DecisionEventCreateAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["create"]
    resource: Literal["event"]
    target_id: None = None
    payload: DecisionEventCreatePayload


class DecisionEventUpdateAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["update"]
    resource: Literal["event"]
    target_id: uuid.UUID
    payload: DecisionEventUpdatePayload


class DecisionEventDeleteAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["delete"]
    resource: Literal["event"]
    target_id: uuid.UUID
    payload: DecisionDeletePayload


DecisionAction = (
    DecisionTaskCreateAction
    | DecisionTaskUpdateAction
    | DecisionTaskDeleteAction
    | DecisionEventCreateAction
    | DecisionEventUpdateAction
    | DecisionEventDeleteAction
)


class DecisionEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reply: str
    reads: list[DecisionRead]
    mutations: list[DecisionAction]
    clarification: str | None
