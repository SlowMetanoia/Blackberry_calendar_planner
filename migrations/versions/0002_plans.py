"""conversation and action plans"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0002_plans"; down_revision="0001_initial"; branch_labels=None; depends_on=None
def upgrade():
    uid=postgresql.UUID(as_uuid=True)
    plan_status=postgresql.ENUM("pending","partially_confirmed","executing","completed","cancelled","failed",name="planstatus",create_type=False)
    action_status=postgresql.ENUM("pending","approved","rejected","executing","completed","failed","cancelled",name="actionstatus",create_type=False)
    plan_status.create(op.get_bind(), checkfirst=True); action_status.create(op.get_bind(), checkfirst=True)
    op.create_table("conversations", sa.Column("id",uid,primary_key=True), sa.Column("owner_id",uid,sa.ForeignKey("users.id",ondelete="CASCADE"),nullable=False), sa.Column("created_at",sa.DateTime(timezone=True),server_default=sa.func.now()), sa.Column("last_activity_at",sa.DateTime(timezone=True),server_default=sa.func.now()), sa.Column("expires_at",sa.DateTime(timezone=True)))
    op.create_index("ix_conversations_owner_id","conversations",["owner_id"])
    op.create_table("action_plans", sa.Column("id",uid,primary_key=True), sa.Column("owner_id",uid,sa.ForeignKey("users.id",ondelete="CASCADE"),nullable=False), sa.Column("conversation_id",uid,nullable=False), sa.Column("source_message_id",uid,sa.ForeignKey("agent_messages.id",ondelete="SET NULL")), sa.Column("status",plan_status,nullable=False), sa.Column("created_at",sa.DateTime(timezone=True),server_default=sa.func.now()), sa.Column("expires_at",sa.DateTime(timezone=True)))
    op.create_index("ix_action_plans_owner_id","action_plans",["owner_id"])
    op.create_table("planned_actions", sa.Column("id",uid,primary_key=True), sa.Column("plan_id",uid,sa.ForeignKey("action_plans.id",ondelete="CASCADE"),nullable=False), sa.Column("ordinal",sa.Integer(),nullable=False), sa.Column("operation",sa.String(16),nullable=False), sa.Column("resource",sa.String(32),nullable=False), sa.Column("target_id",uid), sa.Column("payload",sa.JSON(),nullable=False), sa.Column("status",action_status,nullable=False), sa.Column("result",sa.JSON()), sa.Column("error",sa.Text()), sa.Column("expires_at",sa.DateTime(timezone=True)))
    op.create_index("ix_planned_actions_plan_id","planned_actions",["plan_id"])
def downgrade():
    op.drop_table("planned_actions"); op.drop_table("action_plans"); op.drop_table("conversations")
    sa.Enum(name="actionstatus").drop(op.get_bind(), checkfirst=True); sa.Enum(name="planstatus").drop(op.get_bind(), checkfirst=True)
