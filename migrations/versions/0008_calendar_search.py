"""add hybrid calendar search index

Revision ID: 0008_calendar_search
"""

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

revision = "0008_calendar_search"
down_revision = "0007_user_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "calendar_search_documents",
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("resource", sa.String(length=16), nullable=False),
        sa.Column("target_id", sa.UUID(), nullable=False),
        sa.Column("normalized_title", sa.Text(), nullable=False),
        sa.Column("normalized_description", sa.Text(), server_default="", nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("embedding", Vector(768), nullable=True),
        sa.Column("embedding_model", sa.String(length=255), nullable=True),
        sa.Column("embedding_content_hash", sa.String(length=64), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("resource IN ('task', 'event')", name="ck_search_documents_resource"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("owner_id", "resource", "target_id"),
    )
    op.create_index(
        "ix_search_documents_owner_resource",
        "calendar_search_documents",
        ["owner_id", "resource"],
    )
    op.execute(
        "CREATE INDEX ix_search_documents_title_trgm "
        "ON calendar_search_documents USING gin (normalized_title gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX ix_search_documents_description_trgm "
        "ON calendar_search_documents USING gin (normalized_description gin_trgm_ops)"
    )
    op.create_table(
        "calendar_search_index_states",
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("requested_generation", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("completed_generation", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=16), server_default="ready", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "requested_generation >= completed_generation",
            name="ck_search_index_generation_order",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'failed')",
            name="ck_search_index_status",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("owner_id"),
    )
    op.execute(
        """
        INSERT INTO calendar_search_documents
            (owner_id, resource, target_id, normalized_title, normalized_description, content_hash)
        SELECT owner_id, 'task', id,
               regexp_replace(lower(replace(trim(title), 'ё', 'е')), '\\s+', ' ', 'g'),
               regexp_replace(lower(replace(trim(coalesce(description, '')), 'ё', 'е')), '\\s+', ' ', 'g'),
               md5(lower(replace(trim(title), 'ё', 'е')) || E'\\n' ||
                   lower(replace(trim(coalesce(description, '')), 'ё', 'е')))
        FROM tasks
        UNION ALL
        SELECT owner_id, 'event', id,
               regexp_replace(lower(replace(trim(title), 'ё', 'е')), '\\s+', ' ', 'g'),
               regexp_replace(lower(replace(trim(coalesce(description, '')), 'ё', 'е')), '\\s+', ' ', 'g'),
               md5(lower(replace(trim(title), 'ё', 'е')) || E'\\n' ||
                   lower(replace(trim(coalesce(description, '')), 'ё', 'е')))
        FROM events
        """
    )
    op.execute(
        """
        INSERT INTO calendar_search_index_states
            (owner_id, requested_generation, completed_generation, status)
        SELECT DISTINCT owner_id, 1, 0, 'pending'
        FROM calendar_search_documents
        """
    )


def downgrade() -> None:
    op.drop_table("calendar_search_index_states")
    op.drop_index("ix_search_documents_description_trgm", table_name="calendar_search_documents")
    op.drop_index("ix_search_documents_title_trgm", table_name="calendar_search_documents")
    op.drop_index("ix_search_documents_owner_resource", table_name="calendar_search_documents")
    op.drop_table("calendar_search_documents")
