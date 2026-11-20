"""Add a date for the next career follow-up."""

from alembic import op
import sqlalchemy as sa


revision = "0004_career_follow_up_date"
down_revision = "0003_career_applications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "career_applications",
        sa.Column("follow_up_date", sa.String(10), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("career_applications", "follow_up_date")
