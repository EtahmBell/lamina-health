"""The pilot on Postgres (run 2): the SQL translation, the Alembic schema, every append-only and
immutability guarantee (triggers AND privileges), and the one-time SQLite -> Postgres move.
Synthetic data only. Needs the local dev Postgres (tests/pg_support.py)."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import psycopg
import pytest

from backend.database import MIGRATION_HEAD, translate
from tests.pg_support import fresh_database, test_db_mode

ROOT = Path(__file__).resolve().parents[1]
needs_postgres = pytest.mark.skipif(test_db_mode() == "sqlite", reason="LAMINA_TEST_DB=sqlite (not a gate)")


# ------------------------------------------------------------ translation (no server)


@pytest.mark.parametrize(("sqlite", "postgres"), [
    ("SELECT * FROM t WHERE a = ? AND b LIKE '%?x%'", "SELECT * FROM t WHERE a = %s AND b LIKE '%%?x%%'"),
    ("INSERT OR IGNORE INTO public_profiles (a) VALUES (?)", "INSERT INTO public_profiles (a) VALUES (%s) ON CONFLICT DO NOTHING"),
    ("SELECT 1 FROM x WHERE json_extract(metadata_json, '$.rule_id') = ?", "SELECT 1 FROM x WHERE (metadata_json::jsonb #>> '{rule_id}') = %s"),
    ("SELECT * FROM t ORDER BY created_at, rowid", "SELECT * FROM t ORDER BY created_at, _rowid"),
    ("SELECT * FROM t r ORDER BY r.created_at, r.rowid", "SELECT * FROM t r ORDER BY r.created_at, r._rowid"),
    ("BEGIN IMMEDIATE", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"),
    ("INSERT INTO provider_claims (a) VALUES (?)", "INSERT INTO provider_claims (a) VALUES (%s) RETURNING id"),
    ("INSERT INTO practices (a) VALUES (?)", "INSERT INTO practices (a) VALUES (%s)"),
])
def test_translation(sqlite: str, postgres: str) -> None:
    assert translate(sqlite) == postgres


def test_every_pilot_table_in_code_is_in_the_postgres_baseline() -> None:
    """A new pilot table must come with a migration (drift guard)."""
    # Every migration's SQL (0001 baseline, 0003 intake pipeline, ...), plus columns added by ALTER.
    baseline = "\n".join(path.read_text(encoding="utf-8") for path in
                         sorted((ROOT / "backend" / "migrations" / "versions").glob("*.sql")))
    added = {(table, column) for table, column in re.findall(r"^ALTER TABLE (\w+) ADD COLUMN (\w+)", baseline, re.MULTILINE)}
    migrated = set(re.findall(r"^CREATE TABLE (\w+) \(", baseline, re.MULTILINE))
    for module in ("store.py", "assistant.py"):
        text = (ROOT / "backend" / "pilot" / module).read_text(encoding="utf-8")
        assert set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", text)) <= migrated, module
    # Every column of every table, as the SQLite code creates it, exists in the Postgres DDL.
    import tempfile

    from backend.pilot.assistant import _SCHEMA as ASSISTANT_SCHEMA
    from backend.pilot.store import PilotStore
    from backend.workflow import WorkflowStore

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        path = Path(directory) / "schema.sqlite"
        PilotStore(workflow=WorkflowStore(path))
        db = sqlite3.connect(path)
        db.executescript(ASSISTANT_SCHEMA)
        missing = []
        for table in migrated:
            body = re.search(rf"^CREATE TABLE {table} \((.*?)^\);", baseline, re.MULTILINE | re.DOTALL).group(1)
            columns = set(re.findall(r"^\s*(\w+) ", body, re.MULTILINE))
            missing += [f"{table}.{row[1]}" for row in db.execute(f"PRAGMA table_info({table})")
                        if row[1] not in columns and (table, row[1]) not in added]
        db.close()
    assert missing == [], f"columns missing from Postgres: {missing}"


# ------------------------------------------------------------------ on Postgres


@pytest.fixture
def pg():
    with fresh_database() as url, psycopg.connect(url, autocommit=True) as connection:
        yield connection


def _fails(connection, statement: str, params: tuple = (), match: str = "") -> None:
    with pytest.raises(psycopg.Error) as caught:
        connection.execute(statement, params)
    assert match in str(caught.value), str(caught.value)


APPEND_ONLY_ROWS = {
    "pilot_events": (("INSERT INTO pilot_events (event_type, actor, autonomy, metadata_json, created_at) "
                      "VALUES ('x', 'user:a', 'human', '{}', 't')"), "pilot_events is append-only"),
    "capability_events": (("INSERT INTO capability_events (id, practice_id, event_type, actor, actor_role, created_at) "
                           "VALUES ('c1', 'p', 'activated', 'user:a', 'physician', 't')"), "capability events are append-only"),
}


@needs_postgres
def test_migrated_to_head_with_every_guarantee(pg) -> None:
    assert pg.execute("SELECT version_num FROM alembic_version").fetchone()[0] == MIGRATION_HEAD
    triggers = {row[0] for row in pg.execute("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal").fetchall()}
    sqlite_triggers = set(re.findall(r"CREATE TRIGGER (?:IF NOT EXISTS )?(\w+)", (ROOT / "backend" / "pilot" / "store.py").read_text(encoding="utf-8")))
    # Every SQLite append-only trigger exists on Postgres (owner-scope insert checks are merged into one).
    assert sqlite_triggers <= triggers, sqlite_triggers - triggers
    for table, (insert, message) in APPEND_ONLY_ROWS.items():
        pg.execute(insert)
        _fails(pg, f"UPDATE {table} SET actor = 'user:b'", match=message)
        _fails(pg, f"DELETE FROM {table}", match=message)
        _fails(pg, f"TRUNCATE {table}", match=message)


@needs_postgres
def test_identity_approval_and_rule_guarantees(pg) -> None:
    pg.execute("INSERT INTO provider_claims (auth_user_id, npi, status, claimed_at, updated_at) VALUES ('u1', '1234567893', 'claimed', 't', 't')")
    _fails(pg, "INSERT INTO provider_claims (auth_user_id, npi, status, claimed_at, updated_at) VALUES ('u1', '1234567802', 'claimed', 't', 't')",
           match="account already holds an active physician claim")
    _fails(pg, "UPDATE provider_claims SET npi = '1234567802'", match="provider claim identity is immutable")
    claim = pg.execute("SELECT id FROM provider_claims").fetchone()[0]
    scope = ("INSERT INTO physician_owner_scopes (id, provider_claim_id, auth_user_id, npi, storage_scope_id, physician_id, "
             "provider_identity_json, created_at, updated_at, pilot_access_status) VALUES (%s, %s, %s, %s, %s, %s, '{}', 't', 't', %s)")
    _fails(pg, scope, ("s0", claim, "u1", "1234567893", "st0", "ph0", "approved"), match="new owner scopes start pending")
    _fails(pg, scope, ("s0", claim, "someone-else", "1234567893", "st0", "ph0", "pending"), match="must match its provider claim")
    pg.execute(scope, ("s1", claim, "u1", "1234567893", "st1", "ph1", "pending"))
    _fails(pg, "UPDATE physician_owner_scopes SET pilot_access_status = 'approved'", match="requires a confirmed active identity")
    pg.execute("UPDATE provider_claims SET identity_confirmed_at = 't'")
    pg.execute("UPDATE physician_owner_scopes SET pilot_access_status = 'approved'")
    _fails(pg, "UPDATE physician_owner_scopes SET physician_id = 'other'", match="owner scope identity is immutable")
    rule = ("INSERT INTO physician_referral_preferences (id, workspace_id, physician_id, case_family, source_text, "
            "structured_rules_json, status, source, created_at, updated_at, scope) VALUES (%s, 'w', 'p', 'Thyroid', '', '{}', %s, 's', 't', 't', %s)")
    pg.execute(rule, ("r1", "draft", "physician"))
    assert pg.execute("SELECT referral_type, operational_status, physician_confirmed FROM physician_referral_preferences WHERE id = 'r1'").fetchone() == ("Thyroid", "inferred", 0)
    pg.execute(rule, ("r2", "confirmed", "practice"))
    _fails(pg, "UPDATE physician_referral_preferences SET source_text = 'changed' WHERE id = 'r2'", match="practice rule content is immutable")


@needs_postgres
def test_the_app_role_cannot_rewrite_append_only_tables(pg) -> None:
    for table, (insert, _message) in APPEND_ONLY_ROWS.items():
        pg.execute(insert)
        pg.execute("SET ROLE lamina_app")
        try:
            _fails(pg, f"UPDATE {table} SET actor = actor", match="permission denied")
            _fails(pg, f"DELETE FROM {table}", match="permission denied")
            _fails(pg, f"ALTER TABLE {table} DISABLE TRIGGER USER", match="must be owner")
            pg.execute(insert.replace("'x'", "'y'").replace("'c1'", "'c2'"))  # appending is allowed
        finally:
            pg.execute("RESET ROLE")


@needs_postgres
def test_the_sqlite_to_postgres_move_copies_and_verifies_everything(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A real pilot written on SQLite (through the API), moved to an empty Postgres database:
    counts and content checksums match, guarantees hold afterwards, and the app reads it."""
    from backend.workflow import WorkflowStore
    from scripts.migrate_sqlite_to_postgres import migrate
    from tests.test_pilot_foundation import _pilot  # the shared pilot builder, on SQLite here

    monkeypatch.setenv("LAMINA_OPENAI_ENABLED", "false")
    source = tmp_path / "pilot.sqlite"
    builder = _pilot(tmp_path, monkeypatch, WorkflowStore(source))
    pilot = next(builder)
    pilot.ready_physician()
    pilot.add_rule()
    pilot.add_staff()
    for _ in range(3):
        rid = pilot.referral("user-c")["referral"]["id"]
    pilot.post(f"/api/me/practice/referrals/{rid}/disposition", "user-a", {"decision": "accept"})
    with fresh_database() as url:
        dry = migrate(source, url, dry_run=True)
        assert dry["dry_run"] and dry["tables"]["intake_referrals"]["rows"] == 3
        with psycopg.connect(url) as connection:
            assert connection.execute("SELECT COUNT(*) FROM intake_referrals").fetchone()[0] == 0, "a dry run writes nothing"
        report = migrate(source, url)
        assert report["verified"] and report["tables"]["pilot_events"]["rows"] > 10
        with psycopg.connect(url, autocommit=True) as connection:
            assert connection.execute("SELECT COUNT(*) FROM intake_referrals").fetchone()[0] == 3
            _fails(connection, "UPDATE pilot_events SET actor = 'x'", match="append-only")
            # New rows continue after the copied ids.
            connection.execute("INSERT INTO pilot_events (event_type, actor, autonomy, metadata_json, created_at) "
                               "VALUES ('after_move', 'system', 'automatic', '{}', 't')")
        with pytest.raises(SystemExit, match="already has data"):
            migrate(source, url)
        # The app reads the moved data on Postgres.
        moved = next(_pilot(tmp_path / "pg", monkeypatch, WorkflowStore(url=url)))
        assert len(moved.get("/api/me/practice/referrals", "user-a").json()) == 3
        assert moved.status("user-c")["role"] == "staff"


@needs_postgres
def test_the_move_refuses_a_corrupt_source(tmp_path: Path) -> None:
    from scripts.migrate_sqlite_to_postgres import migrate

    bad = tmp_path / "bad.sqlite"
    bad.write_bytes(b"not a database")
    with fresh_database() as url, pytest.raises((SystemExit, sqlite3.DatabaseError)):
        migrate(bad, url)


@needs_postgres
def test_operator_scripts_open_postgres_read_only() -> None:
    """scripts/activation_metrics.py and scripts/check_rule_keys.py read through connect_read_only."""
    from backend.database import connect_read_only

    with fresh_database() as url:
        db = connect_read_only(url)
        try:
            assert db.execute("SELECT COUNT(*) FROM pilot_events").fetchone()[0] == 0
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                db.execute("INSERT INTO practices (id, name, created_at, updated_at) VALUES ('p', 'x', 't', 't')")
        finally:
            db.close()


def test_the_move_runs_the_sqlite_upgrades_first_and_refuses_if_they_fail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run 3: the one-time SQLite upgrades run automatically on the source before anything moves;
    an upgrade that raises, or one that leaves the source un-upgraded, stops the move."""
    from backend.pilot import store as store_module
    from backend.workflow import WorkflowStore
    from scripts import migrate_sqlite_to_postgres as move

    source = tmp_path / "legacy.sqlite"
    store_module.PilotStore(workflow=WorkflowStore(source))
    with sqlite3.connect(source) as db:
        assert move.upgrade_problems(db) == [], "a store opened by the current code is fully upgraded"
    raw = "/r/" + "A" * 32  # a pre-Step-16 raw sender link saved in stored text
    with sqlite3.connect(":memory:") as bare:
        bare.execute("CREATE TABLE practices (id TEXT)")
        bare.execute("CREATE TABLE physician_referral_preferences (id TEXT, scope TEXT)")
        assert any("layer is missing" in problem for problem in move.upgrade_problems(bare))
        bare.execute("CREATE TABLE outbound_messages (body TEXT)")
        bare.execute("INSERT INTO outbound_messages VALUES (?)", (f"see {raw}",))
    with sqlite3.connect(":memory:") as linked:
        linked.execute("CREATE TABLE outbound_messages (body TEXT)")
        linked.execute("INSERT INTO outbound_messages VALUES (?)", (f"see {raw}",))
        assert move.upgrade_problems(linked) == ["outbound_messages still holds a raw sender link (the token scrub did not run)"]

    def failing(*_args, **_kwargs):
        raise sqlite3.OperationalError("simulated")

    monkeypatch.setattr(store_module, "PilotStore", failing)
    with pytest.raises(SystemExit, match=r"one-time upgrades failed \(OperationalError\); not migrating"):
        move.migrate(source, "postgresql://unused.invalid/none")
    # The real attempt backed the source up before upgrading it.
    assert len(list(tmp_path.glob("legacy.pre-upgrade-*.sqlite"))) == 1
    monkeypatch.setattr(store_module, "PilotStore", lambda **_kwargs: None)  # "ran" but did nothing
    monkeypatch.setattr(move, "upgrade_problems", lambda _db: ["practices.idle_timeout_minutes is missing"])
    with pytest.raises(SystemExit, match="did not complete; not migrating"):
        move.migrate(source, "postgresql://unused.invalid/none", dry_run=True)
    assert len(list(tmp_path.glob("legacy.pre-upgrade-*.sqlite"))) == 1, "a dry run works on a temporary copy"


@needs_postgres
def test_intake_pipeline_audit_tables_are_append_only(pg) -> None:
    """Run 3 (migration 0003): webhook receipts and patient merges -- triggers and privileges."""
    pg.execute("INSERT INTO practices (id, name, created_by_user_id, created_at, updated_at) VALUES ('p', 'Synthetic', 'u', 't', 't')")
    pg.execute("INSERT INTO patients (id, practice_id, name, name_key, created_by, created_at, updated_at) "
               "VALUES ('pa', 'p', 'A', 'a', 'u', 't', 't'), ('pb', 'p', 'B', 'b', 'u', 't', 't')")
    rows = {
        "inbound_webhook_receipts": (("INSERT INTO inbound_webhook_receipts (id, channel, provider, provider_event_id, outcome, received_at) "
                                     "VALUES ('{id}', 'fax', 'mock', '{id}', 'unroutable', 't')"), "outcome = outcome",
                                     "webhook receipts are append-only"),
        "patient_merges": (("INSERT INTO patient_merges (id, practice_id, action, survivor_id, merged_id, referral_ids_json, actor, "
                           "actor_role, created_at) VALUES ('{id}', 'p', 'merge', 'pa', 'pb', '[]', 'user:u', 'staff', 't')"),
                           "reason = 'x'", "patient merges are append-only"),
    }
    for table, (insert, change, message) in rows.items():
        pg.execute(insert.format(id="r1"))
        _fails(pg, f"UPDATE {table} SET {change}", match=message)
        _fails(pg, f"DELETE FROM {table}", match=message)
        _fails(pg, f"TRUNCATE {table}", match=message)
        pg.execute("SET ROLE lamina_app")
        try:
            _fails(pg, f"UPDATE {table} SET {change}", match="permission denied")
            pg.execute(insert.format(id="r2"))  # appending is allowed
        finally:
            pg.execute("RESET ROLE")
    # The same replayed vendor event can't be recorded twice.
    _fails(pg, rows["inbound_webhook_receipts"][0].format(id="r1").replace("VALUES ('r1'", "VALUES ('r9'"), match="duplicate key")
