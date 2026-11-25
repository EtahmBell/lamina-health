"""One-time move of an existing SQLite pilot database to Postgres (run 2).

    LAMINA_DATABASE_URL=postgresql://... python -m scripts.migrate_sqlite_to_postgres --sqlite data/pilot.sqlite
    ... --dry-run     # check and report only; writes nothing

Steps (all or nothing -- one Postgres transaction):
1. Run the source's one-time SQLite upgrades automatically (token scrub + link revocation, rule
   author backfill, column additions, invitation rebuild) by opening it through the current code,
   then CHECK that they took effect (`upgrade_problems`). If an upgrade raises or a check fails,
   nothing is moved. A real run first copies the source to `<name>.pre-upgrade-<time>.sqlite`;
   `--dry-run` upgrades a temporary copy and leaves the source untouched.
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
import shutil
import sqlite3
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SQL = ROOT / "backend" / "migrations" / "versions" / "0001_pilot_tables.sql"


def table_order() -> list[str]:
    """Foreign-key dependency order over EVERY migration's tables (run 3: 0003 adds `patients`,
    which `intake_referrals.patient_id` references), creation order breaking ties."""
    sql = "\n".join(path.read_text(encoding="utf-8") for path in sorted(BASELINE_SQL.parent.glob("*.sql")))
    blocks = re.findall(r"^CREATE TABLE (\w+) \((.*?)^\);", sql, re.MULTILINE | re.DOTALL)
    created = [name for name, _ in blocks]
    needs = {name: set(re.findall(r"REFERENCES (\w+)", body)) - {name} for name, body in blocks}
    for table, target in re.findall(r"^ALTER TABLE (\w+) ADD COLUMN \w+ [^;]*REFERENCES (\w+)", sql, re.MULTILINE):
        if table != target:
            needs.setdefault(table, set()).add(target)
    order: list[str] = []
    while len(order) < len(created):
        ready = next((name for name in created if name not in order and needs.get(name, set()) <= set(order) | (needs.get(name, set()) - set(created))), None)
        if ready is None:
            raise SystemExit("Circular foreign keys between migrated tables")
        order.append(ready)
    return order


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


# Columns the one-time SQLite upgrades add; a source without them was not upgraded.
UPGRADED_COLUMNS = {
    "physician_referral_preferences": ("layer", "owner_scope_id", "created_by", "confirmed_by", "author_source"),
    "practice_members": ("is_admin",),
    "practices": ("allow_physician_loosening", "idle_timeout_minutes"),
    "intake_referrals": ("submitted_referral_type", "handoff_json"),
    "learning_questions": ("owner_scope_id",),
}


def upgrade_problems(source: sqlite3.Connection) -> list[str]:
    """What the one-time SQLite upgrades should have left true. Names tables/columns, never data."""
    from backend.pilot.store import SENDER_LINK_PATTERN

    problems = []
    tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    for table, columns in UPGRADED_COLUMNS.items():
        if table not in tables:
            continue
        present = {row[1] for row in source.execute(f"PRAGMA table_info({table})")}
        problems += [f"{table}.{column} is missing" for column in columns if column not in present]
    if problems:
        return problems
    if "physician_referral_preferences" in tables and source.execute(
            "SELECT COUNT(*) FROM physician_referral_preferences WHERE scope = 'practice' AND author_source IS NULL").fetchone()[0]:
        problems.append("rule versions without an author record (the author backfill did not run)")
    for table, column in (("missing_information_requests", "draft_message"), ("outbound_messages", "body")):
        if table in tables and any(SENDER_LINK_PATTERN.search(row[0] or "") for row in
                                   source.execute(f"SELECT {column} FROM {table} WHERE {column} LIKE '%/r/%'")):
            problems.append(f"{table} still holds a raw sender link (the token scrub did not run)")
    if "practice_invitations" in tables:
        sql = source.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'practice_invitations'").fetchone()[0]
        if "'physician'" not in sql:
            problems.append("practice_invitations was not rebuilt")
    return problems


def run_source_upgrades(sqlite_path: Path) -> None:
    """The source's own one-time upgrades, run through the current code; refuses on any failure."""
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    try:
        PilotStore(workflow=WorkflowStore(sqlite_path))
    except Exception as error:
        raise SystemExit(f"The SQLite source's one-time upgrades failed ({type(error).__name__}); not migrating") from error
    with sqlite3.connect(sqlite_path) as check:
        problems = upgrade_problems(check)
    if problems:
        raise SystemExit("The SQLite source's one-time upgrades did not complete; not migrating:\n  - "
                         + "\n  - ".join(problems))


def migrate(sqlite_path: Path, url: str, *, dry_run: bool = False) -> dict:
    import psycopg

    from backend.database import MIGRATION_HEAD, _psycopg_url
    from backend.pilot.assistant import _SCHEMA as ASSISTANT_SCHEMA

    if not sqlite_path.is_file():
        raise SystemExit(f"No SQLite database at {sqlite_path}")
    backup = None
    if dry_run:
        # Upgrade and read a temporary copy: a dry run never changes the source.
        scratch = Path(tempfile.mkdtemp(prefix="lamina-move-"))
        working = scratch / sqlite_path.name
        shutil.copy2(sqlite_path, working)
    else:
        working = sqlite_path
        backup = sqlite_path.with_name(f"{sqlite_path.stem}.pre-upgrade-{datetime.now(UTC):%Y%m%dT%H%M%S}{sqlite_path.suffix}")
        shutil.copy2(sqlite_path, backup)
    # 1. The source's one-time SQLite upgrades, checked; any failure stops here.
    run_source_upgrades(working)
    source = sqlite3.connect(working)
    source.executescript(ASSISTANT_SCHEMA)  # the assistant's table, if the source never created it
    # 2. Source integrity.
    if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("The SQLite source fails PRAGMA integrity_check; not migrating")
    if source.execute("PRAGMA foreign_key_check").fetchall():
        raise SystemExit("The SQLite source has foreign-key violations; not migrating")
    report: dict = {"source": str(sqlite_path), "dry_run": dry_run, "tables": {}, "upgrades": "ok",
                    "backup": str(backup) if backup else None}
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
    if dry_run:
        shutil.rmtree(working.parent, ignore_errors=True)
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
