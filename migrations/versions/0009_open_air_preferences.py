"""add open-air silence preference

Revision ID: 0009_open_air_preferences
"""

import sqlalchemy as sa
from alembic import op

revision = "0009_open_air_preferences"
down_revision = "0008_calendar_search"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("open_air_silence_ms", sa.Integer(), server_default="1500", nullable=False),
    )
    op.create_check_constraint(
        "ck_users_open_air_silence_range",
        "users",
        "open_air_silence_ms BETWEEN 500 AND 5000",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_open_air_silence_range", "users", type_="check")
    op.drop_column("users", "open_air_silence_ms")
