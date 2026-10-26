"""Add Google accounts, Google event links and the google operation origin."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0017_google_calendar_sync"
down_revision = "0016_mascot_visibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "google_accounts",
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("subject", sa.String(255), nullable=False, unique=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("refresh_token_encrypted", sa.Text()),
        sa.Column("calendar_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("calendar_id", sa.String(255), server_default="primary", nullable=False),
        sa.Column("sync_token", sa.Text()),
        sa.Column("pushed_sequence", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("sync_status", sa.String(16), server_default="idle", nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.Text()),
        sa.Column("skipped_event_ids", sa.JSON(), server_default="[]", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "sync_status IN ('idle', 'syncing', 'ok', 'error', 'reauth')",
            name="ck_google_accounts_sync_status",
        ),
        sa.CheckConstraint("pushed_sequence >= 0", name="ck_google_accounts_pushed_sequence"),
    )
    op.create_table(
        "google_event_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "owner_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("series_id", UUID(as_uuid=True), nullable=False),
        sa.Column("version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("occurrence_key", sa.String(255), server_default="", nullable=False),
        sa.Column("google_event_id", sa.String(1024), nullable=False),
        sa.Column("etag", sa.String(255)),
        sa.Column("content_hash", sa.String(64)),
        sa.Column("all_day", sa.Boolean(), server_default="false", nullable=False),
        sa.UniqueConstraint("owner_id", "google_event_id"),
        sa.UniqueConstraint("owner_id", "series_id", "version_id", "occurrence_key"),
    )
    op.create_index("ix_google_event_links_series", "google_event_links", ["owner_id", "series_id"])
    op.drop_constraint("ck_calendar_operations_origin", "calendar_operations", type_="check")
    op.create_check_constraint(
        "ck_calendar_operations_origin",
        "calendar_operations",
        "origin IN ('agent', 'rest', 'undo', 'google')",
    )


def downgrade() -> None:
    # Keep imported history replayable; the old schema has no dedicated origin for it.
    op.execute("UPDATE calendar_operations SET origin = 'rest' WHERE origin = 'google'")
    op.drop_constraint("ck_calendar_operations_origin", "calendar_operations", type_="check")
    op.create_check_constraint(
        "ck_calendar_operations_origin",
        "calendar_operations",
        "origin IN ('agent', 'rest', 'undo')",
    )
    op.drop_index("ix_google_event_links_series", "google_event_links")
    op.drop_table("google_event_links")
    op.drop_table("google_accounts")
