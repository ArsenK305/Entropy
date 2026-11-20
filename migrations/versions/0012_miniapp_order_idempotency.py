"""Make repeated Mini App order requests idempotent."""

from alembic import op
import sqlalchemy as sa


revision = "0012_miniapp_order_idempotency"
down_revision = "0011_event_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("request_id", sa.String(), nullable=True))
    op.create_index("uq_orders_request_id", "orders", ["request_id"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_orders_request_id", table_name="orders")
    op.drop_column("orders", "request_id")
