"""Add a local career application tracker."""

from alembic import op
import sqlalchemy as sa


revision = "0003_career_applications"
down_revision = "0002_orders_and_observability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "career_applications",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("company", sa.String(160), nullable=False),
        sa.Column("job_title", sa.String(160), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False, server_default=""),
        sa.Column("location", sa.String(160), nullable=False, server_default=""),
        sa.Column("salary_range", sa.String(120), nullable=False, server_default=""),
        sa.Column("status", sa.String(24), nullable=False, server_default="saved"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "conversation_id",
            sa.String(),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
        ),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "status IN ("
            "'saved', 'preparing', 'applied', 'interview', 'offer', 'rejected', 'archived'"
            ")",
            name="ck_career_applications_status",
        ),
    )
    op.create_index(
        "ix_career_applications_status_updated_at",
        "career_applications",
        ["status", "updated_at"],
    )
    op.create_index(
        "ix_career_applications_conversation_id",
        "career_applications",
        ["conversation_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_career_applications_conversation_id",
        table_name="career_applications",
    )
    op.drop_index(
        "ix_career_applications_status_updated_at",
        table_name="career_applications",
    )
    op.drop_table("career_applications")
