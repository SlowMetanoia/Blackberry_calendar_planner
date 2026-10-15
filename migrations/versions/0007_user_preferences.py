"""add user calendar preferences

Revision ID: 0007_user_preferences
"""

import sqlalchemy as sa
from alembic import op

revision = "0007_user_preferences"
down_revision = "0006_auth_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("upcoming_days", sa.Integer(), server_default="7", nullable=False),
    )
    op.create_check_constraint(
        "ck_users_upcoming_days_range",
        "users",
        "upcoming_days BETWEEN 1 AND 90",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_upcoming_days_range", "users", type_="check")
    op.drop_column("users", "upcoming_days")
