"""Shared SQLite engine factory with concurrency-safe pragmas.

The API (`app/main.py`) and the simulation worker (`app/services/sim_worker.py`) open the *same*
database file (a shared Docker volume, `api-db`). Plain SQLite serializes writers, and without WAL +
a busy timeout a concurrent write raises ``sqlite3.OperationalError: database is locked`` — silently
and intermittently. WAL lets readers proceed during a write; ``busy_timeout`` makes a blocked writer
wait (up to N ms) instead of erroring immediately; ``check_same_thread=False`` is required because
FastAPI runs sync endpoints across a thread pool.

Route every production engine that opens the live DB through this factory so the pragmas are applied
consistently.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import event
from sqlmodel import create_engine


def make_sqlite_engine(database_path: Any, *, echo: bool = False):
    """Create a SQLite engine configured for safe concurrent api+worker access."""
    engine = create_engine(
        f"sqlite:///{database_path}",
        echo=echo,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")     # readers don't block the writer
            cursor.execute("PRAGMA busy_timeout=5000")    # wait up to 5s instead of erroring
            cursor.execute("PRAGMA foreign_keys=ON")      # enforce referential integrity
            cursor.execute("PRAGMA synchronous=NORMAL")   # safe + fast under WAL
        finally:
            cursor.close()

    return engine
