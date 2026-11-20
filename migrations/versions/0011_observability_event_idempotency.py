"""Allow workflow callbacks to be stored idempotently."""

from alembic import op
import sqlalchemy as sa


revision = "0011_event_idempotency"
down_revision = "0010_career_job_desc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "observability_events",
        sa.Column("idempotency_key", sa.String(200), nullable=True),
    )
    op.create_index(
        "uq_observability_events_idempotency_key",
        "observability_events",
        ["idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_observability_events_idempotency_key",
        table_name="observability_events",
    )
    op.drop_column("observability_events", "idempotency_key")
