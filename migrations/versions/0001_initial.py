"""initial schema

Revision ID: 0001_initial
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "users",
        sa.Column("id", uid, primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="UTC"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    for table, columns in {
        "tasks": [
            ("title", sa.String(500), False),
            ("description", sa.Text(), True),
            ("deadline", sa.DateTime(timezone=True), True),
            ("estimated_minutes", sa.Integer(), True),
            ("status", sa.String(32), False),
        ],
        "events": [
            ("title", sa.String(500), False),
            ("description", sa.Text(), True),
            ("starts_at", sa.DateTime(timezone=True), False),
            ("duration_minutes", sa.Integer(), True),
            ("location", sa.String(500), True),
        ],
    }.items():
        op.create_table(
            table,
            sa.Column("id", uid, primary_key=True),
            sa.Column(
                "owner_id", uid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
            ),
            *[sa.Column(n, t, nullable=nullable) for n, t, nullable in columns],
        )
        op.create_index(f"ix_{table}_owner_id", table, ["owner_id"])
    op.create_table(
        "agent_messages",
        sa.Column("id", uid, primary_key=True),
        sa.Column("owner_id", uid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("conversation_id", uid, nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("input_text", sa.Text()),
        sa.Column("audio_path", sa.String(1000)),
        sa.Column(
            "status",
            sa.Enum(
                "queued",
                "transcribing",
                "processing",
                "needs_confirmation",
                "needs_clarification",
                "completed",
                "failed",
                name="messagestatus",
            ),
            nullable=False,
        ),
        sa.Column("result", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("idempotency_key", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("owner_id", "idempotency_key"),
    )
    op.create_index("ix_agent_messages_owner_id", "agent_messages", ["owner_id"])
    op.create_index("ix_agent_messages_conversation_id", "agent_messages", ["conversation_id"])


def downgrade() -> None:
    op.drop_table("agent_messages")
    op.drop_table("events")
    op.drop_table("tasks")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
    sa.Enum(name="messagestatus").drop(op.get_bind(), checkfirst=True)
