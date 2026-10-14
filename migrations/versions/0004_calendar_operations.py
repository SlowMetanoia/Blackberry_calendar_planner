"""replace confirmation plans with immutable calendar operations"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_calendar_operations"
down_revision = "0003_conversation_ordering"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("planned_actions")
    op.drop_constraint("fk_action_plans_conversation", "action_plans", type_="foreignkey")
    op.drop_table("action_plans")
    op.execute("DROP TYPE actionstatus")
    op.execute("DROP TYPE planstatus")
    op.execute(
        "CREATE TYPE messagestatus_without_confirmation AS ENUM "
        "('queued','transcribing','processing','needs_clarification','completed','failed')"
    )
    op.execute(
        "ALTER TABLE agent_messages ALTER COLUMN status TYPE "
        "messagestatus_without_confirmation USING status::text::messagestatus_without_confirmation"
    )
    op.execute("DROP TYPE messagestatus")
    op.execute("ALTER TYPE messagestatus_without_confirmation RENAME TO messagestatus")
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "calendar_operations",
        sa.Column("id", uid, primary_key=True),
        sa.Column("owner_id", uid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("command_id", uid, nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("resource", sa.String(16), nullable=False),
        sa.Column("target_id", uid, nullable=False),
        sa.Column("before_state", sa.JSON()),
        sa.Column("after_state", sa.JSON()),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("source_message_id", uid, sa.ForeignKey("agent_messages.id", ondelete="SET NULL")),
        sa.Column("reverts_operation_id", uid, sa.ForeignKey("calendar_operations.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("owner_id", "sequence"),
        sa.UniqueConstraint("owner_id", "command_id", "ordinal"),
    )
    op.create_index("ix_calendar_operations_owner_sequence", "calendar_operations", ["owner_id", "sequence"])
    op.create_index("ix_calendar_operations_owner_target", "calendar_operations", ["owner_id", "resource", "target_id"])
    op.create_index("ix_calendar_operations_source_message_id", "calendar_operations", ["source_message_id"])
    op.create_index("ix_calendar_operations_reverts_operation_id", "calendar_operations", ["reverts_operation_id"])


def downgrade() -> None:
    raise RuntimeError("calendar operation history cannot be safely downgraded")
