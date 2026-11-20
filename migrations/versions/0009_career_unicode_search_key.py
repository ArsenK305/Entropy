"""Store a locale-independent normalized key for career tracker search."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

from entropy_app.career import career_application_search_key


revision = "0009_career_search_key"
down_revision = "0008_career_cursor_idx"
branch_labels = None
depends_on = None

# Freeze the fields that existed at this migration revision. Later tracker
# fields must be introduced by their own migration before they can be read here.
SEARCH_FIELDS = (
    "company",
    "job_title",
    "location",
    "contact_name",
    "notes",
)


def upgrade() -> None:
    op.add_column(
        "career_applications",
        sa.Column("search_key", sa.Text(), nullable=False, server_default=""),
    )

    connection = op.get_bind()
    columns = ", ".join(("id", *SEARCH_FIELDS))
    last_id = None
    while True:
        if last_id is None:
            statement = text(
                f"SELECT {columns} FROM career_applications ORDER BY id LIMIT 500"
            )
            result = connection.execute(statement)
        else:
            statement = text(
                f"SELECT {columns} FROM career_applications "
                "WHERE id > :last_id ORDER BY id LIMIT 500"
            )
            result = connection.execute(statement, {"last_id": last_id})
        batch = result.mappings().all()
        result.close()
        if not batch:
            break
        updates = [
            {
                "id": row["id"],
                "search_key": career_application_search_key(dict(row)),
            }
            for row in batch
        ]
        connection.execute(
            text("UPDATE career_applications SET search_key=:search_key WHERE id=:id"),
            updates,
        )
        last_id = batch[-1]["id"]


def downgrade() -> None:
    op.drop_column("career_applications", "search_key")
