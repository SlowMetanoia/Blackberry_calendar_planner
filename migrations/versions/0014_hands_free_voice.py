"""Add hands-free voice preferences and persisted speech text."""

import sqlalchemy as sa
from alembic import op

revision = "0014_hands_free_voice"
down_revision = "0013_reminder_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("voice_output_enabled", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("tts_voice", sa.String(length=32), server_default="kseniya", nullable=False),
    )
    op.add_column("users", sa.Column("tts_speed", sa.Float(), server_default="1.0", nullable=False))
    op.add_column(
        "users", sa.Column("open_air_default", sa.Boolean(), server_default="false", nullable=False)
    )
    op.create_check_constraint(
        "ck_users_tts_speed_range", "users", "tts_speed BETWEEN 0.75 AND 1.5"
    )
    op.create_check_constraint(
        "ck_users_tts_voice",
        "users",
        "tts_voice IN ('aidar', 'baya', 'kseniya', 'xenia', 'eugene')",
    )
    op.add_column("agent_messages", sa.Column("speech_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_messages", "speech_text")
    op.drop_constraint("ck_users_tts_voice", "users", type_="check")
    op.drop_constraint("ck_users_tts_speed_range", "users", type_="check")
    op.drop_column("users", "open_air_default")
    op.drop_column("users", "tts_speed")
    op.drop_column("users", "tts_voice")
    op.drop_column("users", "voice_output_enabled")
