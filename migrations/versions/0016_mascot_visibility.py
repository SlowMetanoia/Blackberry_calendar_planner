"""Add mascot visibility preference."""

import sqlalchemy as sa
from alembic import op

revision = "0016_mascot_visibility"
down_revision = "0015_open_air_active_timeout"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("mascot_visible", sa.Boolean(), server_default="true", nullable=False)
    )


def downgrade() -> None:
    op.drop_column("users", "mascot_visible")