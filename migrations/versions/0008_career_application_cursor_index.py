"""Index the immutable ordering used by career tracker pages."""

from alembic import op


revision = "0008_career_cursor_idx"
down_revision = "0007_memory_source_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_career_applications_created_at_id",
        "career_applications",
        ["created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_career_applications_created_at_id",
        table_name="career_applications",
    )
