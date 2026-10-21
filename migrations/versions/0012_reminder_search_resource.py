"""allow reminder records in the calendar search projection

Revision ID: 0012_reminder_search_resource
"""

from alembic import op

revision = "0012_reminder_search_resource"
down_revision = "0011_reminders_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_search_documents_resource", "calendar_search_documents", type_="check")
    op.create_check_constraint(
        "ck_search_documents_resource",
        "calendar_search_documents",
        "resource IN ('task', 'event', 'reminder')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_search_documents_resource", "calendar_search_documents", type_="check")
    op.create_check_constraint(
        "ck_search_documents_resource",
        "calendar_search_documents",
        "resource IN ('task', 'event')",
    )
