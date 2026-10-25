"""Track Google event types and planner-managed notifications on Google event links."""

import sqlalchemy as sa
from alembic import op

revision = "0018_google_event_types"
down_revision = "0017_google_calendar_sync"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "google_event_links",
        sa.Column("event_type", sa.String(32), server_default="default", nullable=False),
    )
    op.add_column(
        "google_event_links",
        sa.Column("reminders_pushed", sa.Boolean(), server_default="false", nullable=False),
    )
    # Force one full listing so already linked events learn their Google event type.
    op.execute("UPDATE google_accounts SET sync_token = NULL")


def downgrade() -> None:
    op.drop_column("google_event_links", "reminders_pushed")
    op.drop_column("google_event_links", "event_type")
