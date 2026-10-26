import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
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
        CheckConstraint(
            "open_air_silence_ms BETWEEN 500 AND 5000",
            name="ck_users_open_air_silence_range",
        ),
        CheckConstraint(
            "open_air_active_timeout_seconds BETWEEN 5 AND 300",
            name="ck_users_open_air_active_timeout_range",
        ),
        CheckConstraint("tts_speed BETWEEN 0.75 AND 1.5", name="ck_users_tts_speed_range"),
        CheckConstraint(
            "tts_voice IN ('aidar', 'baya', 'kseniya', 'xenia', 'eugene')",
            name="ck_users_tts_voice",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    upcoming_days: Mapped[int] = mapped_column(default=7, server_default="7")
    open_air_silence_ms: Mapped[int] = mapped_column(default=1500, server_default="1500")
    open_air_active_timeout_seconds: Mapped[int] = mapped_column(default=15, server_default="15")
    voice_output_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    tts_voice: Mapped[str] = mapped_column(String(32), default="kseniya", server_default="kseniya")
    tts_speed: Mapped[float] = mapped_column(Float, default=1.0, server_default="1.0")
    open_air_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    mascot_visible: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
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
    recurrence: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    recurrence_timezone: Mapped[str | None] = mapped_column(String(64))
    recurrence_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


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
    recurrence: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    recurrence_timezone: Mapped[str | None] = mapped_column(String(64))
    recurrence_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Reminder(Base):
    __tablename__ = "reminders"
    __table_args__ = (
        CheckConstraint(
            "(linked_id IS NULL) = (linked_resource IS NULL)", name="ck_reminders_link_pair"
        ),
        CheckConstraint(
            "description IS NULL OR length(description) <= 10000",
            name="ck_reminders_description_length",
        ),
        Index("ix_reminders_link", "owner_id", "linked_resource", "linked_id"),
        CheckConstraint("length(trim(title)) > 0", name="ck_reminders_title_not_blank"),
        CheckConstraint("length(title) <= 500", name="ck_reminders_title_length"),
        CheckConstraint("status IN ('active', 'fired', 'cancelled')", name="ck_reminders_status"),
        CheckConstraint(
            "linked_resource IS NULL OR linked_resource IN ('task', 'event')",
            name="ck_reminders_linked_resource",
        ),
        CheckConstraint(
            "(relative_offset_minutes IS NULL) OR linked_resource IS NOT NULL",
            name="ck_reminders_relative_link",
        ),
        Index("ix_reminders_due", "status", "remind_at"),
        Index("ix_reminders_owner_due", "owner_id", "status", "remind_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text())
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")
    linked_resource: Mapped[str | None] = mapped_column(String(16))
    linked_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    relative_offset_minutes: Mapped[int | None] = mapped_column()
    cancelled_reason: Mapped[str | None] = mapped_column(String(255))
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("reminder_id"),
        Index("ix_notifications_owner_created", "owner_id", "created_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    reminder_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reminders.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500))
    body: Mapped[str | None] = mapped_column(Text())
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (UniqueConstraint("owner_id", "endpoint"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    endpoint: Mapped[str] = mapped_column(Text())
    p256dh: Mapped[str] = mapped_column(Text())
    auth: Mapped[str] = mapped_column(Text())
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'sent', 'failed', 'discarded')", name="ck_delivery_status"
        ),
        CheckConstraint("attempts >= 0", name="ck_delivery_attempts"),
        UniqueConstraint("notification_id", "subscription_id"),
        Index("ix_notification_deliveries_pending", "status", "next_attempt_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    notification_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False
    )
    subscription_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("push_subscriptions.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    last_error: Mapped[str | None] = mapped_column(Text())


class CalendarScheduleVersion(Base):
    __tablename__ = "calendar_schedule_versions"
    __table_args__ = (
        CheckConstraint("resource IN ('task', 'event')", name="ck_schedule_versions_resource"),
        Index("ix_schedule_versions_series", "owner_id", "resource", "series_id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    resource: Mapped[str] = mapped_column(String(16))
    series_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    anchor_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recurrence: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    timezone: Mapped[str] = mapped_column(String(64))
    active_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    active_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CalendarOccurrenceException(Base):
    __tablename__ = "calendar_occurrence_exceptions"
    __table_args__ = (
        CheckConstraint("resource IN ('task', 'event')", name="ck_occurrence_exceptions_resource"),
        UniqueConstraint("owner_id", "resource", "series_id", "occurrence_key"),
        Index("ix_occurrence_exceptions_effective", "owner_id", "resource", "effective_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    resource: Mapped[str] = mapped_column(String(16))
    series_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    occurrence_key: Mapped[str] = mapped_column(String(255))
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    original_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    effective_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    patch: Mapped[dict] = mapped_column(JSON, default=dict)
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False)


class CalendarSearchDocument(Base):
    __tablename__ = "calendar_search_documents"
    __table_args__ = (
        CheckConstraint(
            "resource IN ('task', 'event', 'reminder')", name="ck_search_documents_resource"
        ),
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
    speech_text: Mapped[str | None] = mapped_column(Text())
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
        CheckConstraint(
            "resource IN ('task', 'event', 'reminder')", name="ck_calendar_operations_resource"
        ),
        CheckConstraint("scope IN ('series', 'occurrence')", name="ck_calendar_operations_scope"),
        CheckConstraint(
            "origin IN ('agent', 'rest', 'undo', 'google')", name="ck_calendar_operations_origin"
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
    scope: Mapped[str] = mapped_column(String(16), default="series", server_default="series")
    occurrence_key: Mapped[str | None] = mapped_column(String(255))
    effective_from_occurrence_key: Mapped[str | None] = mapped_column(String(255))
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


class GoogleAccount(Base):
    """A user's linked Google identity and the calendar sync cursor."""

    __tablename__ = "google_accounts"
    __table_args__ = (
        CheckConstraint(
            "sync_status IN ('idle', 'syncing', 'ok', 'error', 'reauth')",
            name="ck_google_accounts_sync_status",
        ),
        CheckConstraint("pushed_sequence >= 0", name="ck_google_accounts_pushed_sequence"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    subject: Mapped[str] = mapped_column(String(255), unique=True)
    email: Mapped[str] = mapped_column(String(320))
    refresh_token_encrypted: Mapped[str | None] = mapped_column(Text())
    calendar_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    calendar_id: Mapped[str] = mapped_column(
        String(255), default="primary", server_default="primary"
    )
    sync_token: Mapped[str | None] = mapped_column(Text())
    pushed_sequence: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    sync_status: Mapped[str] = mapped_column(String(16), default="idle", server_default="idle")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text())
    # Google event IDs that cannot be represented (for example unsupported RRULEs).
    skipped_event_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class GoogleEventLink(Base):
    """Maps a planner schedule version (or one of its occurrences) to a Google event."""

    __tablename__ = "google_event_links"
    __table_args__ = (
        UniqueConstraint("owner_id", "google_event_id"),
        UniqueConstraint("owner_id", "series_id", "version_id", "occurrence_key"),
        Index("ix_google_event_links_series", "owner_id", "series_id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    series_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    # Empty for the series master; the planner occurrence key for an instance override.
    occurrence_key: Mapped[str] = mapped_column(String(255), default="", server_default="")
    google_event_id: Mapped[str] = mapped_column(String(1024))
    etag: Mapped[str | None] = mapped_column(String(255))
    content_hash: Mapped[str | None] = mapped_column(String(64))
    all_day: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Google eventType; birthday and fromGmail events accept only a few fields.
    event_type: Mapped[str] = mapped_column(String(32), default="default", server_default="default")
    # True while the Google event carries notification overrides set by the planner.
    reminders_pushed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
