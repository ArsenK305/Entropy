"""Persist per-workspace choices for local context files."""

from alembic import op
import sqlalchemy as sa


revision = "0007_memory_source_preferences"
down_revision = "0006_career_primary_contact"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "memory_source_preferences",
        sa.Column("workspace", sa.String(16), nullable=False),
        sa.Column("source_id", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("workspace", "source_id"),
    )


def downgrade() -> None:
    op.drop_table("memory_source_preferences")
