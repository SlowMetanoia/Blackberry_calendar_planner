"""Enable speech by default for new users without overwriting saved preferences."""

import sqlalchemy as sa
from alembic import op

revision = "0019_voice_output_default"
down_revision = "0018_google_event_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("users", "voice_output_enabled", server_default=sa.true())


def downgrade() -> None:
    op.alter_column("users", "voice_output_enabled", server_default=sa.false())
