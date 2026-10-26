"""Enforce reminder linkage and delivery state invariants."""

from alembic import op

revision = "0013_reminder_integrity"
down_revision = "0012_reminder_search_resource"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_reminders_link_pair", "reminders", "(linked_id IS NULL) = (linked_resource IS NULL)"
    )
    op.create_check_constraint(
        "ck_reminders_description_length",
        "reminders",
        "description IS NULL OR length(description) <= 10000",
    )
    op.create_check_constraint(
        "ck_delivery_status",
        "notification_deliveries",
        "status IN ('pending', 'sent', 'failed', 'discarded')",
    )
    op.create_check_constraint("ck_delivery_attempts", "notification_deliveries", "attempts >= 0")
    op.create_index("ix_reminders_link", "reminders", ["owner_id", "linked_resource", "linked_id"])
    op.execute("""
        INSERT INTO calendar_search_documents
            (owner_id, resource, target_id, normalized_title, normalized_description, content_hash)
        SELECT owner_id, 'reminder', id,
            regexp_replace(lower(replace(trim(title), 'ё', 'е')), '\\s+', ' ', 'g'),
            regexp_replace(lower(replace(trim(coalesce(description, '')), 'ё', 'е')), '\\s+', ' ', 'g'),
            encode(digest(title || E'\\n' || coalesce(description, ''), 'sha256'), 'hex')
        FROM reminders ON CONFLICT DO NOTHING
    """)
    op.execute("""
        INSERT INTO calendar_search_index_states
            (owner_id, requested_generation, completed_generation, status)
        SELECT DISTINCT owner_id, 1, 0, 'pending' FROM reminders
        ON CONFLICT (owner_id) DO UPDATE SET
            requested_generation = calendar_search_index_states.requested_generation + 1,
            status = 'pending'
    """)


def downgrade() -> None:
    op.drop_index("ix_reminders_link", "reminders")
    op.drop_constraint("ck_delivery_attempts", "notification_deliveries", type_="check")
    op.drop_constraint("ck_delivery_status", "notification_deliveries", type_="check")
    op.drop_constraint("ck_reminders_description_length", "reminders", type_="check")
    op.drop_constraint("ck_reminders_link_pair", "reminders", type_="check")
