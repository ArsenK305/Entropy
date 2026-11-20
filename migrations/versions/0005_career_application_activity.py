"""Record status and follow-up changes on career applications."""

from alembic import op
import sqlalchemy as sa


revision = "0005_career_application_activity"
down_revision = "0004_career_follow_up_date"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "career_application_activity",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "application_id",
            sa.String(64),
            sa.ForeignKey("career_applications.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("from_value", sa.Text(), nullable=True),
        sa.Column("to_value", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "ix_career_application_activity_application_created",
        "career_application_activity",
        ["application_id", "created_at", "id"],
    )
    op.execute(
        """
        INSERT INTO career_application_activity (application_id, event_type, created_at)
        SELECT id, 'created', created_at FROM career_applications
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_career_application_activity_application_created",
        table_name="career_application_activity",
    )
    op.drop_table("career_application_activity")
