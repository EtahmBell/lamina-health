"""Alembic environment for the pilot database. Raw-SQL migrations (no ORM models). The database URL
comes only from LAMINA_DATABASE_URL -- never from a file in the repository."""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine, pool


def _url() -> str:
    url = os.environ.get("LAMINA_DATABASE_URL", "").strip()
    if not url.startswith(("postgresql://", "postgres://", "postgresql+psycopg://")):
        raise RuntimeError("Set LAMINA_DATABASE_URL to the Postgres database to migrate")
    # SQLAlchemy's psycopg (v3) dialect.
    return "postgresql+psycopg://" + url.split("://", 1)[1]


def run_migrations_online() -> None:
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=None, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    context.configure(url=_url(), target_metadata=None, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
