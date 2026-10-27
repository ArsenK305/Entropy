"""Database engine configuration for local development."""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATABASE_URL = f"sqlite:///{(ROOT / 'data' / 'entropy.db').as_posix()}"


def create_database_engine(database_url: str | None = None) -> Engine:
    """Create an engine from the configured URL without opening a connection."""
    url = database_url or os.environ.get("ENTROPY_DATABASE_URL", DEFAULT_DATABASE_URL)
    options: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite:"):
        options["connect_args"] = {"check_same_thread": False, "timeout": 10}
    elif url.startswith("postgresql"):
        options["connect_args"] = {"connect_timeout": 5}

    engine = create_engine(url, **options)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine
