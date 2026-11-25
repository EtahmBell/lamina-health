"""Privileges as a second guard behind the triggers: the application role `lamina_app` may read and
write the pilot tables but has no UPDATE, DELETE or TRUNCATE on the append-only ones -- so even a
statement that disabled a trigger (which the app role can't do: it doesn't own the tables) could
not rewrite the audit trail. The deployed login user is a member of `lamina_app`; the migration
user owns the tables. The role is created NOLOGIN if missing (needs CREATEROLE).

Revision ID: 0002_append_only_privileges
Revises: 0001_pilot_baseline
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic import op

revision = "0002_append_only_privileges"
down_revision = "0001_pilot_baseline"
branch_labels = None
depends_on = None


def _append_only() -> tuple:
    spec = importlib.util.spec_from_file_location("baseline", Path(__file__).with_name("0001_pilot_baseline.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return tuple(table for table, _ in module.APPEND_ONLY)


def upgrade() -> None:
    op.execute("""
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lamina_app') THEN
    CREATE ROLE lamina_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO lamina_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lamina_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lamina_app;
REVOKE ALL ON alembic_version FROM lamina_app;
GRANT SELECT ON alembic_version TO lamina_app;
""")
    for table in (*_append_only(), "outbound_messages"):
        op.execute(f"REVOKE UPDATE, DELETE, TRUNCATE ON {table} FROM lamina_app")
    # outbound_messages: immutable, but retention may delete (parity with SQLite: no UPDATE only).
    op.execute("GRANT DELETE ON outbound_messages TO lamina_app")


def downgrade() -> None:
    op.execute("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lamina_app")
