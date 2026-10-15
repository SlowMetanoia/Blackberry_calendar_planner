"""bind messages and plans to conversations and enforce ordering

Revision ID: 0003_conversation_ordering
"""

from alembic import op

revision = "0003_conversation_ordering"
down_revision = "0002_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO conversations (id, owner_id, created_at, last_activity_at)
        SELECT conversation_id, min(owner_id::text)::uuid, min(created_at), max(created_at)
        FROM agent_messages
        GROUP BY conversation_id
        ON CONFLICT (id) DO NOTHING
        """
    )
    op.create_unique_constraint(
        "uq_agent_messages_conversation_sequence",
        "agent_messages",
        ["conversation_id", "sequence"],
    )
    op.create_foreign_key(
        "fk_agent_messages_conversation",
        "agent_messages",
        "conversations",
        ["conversation_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_action_plans_conversation",
        "action_plans",
        "conversations",
        ["conversation_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_action_plans_conversation", "action_plans", type_="foreignkey")
    op.drop_constraint("fk_agent_messages_conversation", "agent_messages", type_="foreignkey")
    op.drop_constraint("uq_agent_messages_conversation_sequence", "agent_messages", type_="unique")
