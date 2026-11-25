"""Pilot tests on Postgres (run 2).

`LAMINA_TEST_DATABASE_URL` points at a local Postgres the tests may create databases on (the dev
container from docker-compose.dev.yml), e.g. postgresql://lamina:<dev password>@127.0.0.1:5433/lamina_dev.
Once per run, a template database is migrated to head with Alembic (the real migrations, triggers
and privileges); every test then gets its own fresh copy (CREATE DATABASE ... TEMPLATE), dropped
afterwards. So each test runs on the exact production schema, isolated.

`LAMINA_TEST_DB=sqlite` is an explicit opt-in to the old SQLite store for a quick local run. It is
NOT a gate: SQLite can differ (types, triggers, ordering), so the gates run on Postgres.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "backend" / "migrations"
_template: str | None = None


def test_db_mode() -> str:
    mode = os.environ.get("LAMINA_TEST_DB", "postgres").strip().casefold()
    if mode not in {"postgres", "sqlite"}:
        raise RuntimeError("LAMINA_TEST_DB must be postgres or sqlite")
    return mode


def admin_url() -> str:
    import backend.config  # noqa: F401 -- loads the gitignored repository .env (dev/test only)

    url = os.environ.get("LAMINA_TEST_DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError(
            "Pilot tests run on Postgres. Start the dev database (docker compose -f docker-compose.dev.yml up -d) "
            "and set LAMINA_TEST_DATABASE_URL, or opt in to SQLite with LAMINA_TEST_DB=sqlite (not a gate).")
    return url


def _with_database(url: str, name: str) -> str:
    base, _, query = url.partition("?")
    return base.rsplit("/", 1)[0] + "/" + name + (f"?{query}" if query else "")


def _admin_execute(statement: str) -> None:
    import psycopg

    with psycopg.connect(admin_url(), autocommit=True) as connection:
        connection.execute(statement)


def migrate(url: str) -> None:
    env = {**os.environ, "LAMINA_DATABASE_URL": url}
    result = subprocess.run([sys.executable, "-m", "alembic", "-c", str(MIGRATIONS / "alembic.ini"), "upgrade", "head"],
                            cwd=ROOT, env=env, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError("Alembic upgrade failed:\n" + result.stderr[-2000:])


def template_url() -> str:
    """One migrated template per migration content (re-created when a migration changes)."""
    global _template
    if _template:
        return _template
    digest = hashlib.sha256()
    for path in sorted((MIGRATIONS / "versions").glob("*")):
        if path.is_file():
            digest.update(path.read_bytes())
    name = f"lamina_tpl_{digest.hexdigest()[:12]}"
    import psycopg

    with psycopg.connect(admin_url(), autocommit=True) as connection:
        exists = connection.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
    if not exists:
        building = f"{name}_building_{uuid.uuid4().hex[:6]}"
        _admin_execute(f'CREATE DATABASE "{building}"')
        migrate(_with_database(admin_url(), building))
        _admin_execute(f'ALTER DATABASE "{building}" RENAME TO "{name}"')
    _template = _with_database(admin_url(), name)
    return _template


@contextmanager
def fresh_database() -> Iterator[str]:
    """A new database, at the migration head, for one test; dropped afterwards."""
    template = template_url().rsplit("/", 1)[1].split("?")[0]
    name = f"lamina_t_{uuid.uuid4().hex[:12]}"
    _admin_execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
    try:
        yield _with_database(admin_url(), name)
    finally:
        _admin_execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@contextmanager
def pilot_workflow_store(tmp_path: Path) -> Iterator:
    """The workflow store a pilot test runs on: Postgres (default) or, opted in, SQLite."""
    from backend.workflow import WorkflowStore

    if test_db_mode() == "sqlite":
        yield WorkflowStore(tmp_path / "workflow.sqlite")
        return
    with fresh_database() as url:
        yield WorkflowStore(url=url)
