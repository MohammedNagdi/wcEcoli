"""The shared SQLite engine must apply concurrency-safe pragmas to every connection."""

from app.db.engine import make_sqlite_engine


def test_sqlite_engine_sets_wal_and_busy_timeout(tmp_path):
    engine = make_sqlite_engine(tmp_path / "t.db")
    try:
        with engine.connect() as conn:
            assert conn.exec_driver_sql("PRAGMA journal_mode").scalar().lower() == "wal"
            assert conn.exec_driver_sql("PRAGMA busy_timeout").scalar() == 5000
            assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        # A second pooled connection must get the pragmas too (the listener fires per-connect).
        with engine.connect() as conn2:
            assert conn2.exec_driver_sql("PRAGMA busy_timeout").scalar() == 5000
    finally:
        engine.dispose()
