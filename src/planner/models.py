import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Index, String, Text, UniqueConstraint, func, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

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
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text())
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_minutes: Mapped[int | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(32), default="open")


class Event(Base):
    __tablename__ = "events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text())
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int | None] = mapped_column()
    location: Mapped[str | None] = mapped_column(String(500))


class AgentMessage(Base):
    __tablename__ = "agent_messages"
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key"),
        UniqueConstraint("conversation_id", "sequence"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
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
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

class CalendarOperation(Base):
    __tablename__ = "calendar_operations"
    __table_args__ = (
        UniqueConstraint("owner_id", "sequence"),
        UniqueConstraint("owner_id", "command_id", "ordinal"),
        Index("ix_calendar_operations_owner_sequence", "owner_id", "sequence"),
        Index("ix_calendar_operations_owner_target", "owner_id", "resource", "target_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    sequence: Mapped[int] = mapped_column(BigInteger)
    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    ordinal: Mapped[int] = mapped_column()
    operation: Mapped[str] = mapped_column(String(16))
    resource: Mapped[str] = mapped_column(String(16))
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    before_state: Mapped[dict | None] = mapped_column(JSON)
    after_state: Mapped[dict | None] = mapped_column(JSON)
    changes: Mapped[dict] = mapped_column(JSON, default=dict)
    origin: Mapped[str] = mapped_column(String(16))
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL"), index=True
    )
    reverts_operation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("calendar_operations.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
