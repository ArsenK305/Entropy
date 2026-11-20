"""Queue order webhook deliveries in the order transaction."""

from alembic import op
import sqlalchemy as sa


revision = "0013_n8n_dispatch_outbox"
down_revision = "0012_miniapp_order_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "n8n_dispatch_outbox",
        sa.Column("order_id", sa.String(), sa.ForeignKey("orders.id"), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("available_at", sa.Text(), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_expires_at", sa.Text()),
        sa.Column("last_http_status", sa.Integer()),
        sa.Column("last_error", sa.Text()),
        sa.Column("delivered_at", sa.Text()),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "ix_n8n_dispatch_outbox_due",
        "n8n_dispatch_outbox",
        ["status", "available_at", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_n8n_dispatch_outbox_due", table_name="n8n_dispatch_outbox")
    op.drop_table("n8n_dispatch_outbox")
