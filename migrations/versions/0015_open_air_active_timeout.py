"""Add configurable active hands-free timeout."""

import sqlalchemy as sa
from alembic import op

revision = "0015_open_air_active_timeout"
down_revision = "0014_hands_free_voice"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "open_air_active_timeout_seconds",
            sa.Integer(),
            server_default="15",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_users_open_air_active_timeout_range",
        "users",
        "open_air_active_timeout_seconds BETWEEN 5 AND 300",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_open_air_active_timeout_range", "users", type_="check")
    op.drop_column("users", "open_air_active_timeout_seconds")
