"""add reminders and durable notification delivery tables

Revision ID: 0011_reminders_notifications
"""

import sqlalchemy as sa
from alembic import op

revision = "0011_reminders_notifications"
down_revision = "0010_recurring_calendar_items"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_calendar_operations_resource", "calendar_operations", type_="check")
    op.create_check_constraint(
        "ck_calendar_operations_resource",
        "calendar_operations",
        "resource IN ('task', 'event', 'reminder')",
    )
    op.create_table(
        "reminders",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("remind_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("linked_resource", sa.String(length=16), nullable=True),
        sa.Column("linked_id", sa.UUID(), nullable=True),
        sa.Column("relative_offset_minutes", sa.Integer(), nullable=True),
        sa.Column("cancelled_reason", sa.String(length=255), nullable=True),
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("length(trim(title)) > 0", name="ck_reminders_title_not_blank"),
        sa.CheckConstraint("length(title) <= 500", name="ck_reminders_title_length"),
        sa.CheckConstraint(
            "status IN ('active', 'fired', 'cancelled')", name="ck_reminders_status"
        ),
        sa.CheckConstraint(
            "linked_resource IS NULL OR linked_resource IN ('task', 'event')",
            name="ck_reminders_linked_resource",
        ),
        sa.CheckConstraint(
            "relative_offset_minutes IS NULL OR linked_resource IS NOT NULL",
            name="ck_reminders_relative_link",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reminders_owner_id", "reminders", ["owner_id"])
    op.create_index("ix_reminders_remind_at", "reminders", ["remind_at"])
    op.create_index("ix_reminders_due", "reminders", ["status", "remind_at"])
    op.create_index("ix_reminders_owner_due", "reminders", ["owner_id", "status", "remind_at"])

    op.create_table(
        "notifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("reminder_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reminder_id"], ["reminders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reminder_id"),
    )
    op.create_index("ix_notifications_owner_id", "notifications", ["owner_id"])
    op.create_index("ix_notifications_owner_created", "notifications", ["owner_id", "created_at"])

    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "endpoint"),
    )
    op.create_index("ix_push_subscriptions_owner_id", "push_subscriptions", ["owner_id"])

    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("notification_id", sa.UUID(), nullable=False),
        sa.Column("subscription_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["notification_id"], ["notifications.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["subscription_id"], ["push_subscriptions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("notification_id", "subscription_id"),
    )
    op.create_index(
        "ix_notification_deliveries_pending",
        "notification_deliveries",
        ["status", "next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_table("notification_deliveries")
    op.drop_table("push_subscriptions")
    op.drop_table("notifications")
    op.drop_table("reminders")
    op.drop_constraint("ck_calendar_operations_resource", "calendar_operations", type_="check")
    op.create_check_constraint(
        "ck_calendar_operations_resource",
        "calendar_operations",
        "resource IN ('task', 'event')",
    )
