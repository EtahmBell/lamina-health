"""Pilot database connections (run 2): Postgres in production, dev and e2e; SQLite only for the
synthetic demo (and as the legacy pilot store before migration).

`LAMINA_DATABASE_URL` (postgresql://...) selects Postgres. The schema is owned by Alembic
(backend/migrations); the stores never create or alter tables on Postgres -- they check that the
database is at the migration head and refuse otherwise.

`PgConnection` lets the existing store code run unchanged: it behaves like the `sqlite3`
connections the stores used (context manager = one transaction; `execute` returns a cursor with
`fetchone`/`fetchall`/`rowcount`/`lastrowid`; rows readable by name or index). Each statement is
translated deterministically -- and only these constructs, which the pilot uses:

* `?` placeholders -> `%s` (literal `%` escaped);
* `rowid` -> `_rowid` (an identity column every pilot table has; hidden from results);
* `json_extract(col, '$.a.b')` -> `(col::jsonb #>> '{a,b}')`;
* `INSERT OR IGNORE` -> `INSERT ... ON CONFLICT DO NOTHING`;
* `BEGIN IMMEDIATE` -> `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` (the first statement of the
  transaction: the SQLite write lock's serialization, as Postgres expresses it);
* integer-id INSERTs get `RETURNING id` so `lastrowid` works.

Errors raised by triggers or constraints come back as `sqlite3.IntegrityError` (the type the code
and tests already handle), so behaviour on violations is identical across both databases.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, ClassVar, Self

# Tables whose primary key is an integer identity (lastrowid is meaningful).
INTEGER_ID_TABLES = frozenset({"provider_claims", "physician_onboarding_events", "pilot_events"})
HIDDEN_COLUMNS = frozenset({"_rowid"})
MIGRATION_HEAD = "0003_intake_pipeline"


def database_url() -> str:
    return os.environ.get("LAMINA_DATABASE_URL", "").strip()


def is_postgres_url(url: str | None) -> bool:
    return bool(url) and url.startswith(("postgresql://", "postgres://", "postgresql+psycopg://"))


def _psycopg_url(url: str) -> str:
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


# ------------------------------------------------------------------ translation

_JSON_EXTRACT = re.compile(r"json_extract\(\s*([A-Za-z_][\w.]*)\s*,\s*'\$\.([\w.]+)'\s*\)")
_INSERT_OR_IGNORE = re.compile(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\b", re.IGNORECASE)
_INSERT_INTO = re.compile(r"^\s*INSERT\s+INTO\s+(\w+)", re.IGNORECASE)
_ROWID = re.compile(r"(?<![\w.])(\w+\.)?rowid\b")


def translate(sql: str) -> str:
    """SQLite-dialect statement -> Postgres. Pure and deterministic (unit-tested)."""
    stripped = sql.strip()
    if re.fullmatch(r"BEGIN\s+IMMEDIATE", stripped, re.IGNORECASE):
        return "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    out: list[str] = []
    literal = False
    for char in sql:
        if char == "'":
            literal = not literal
            out.append(char)
        elif char == "%":
            out.append("%%")
        elif char == "?" and not literal:
            out.append("%s")
        else:
            out.append(char)
    text = "".join(out)
    text = _JSON_EXTRACT.sub(lambda m: f"({m.group(1)}::jsonb #>> '{{{m.group(2).replace('.', ',')}}}')", text)
    text = _ROWID.sub(lambda m: f"{m.group(1) or ''}_rowid", text)
    if _INSERT_OR_IGNORE.match(text):
        text = _INSERT_OR_IGNORE.sub("INSERT INTO", text, count=1).rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    insert = _INSERT_INTO.match(text)
    if insert and insert.group(1) in INTEGER_ID_TABLES and " returning " not in text.casefold():
        text = text.rstrip().rstrip(";") + " RETURNING id"
    return text


# --------------------------------------------------------------------- adapter

class Row(tuple):
    """Like sqlite3.Row: index or column-name access; `dict(row)`; `row.keys()`."""

    __slots__ = ()
    _columns: tuple[str, ...] = ()
    _index: ClassVar[dict[str, int]] = {}

    def __getitem__(self, key: Any) -> Any:  # type: ignore[override]
        if isinstance(key, str):
            return tuple.__getitem__(self, self._index[key])
        return tuple.__getitem__(self, key)

    def keys(self) -> list[str]:
        return list(self._columns)


def _row_class(names: tuple[str, ...]) -> type[Row]:
    return type("Row", (Row,), {"_columns": names, "_index": {name: index for index, name in enumerate(names)},
                                "__slots__": ()})


class PgCursor:
    def __init__(self, cursor: Any, returning_id: bool) -> None:
        self._cursor = cursor
        self.rowcount = cursor.rowcount
        self.lastrowid = None
        self._buffer: list | None = None
        if returning_id and cursor.description:
            rows = cursor.fetchall()
            self.lastrowid = rows[-1][0] if rows else None
            self._buffer = []

    def _wrap(self, record: tuple | None) -> Row | None:
        if record is None:
            return None
        names = tuple(column.name for column in self._cursor.description)
        keep = [index for index, name in enumerate(names) if name not in HIDDEN_COLUMNS]
        cls = _row_class(tuple(names[index] for index in keep))
        return cls(tuple(record[index] for index in keep))

    def fetchone(self) -> Row | None:
        if self._buffer is not None or self._cursor.description is None:
            return None
        return self._wrap(self._cursor.fetchone())

    def fetchall(self) -> list[Row]:
        if self._buffer is not None or self._cursor.description is None:
            return []
        return [self._wrap(record) for record in self._cursor.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())


class PgConnection:
    """One transaction per `with` block, like sqlite3: commit on success, roll back on error."""

    def __init__(self, url: str, *, read_only: bool = False) -> None:
        import psycopg

        self._psycopg = psycopg
        self._connection = psycopg.connect(_psycopg_url(url), autocommit=False)
        # Operator scripts open the database read-only: Postgres refuses any write in the session.
        self._connection.read_only = read_only
        self._started = False

    def execute(self, sql: str, params: tuple | list = ()) -> PgCursor:
        statement = translate(sql)
        if statement == "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE":
            # SQLite's BEGIN IMMEDIATE (always the first statement of its block): serialize this
            # transaction. Set on the connection before its first query.
            if not self._started:
                self._connection.isolation_level = self._psycopg.IsolationLevel.SERIALIZABLE
            return PgCursor(self._connection.cursor(), returning_id=False)
        self._started = True
        cursor = self._connection.cursor()
        # A savepoint per statement: like SQLite, a failed statement is undone on its own and the
        # transaction stays usable (Postgres would otherwise abort the whole transaction).
        cursor.execute("SAVEPOINT lamina_statement")
        try:
            # Always a tuple (even empty): the driver then unescapes the doubled `%`.
            cursor.execute(statement, tuple(params or ()))
        except self._psycopg.Error as error:
            cursor.execute("ROLLBACK TO SAVEPOINT lamina_statement")
            if isinstance(error, self._psycopg.errors.RaiseException | self._psycopg.errors.IntegrityError):
                # A trigger's RAISE EXCEPTION or a constraint: the same error type as on SQLite.
                raise sqlite3.IntegrityError(error.diag.message_primary or str(error)) from error
            raise
        result = PgCursor(cursor, returning_id=statement.endswith(" RETURNING id") and "RETURNING id" not in sql)
        self._connection.cursor().execute("RELEASE SAVEPOINT lamina_statement")
        return result

    def executescript(self, _script: str) -> None:
        raise RuntimeError("Schema changes on Postgres go through Alembic migrations only")

    def commit(self) -> None:
        self._connection.commit()
        self._started = False

    def rollback(self) -> None:
        self._connection.rollback()
        self._started = False

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._connection.commit()
            else:
                self._connection.rollback()
        finally:
            self._connection.close()


def connect(url: str) -> PgConnection:
    return PgConnection(url)


def connect_read_only(target: str) -> Any:
    """For operator scripts: a Postgres URL (read-only session) or a SQLite path (mode=ro).
    Both accept `?` placeholders and return rows with column-name access."""
    if is_postgres_url(target):
        return PgConnection(target, read_only=True)
    if not Path(target).is_file():
        raise FileNotFoundError(target)
    db = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def assert_at_migration_head(url: str) -> None:
    """The app never creates or alters tables on Postgres: the database must already be migrated."""
    with connect(url) as db:
        try:
            row = db.execute("SELECT version_num FROM alembic_version").fetchone()
        except Exception as error:  # the table is missing: not migrated
            raise RuntimeError("The pilot database is not migrated. Run: alembic -c backend/migrations/alembic.ini upgrade head") from error
    if not row or row[0] != MIGRATION_HEAD:
        raise RuntimeError(f"The pilot database is at migration {row[0] if row else 'none'}, not {MIGRATION_HEAD}. "
                           "Run: alembic -c backend/migrations/alembic.ini upgrade head")
