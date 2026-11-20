"""Keep the original job posting with its career tracker card."""

from alembic import op
import sqlalchemy as sa


revision = "0010_career_job_desc"
down_revision = "0009_career_search_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "career_applications",
        sa.Column("job_description", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("career_applications", "job_description")
