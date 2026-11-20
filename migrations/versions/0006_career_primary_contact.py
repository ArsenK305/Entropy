"""Store the primary recruiter contact on each career application."""

from alembic import op
import sqlalchemy as sa


revision = "0006_career_primary_contact"
down_revision = "0005_career_application_activity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "career_applications",
        sa.Column("contact_name", sa.String(120), nullable=False, server_default=""),
    )
    op.add_column(
        "career_applications",
        sa.Column("contact_url", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("career_applications", "contact_url")
    op.drop_column("career_applications", "contact_name")
