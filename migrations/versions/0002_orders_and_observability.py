"""Add demo orders and persistent observability events."""

from alembic import op
import sqlalchemy as sa


revision = "0002_orders_and_observability"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "orders",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("product_id", sa.String(), nullable=False),
        sa.Column("product_name", sa.Text(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_table(
        "observability_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("correlation_id", sa.String()),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index("ix_orders_created_at", "orders", ["created_at"])
    op.create_index("ix_observability_events_created_at", "observability_events", ["created_at"])
    op.create_index("ix_observability_events_correlation_id_id", "observability_events", ["correlation_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_observability_events_correlation_id_id", table_name="observability_events")
    op.drop_index("ix_observability_events_created_at", table_name="observability_events")
    op.drop_index("ix_orders_created_at", table_name="orders")
    op.drop_table("observability_events")
    op.drop_table("orders")
