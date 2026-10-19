"""add recurring calendar series and occurrences

Revision ID: 0010_recurring_calendar_items
"""

import sqlalchemy as sa
from alembic import op

revision = "0010_recurring_calendar_items"
down_revision = "0009_open_air_preferences"
branch_labels = None
depends_on = None


def _resource_columns(table: str) -> None:
    op.add_column(table, sa.Column("recurrence", sa.JSON(), nullable=True))
    op.add_column(table, sa.Column("recurrence_timezone", sa.String(length=64), nullable=True))
    op.add_column(table, sa.Column("recurrence_version_id", sa.UUID(), nullable=True))


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    _resource_columns("tasks")
    _resource_columns("events")
    op.create_table(
        "calendar_schedule_versions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("resource", sa.String(length=16), nullable=False),
        sa.Column("series_id", sa.UUID(), nullable=False),
        sa.Column("anchor_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recurrence", sa.JSON(), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("active_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("active_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("resource IN ('task', 'event')", name="ck_schedule_versions_resource"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_schedule_versions_series",
        "calendar_schedule_versions",
        ["owner_id", "resource", "series_id"],
    )
    op.create_index(
        "ix_calendar_schedule_versions_owner_id", "calendar_schedule_versions", ["owner_id"]
    )
    op.create_table(
        "calendar_occurrence_exceptions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("resource", sa.String(length=16), nullable=False),
        sa.Column("series_id", sa.UUID(), nullable=False),
        sa.Column("occurrence_key", sa.String(length=255), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("original_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("patch", sa.JSON(), nullable=False),
        sa.Column("cancelled", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            "resource IN ('task', 'event')", name="ck_occurrence_exceptions_resource"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "resource", "series_id", "occurrence_key"),
    )
    op.create_index(
        "ix_calendar_occurrence_exceptions_owner_id", "calendar_occurrence_exceptions", ["owner_id"]
    )
    op.create_index(
        "ix_occurrence_exceptions_effective",
        "calendar_occurrence_exceptions",
        ["owner_id", "resource", "effective_at"],
    )
    op.add_column(
        "calendar_operations",
        sa.Column("scope", sa.String(length=16), server_default="series", nullable=False),
    )
    op.add_column(
        "calendar_operations", sa.Column("occurrence_key", sa.String(length=255), nullable=True)
    )
    op.add_column(
        "calendar_operations",
        sa.Column("effective_from_occurrence_key", sa.String(length=255), nullable=True),
    )
    op.create_check_constraint(
        "ck_calendar_operations_scope", "calendar_operations", "scope IN ('series', 'occurrence')"
    )
    op.execute(
        """
        WITH source AS (
          SELECT t.id AS series_id, t.owner_id, t.deadline AS anchor_at, u.timezone,
                 gen_random_uuid() AS version_id
          FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.deadline IS NOT NULL
        ), inserted AS (
          INSERT INTO calendar_schedule_versions
            (id, owner_id, resource, series_id, anchor_at, recurrence, timezone, active_from)
          SELECT version_id, owner_id, 'task', series_id, anchor_at, NULL, timezone, anchor_at FROM source
          RETURNING id, series_id
        )
        UPDATE tasks SET recurrence_version_id = inserted.id FROM inserted WHERE tasks.id = inserted.series_id
        """
    )
    op.execute(
        """
        WITH source AS (
          SELECT e.id AS series_id, e.owner_id, e.starts_at AS anchor_at, u.timezone,
                 gen_random_uuid() AS version_id
          FROM events e JOIN users u ON u.id = e.owner_id
        ), inserted AS (
          INSERT INTO calendar_schedule_versions
            (id, owner_id, resource, series_id, anchor_at, recurrence, timezone, active_from)
          SELECT version_id, owner_id, 'event', series_id, anchor_at, NULL, timezone, anchor_at FROM source
          RETURNING id, series_id
        )
        UPDATE events SET recurrence_version_id = inserted.id FROM inserted WHERE events.id = inserted.series_id
        """
    )


def downgrade() -> None:
    op.drop_constraint("ck_calendar_operations_scope", "calendar_operations", type_="check")
    op.drop_column("calendar_operations", "effective_from_occurrence_key")
    op.drop_column("calendar_operations", "occurrence_key")
    op.drop_column("calendar_operations", "scope")
    op.drop_table("calendar_occurrence_exceptions")
    op.drop_table("calendar_schedule_versions")
    for table in ("events", "tasks"):
        op.drop_column(table, "recurrence_version_id")
        op.drop_column(table, "recurrence_timezone")
        op.drop_column(table, "recurrence")
