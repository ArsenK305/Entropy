"""Store notes for user-recorded career actions."""

from alembic import op
import sqlalchemy as sa


revision = "0014_career_activity_notes"
down_revision = "0013_n8n_dispatch_outbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "career_application_activity",
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("career_application_activity", "note")
