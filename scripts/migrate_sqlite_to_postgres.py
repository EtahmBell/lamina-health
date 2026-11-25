"""One-time move of an existing SQLite pilot database to Postgres (run 2).

    LAMINA_DATABASE_URL=postgresql://... python -m scripts.migrate_sqlite_to_postgres --sqlite data/pilot.sqlite
    ... --dry-run     # check and report only; writes nothing

Steps (all or nothing -- one Postgres transaction):
1. Open the SQLite file through the current code once, so its own pending SQLite upgrades run
   (token scrub, author backfill, column additions) and the source is the latest SQLite shape.
2. Check the source: `PRAGMA integrity_check` and `PRAGMA foreign_key_check` must be clean.
3. The target must be at the Alembic head with every pilot table EMPTY (never merges).
4. Copy each table in dependency order, rows in their original insertion order (so `_rowid`
   order matches SQLite's rowid). User triggers are paused for the copy only -- they guard
   *changes* (e.g. "new owner scopes start pending" would reject an already-approved scope);
   foreign keys stay enforced. Identity sequences are moved past the copied ids.
5. Verify, per table: row counts equal, and a SHA-256 over the canonical rows (ordered by primary
   key, every column) equal on both sides. Any difference rolls the whole move back.

Prints counts and checksums only -- never row contents. Synthetic data in every test.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SQL = ROOT / "backend" / "migrations" / "versions" / "0001_pilot_tables.sql"


def table_order() -> list[str]:
    """Dependency order = the baseline's creation order."""
    return re.findall(r"^CREATE TABLE (\w+) \(", BASELINE_SQL.read_text(encoding="utf-8"), re.MULTILINE)


def _canonical(value: object) -> str:
    if value is None:
        return "\x00"
    if isinstance(value, float) and value.is_integer():
        return repr(value)
    return str(value)


def _checksum(rows: list[tuple]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps([_canonical(value) for value in row]).encode("utf-8"))
    return digest.hexdigest()


def _pk(pg, table: str) -> list[str]:
    rows = pg.execute(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = %s::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)", (table,)).fetchall()
    return [row[0] for row in rows]


def migrate(sqlite_path: Path, url: str, *, dry_run: bool = False) -> dict:
    import psycopg

    from backend.database import MIGRATION_HEAD, _psycopg_url
    from backend.pilot.assistant import _SCHEMA as ASSISTANT_SCHEMA
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    if not sqlite_path.is_file():
        raise SystemExit(f"No SQLite database at {sqlite_path}")
    # 1. Bring the source to the latest SQLite shape (its own one-time upgrades).
    PilotStore(workflow=WorkflowStore(sqlite_path))
    source = sqlite3.connect(sqlite_path)
    source.executescript(ASSISTANT_SCHEMA)  # the assistant's table, if the source never created it
    # 2. Source integrity.
    if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("The SQLite source fails PRAGMA integrity_check; not migrating")
    if source.execute("PRAGMA foreign_key_check").fetchall():
        raise SystemExit("The SQLite source has foreign-key violations; not migrating")
    report: dict = {"source": str(sqlite_path), "dry_run": dry_run, "tables": {}}
    with psycopg.connect(_psycopg_url(url), autocommit=False) as pg:
        head = pg.execute("SELECT version_num FROM alembic_version").fetchone()
        if not head or head[0] != MIGRATION_HEAD:
            raise SystemExit(f"The target is not at the migration head ({MIGRATION_HEAD}); run alembic upgrade head first")
        tables = table_order()
        busy = [table for table in tables if pg.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()]
        if busy:
            raise SystemExit("The target already has data in: " + ", ".join(busy) + " (the move never merges)")
        source_tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table in tables:
            target_columns = [row[0] for row in pg.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = %s AND column_name <> '_rowid' "
                "ORDER BY ordinal_position", (table,)).fetchall()]
            if table not in source_tables:
                report["tables"][table] = {"rows": 0, "note": "not in the source"}
                continue
            source_columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
            extra = [column for column in source_columns if column not in target_columns]
            if extra and source.execute(f"SELECT COUNT(*) FROM {table} WHERE " + " OR ".join(
                    f"{column} IS NOT NULL" for column in extra)).fetchone()[0]:
                raise SystemExit(f"{table} has data in columns the Postgres schema doesn't have: {extra}")
            columns = [column for column in target_columns if column in source_columns]
            rows = source.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY rowid").fetchall()
            report["tables"][table] = {"rows": len(rows)}
            if dry_run or not rows:
                continue
            pg.execute(f"ALTER TABLE {table} DISABLE TRIGGER USER")
            placeholders = ", ".join(["%s"] * len(columns))
            with pg.cursor() as cursor:
                cursor.executemany(f"INSERT INTO {table} ({', '.join(columns)}) OVERRIDING SYSTEM VALUE VALUES ({placeholders})",
                                   rows)
            pg.execute(f"ALTER TABLE {table} ENABLE TRIGGER USER")
            if "id" in columns and pg.execute("SELECT pg_get_serial_sequence(%s, 'id')", (table,)).fetchone()[0]:
                pg.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), (SELECT MAX(id) FROM {table}))")
        # 5. Verify every table: counts and content checksums.
        problems = []
        for table, entry in report["tables"].items():
            if dry_run or "note" in entry:
                continue
            columns = [column for column in (row[0] for row in pg.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = %s AND column_name <> '_rowid' "
                "ORDER BY ordinal_position", (table,)).fetchall())
                if column in [r[1] for r in source.execute(f"PRAGMA table_info({table})")]]
            order = ", ".join(_pk(pg, table) or columns)
            pg_rows = pg.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}").fetchall()
            src_rows = source.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}").fetchall()
            entry["checksum"] = _checksum(src_rows)
            if len(pg_rows) != len(src_rows):
                problems.append(f"{table}: {len(src_rows)} rows in SQLite, {len(pg_rows)} in Postgres")
            elif _checksum(pg_rows) != entry["checksum"]:
                problems.append(f"{table}: contents differ")
        if problems:
            pg.rollback()
            raise SystemExit("Verification failed; nothing was written:\n  - " + "\n  - ".join(problems))
        if dry_run:
            pg.rollback()
        else:
            pg.commit()
    source.close()
    report["verified"] = not dry_run
    report["total_rows"] = sum(entry["rows"] for entry in report["tables"].values())
    return report


def main(argv: list[str]) -> int:
    import os

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sqlite", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    url = os.environ.get("LAMINA_DATABASE_URL", "")
    if not url.startswith(("postgresql://", "postgres://", "postgresql+psycopg://")):
        raise SystemExit("Set LAMINA_DATABASE_URL to the target Postgres database")
    print(json.dumps(migrate(args.sqlite, url, dry_run=args.dry_run), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
