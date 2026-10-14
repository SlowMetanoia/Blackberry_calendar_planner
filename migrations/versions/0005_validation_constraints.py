"""add defensive validation constraints

Revision ID: 0005_validation_constraints
"""

from alembic import op


revision = "0005_validation_constraints"
down_revision = "0004_calendar_operations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLAlchemy previously encoded Python None as JSON null. Normalize it before adding
    # relational snapshot checks; subsequent writes use JSON(none_as_null=True).
    op.execute("UPDATE calendar_operations SET before_state = NULL WHERE before_state::text = 'null'")
    op.execute("UPDATE calendar_operations SET after_state = NULL WHERE after_state::text = 'null'")

    constraints = [
        ("ck_tasks_title_not_blank", "tasks", "length(trim(title)) > 0"),
        ("ck_tasks_title_length", "tasks", "length(title) <= 500"),
        (
            "ck_tasks_description_length",
            "tasks",
            "description IS NULL OR length(description) <= 10000",
        ),
        (
            "ck_tasks_estimated_minutes_positive",
            "tasks",
            "estimated_minutes IS NULL OR estimated_minutes > 0",
        ),
        ("ck_tasks_status", "tasks", "status IN ('open', 'completed')"),
        ("ck_events_title_not_blank", "events", "length(trim(title)) > 0"),
        ("ck_events_title_length", "events", "length(title) <= 500"),
        (
            "ck_events_description_length",
            "events",
            "description IS NULL OR length(description) <= 10000",
        ),
        (
            "ck_events_location_length",
            "events",
            "location IS NULL OR length(location) <= 500",
        ),
        (
            "ck_events_duration_minutes_positive",
            "events",
            "duration_minutes IS NULL OR duration_minutes > 0",
        ),
        ("ck_agent_messages_sequence_positive", "agent_messages", "sequence > 0"),
        (
            "ck_agent_messages_input_text_length",
            "agent_messages",
            "input_text IS NULL OR length(input_text) <= 10000",
        ),
        ("ck_calendar_operations_sequence_positive", "calendar_operations", "sequence > 0"),
        ("ck_calendar_operations_ordinal_nonnegative", "calendar_operations", "ordinal >= 0"),
        (
            "ck_calendar_operations_operation",
            "calendar_operations",
            "operation IN ('create', 'update', 'delete')",
        ),
        (
            "ck_calendar_operations_resource",
            "calendar_operations",
            "resource IN ('task', 'event')",
        ),
        (
            "ck_calendar_operations_origin",
            "calendar_operations",
            "origin IN ('agent', 'rest', 'undo')",
        ),
        (
            "ck_calendar_operations_snapshots",
            "calendar_operations",
            "(operation = 'create' AND before_state IS NULL AND after_state IS NOT NULL) OR "
            "(operation = 'update' AND before_state IS NOT NULL AND after_state IS NOT NULL) OR "
            "(operation = 'delete' AND before_state IS NOT NULL AND after_state IS NULL)",
        ),
        (
            "ck_calendar_operations_not_self_reverting",
            "calendar_operations",
            "reverts_operation_id IS NULL OR reverts_operation_id <> id",
        ),
    ]
    for name, table, condition in constraints:
        op.create_check_constraint(name, table, condition)


def downgrade() -> None:
    for name, table in reversed([
        ("ck_tasks_title_not_blank", "tasks"),
        ("ck_tasks_title_length", "tasks"),
        ("ck_tasks_description_length", "tasks"),
        ("ck_tasks_estimated_minutes_positive", "tasks"),
        ("ck_tasks_status", "tasks"),
        ("ck_events_title_not_blank", "events"),
        ("ck_events_title_length", "events"),
        ("ck_events_description_length", "events"),
        ("ck_events_location_length", "events"),
        ("ck_events_duration_minutes_positive", "events"),
        ("ck_agent_messages_sequence_positive", "agent_messages"),
        ("ck_agent_messages_input_text_length", "agent_messages"),
        ("ck_calendar_operations_sequence_positive", "calendar_operations"),
        ("ck_calendar_operations_ordinal_nonnegative", "calendar_operations"),
        ("ck_calendar_operations_operation", "calendar_operations"),
        ("ck_calendar_operations_resource", "calendar_operations"),
        ("ck_calendar_operations_origin", "calendar_operations"),
        ("ck_calendar_operations_snapshots", "calendar_operations"),
        ("ck_calendar_operations_not_self_reverting", "calendar_operations"),
    ]):
        op.drop_constraint(name, table, type_="check")
