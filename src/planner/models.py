import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class MessageStatus(str, enum.Enum):
    queued = "queued"
    transcribing = "transcribing"
    processing = "processing"
    needs_clarification = "needs_clarification"
    completed = "completed"
    failed = "failed"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("upcoming_days BETWEEN 1 AND 90", name="ck_users_upcoming_days_range"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    upcoming_days: Mapped[int] = mapped_column(default=7, server_default="7")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("length(trim(title)) > 0", name="ck_tasks_title_not_blank"),
        CheckConstraint("length(title) <= 500", name="ck_tasks_title_length"),
        CheckConstraint(
            "description IS NULL OR length(description) <= 10000",
            name="ck_tasks_description_length",
        ),
        CheckConstraint(
            "estimated_minutes IS NULL OR estimated_minutes > 0",
            name="ck_tasks_estimated_minutes_positive",
        ),
        CheckConstraint("status IN ('open', 'completed')", name="ck_tasks_status"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text())
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_minutes: Mapped[int | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(32), default="open")


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("length(trim(title)) > 0", name="ck_events_title_not_blank"),
        CheckConstraint("length(title) <= 500", name="ck_events_title_length"),
        CheckConstraint(
            "description IS NULL OR length(description) <= 10000",
            name="ck_events_description_length",
        ),
        CheckConstraint(
            "location IS NULL OR length(location) <= 500",
            name="ck_events_location_length",
        ),
        CheckConstraint(
            "duration_minutes IS NULL OR duration_minutes > 0",
            name="ck_events_duration_minutes_positive",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text())
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int | None] = mapped_column()
    location: Mapped[str | None] = mapped_column(String(500))


class CalendarSearchDocument(Base):
    __tablename__ = "calendar_search_documents"
    __table_args__ = (
        CheckConstraint("resource IN ('task', 'event')", name="ck_search_documents_resource"),
        Index("ix_search_documents_owner_resource", "owner_id", "resource"),
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    resource: Mapped[str] = mapped_column(String(16), primary_key=True)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    normalized_title: Mapped[str] = mapped_column(Text())
    normalized_description: Mapped[str] = mapped_column(Text(), default="", server_default="")
    content_hash: Mapped[str] = mapped_column(String(64))
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(768).with_variant(JSON(none_as_null=True), "sqlite"), nullable=True
    )
    embedding_model: Mapped[str | None] = mapped_column(String(255))
    embedding_content_hash: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CalendarSearchIndexState(Base):
    __tablename__ = "calendar_search_index_states"
    __table_args__ = (
        CheckConstraint(
            "requested_generation >= completed_generation",
            name="ck_search_index_generation_order",
        ),
        CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'failed')",
            name="ck_search_index_status",
        ),
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    requested_generation: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    completed_generation: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    status: Mapped[str] = mapped_column(String(16), default="ready", server_default="ready")
    error: Mapped[str | None] = mapped_column(Text())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentMessage(Base):
    __tablename__ = "agent_messages"
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key"),
        UniqueConstraint("conversation_id", "sequence"),
        CheckConstraint("sequence > 0", name="ck_agent_messages_sequence_positive"),
        CheckConstraint(
            "input_text IS NULL OR length(input_text) <= 10000",
            name="ck_agent_messages_input_text_length",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column()
    input_text: Mapped[str | None] = mapped_column(Text())
    audio_path: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[MessageStatus] = mapped_column(Enum(MessageStatus), default=MessageStatus.queued)
    result: Mapped[str | None] = mapped_column(Text())
    error: Mapped[str | None] = mapped_column(Text())
    idempotency_key: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class CalendarOperation(Base):
    __tablename__ = "calendar_operations"
    __table_args__ = (
        UniqueConstraint("owner_id", "sequence"),
        UniqueConstraint("owner_id", "command_id", "ordinal"),
        Index("ix_calendar_operations_owner_sequence", "owner_id", "sequence"),
        Index("ix_calendar_operations_owner_target", "owner_id", "resource", "target_id"),
        CheckConstraint("sequence > 0", name="ck_calendar_operations_sequence_positive"),
        CheckConstraint("ordinal >= 0", name="ck_calendar_operations_ordinal_nonnegative"),
        CheckConstraint(
            "operation IN ('create', 'update', 'delete')",
            name="ck_calendar_operations_operation",
        ),
        CheckConstraint("resource IN ('task', 'event')", name="ck_calendar_operations_resource"),
        CheckConstraint(
            "origin IN ('agent', 'rest', 'undo')", name="ck_calendar_operations_origin"
        ),
        CheckConstraint(
            "(operation = 'create' AND before_state IS NULL AND after_state IS NOT NULL) OR "
            "(operation = 'update' AND before_state IS NOT NULL AND after_state IS NOT NULL) OR "
            "(operation = 'delete' AND before_state IS NOT NULL AND after_state IS NULL)",
            name="ck_calendar_operations_snapshots",
        ),
        CheckConstraint(
            "reverts_operation_id IS NULL OR reverts_operation_id <> id",
            name="ck_calendar_operations_not_self_reverting",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    sequence: Mapped[int] = mapped_column(BigInteger)
    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    ordinal: Mapped[int] = mapped_column()
    operation: Mapped[str] = mapped_column(String(16))
    resource: Mapped[str] = mapped_column(String(16))
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    before_state: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    after_state: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    changes: Mapped[dict] = mapped_column(JSON, default=dict)
    origin: Mapped[str] = mapped_column(String(16))
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), index=True
    )
    reverts_operation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("calendar_operations.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
