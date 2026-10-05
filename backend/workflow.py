"""Small Lamina-owned demo workflow record, separate from clinical FHIR data."""

from __future__ import annotations

import json
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from backend.config import environment
from backend.models import ConsultationResult


class WorkflowStore:
    LEGACY_WORKSPACE_ID = "legacy-local-workspace"

    def __init__(self, path: Path | None = None) -> None:
        default = Path(__file__).resolve().parents[1] / "data" / "workflow.sqlite"
        self.path = path or Path(environment.get("LAMINA_WORKFLOW_DATABASE", str(default)))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS demo_workspaces (
                  workspace_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS patient_activity (
                  workspace_id TEXT NOT NULL, patient_id TEXT NOT NULL,
                  last_opened TEXT, last_started TEXT, last_consultation TEXT,
                  consultation_count INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY(workspace_id, patient_id)
                );
                CREATE TABLE IF NOT EXISTS consultations (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
                  patient_id TEXT NOT NULL,
                  completed_at TEXT NOT NULL, result_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_preferences (
                  workspace_id TEXT NOT NULL, key TEXT NOT NULL, statement TEXT NOT NULL,
                  provenance TEXT NOT NULL, status TEXT NOT NULL,
                  updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, key)
                );
                CREATE TABLE IF NOT EXISTS network_members (
                  workspace_id TEXT NOT NULL, npi TEXT NOT NULL, added_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, npi)
                );
                CREATE TABLE IF NOT EXISTS specialist_case_reviews (
                  workspace_id TEXT NOT NULL,
                  consultation_record_id INTEGER NOT NULL,
                  specialist_npi TEXT NOT NULL,
                  reviewed_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, consultation_record_id, specialist_npi)
                );
                CREATE TABLE IF NOT EXISTS specialist_calibrations (
                  workspace_id TEXT NOT NULL,
                  specialist_npi TEXT NOT NULL,
                  learning_key TEXT NOT NULL,
                  consultation_record_id INTEGER NOT NULL,
                  statement TEXT NOT NULL,
                  provenance TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(
                    workspace_id, specialist_npi, learning_key, consultation_record_id
                  )
                );
                CREATE TABLE IF NOT EXISTS physician_profile_items (
                  workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  item_id TEXT NOT NULL,
                  category TEXT NOT NULL,
                  title TEXT NOT NULL,
                  detail TEXT,
                  provenance TEXT NOT NULL,
                  shareable INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, persona_id, item_id)
                );
                CREATE TABLE IF NOT EXISTS training_sessions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
                  created_at TEXT NOT NULL,
                  completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS training_responses (
                  workspace_id TEXT NOT NULL,
                  session_id INTEGER NOT NULL,
                  persona_id TEXT NOT NULL,
                  question_id TEXT NOT NULL,
                  answer_json TEXT,
                  skipped INTEGER NOT NULL DEFAULT 0,
                  answered_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, session_id, question_id)
                );
                CREATE TABLE IF NOT EXISTS proposed_agent_learnings (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  source_type TEXT NOT NULL,
                  source_reference TEXT NOT NULL,
                  statement TEXT NOT NULL,
                  provenance TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  UNIQUE(workspace_id, persona_id, source_type, source_reference)
                );
                CREATE TABLE IF NOT EXISTS practice_updates (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  update_type TEXT NOT NULL,
                  title TEXT NOT NULL,
                  body TEXT NOT NULL,
                  provenance TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
                  agent_drafted INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  published_at TEXT
                );
                CREATE TABLE IF NOT EXISTS provider_claims (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  auth_user_id TEXT NOT NULL,
                  npi TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN (
                    'claimed', 'verification_pending', 'verified', 'rejected', 'revoked'
                  )),
                  claimed_at TEXT NOT NULL,
                  verification_submitted_at TEXT,
                  verified_at TEXT,
                  updated_at TEXT NOT NULL,
                  verification_method TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS provider_claims_active_npi
                  ON provider_claims(npi)
                  WHERE status IN ('claimed', 'verification_pending', 'verified');
                CREATE INDEX IF NOT EXISTS provider_claims_auth_user
                  ON provider_claims(auth_user_id, updated_at);
                CREATE TABLE IF NOT EXISTS provider_agent_state (
                  npi TEXT PRIMARY KEY,
                  status TEXT NOT NULL CHECK(status IN ('inactive', 'active', 'disabled')),
                  practice_confirmed INTEGER NOT NULL DEFAULT 0,
                  preferences_json TEXT,
                  activated_at TEXT,
                  disabled_at TEXT,
                  updated_at TEXT NOT NULL
                );
                """
            )
            self._migrate_demo_tables(db)
            db.executescript(
                """
                CREATE INDEX IF NOT EXISTS consultations_workspace_id
                  ON consultations(workspace_id, id DESC);
                CREATE INDEX IF NOT EXISTS demo_workspaces_expiry
                  ON demo_workspaces(expires_at);
                CREATE INDEX IF NOT EXISTS specialist_reviews_workspace
                  ON specialist_case_reviews(workspace_id, specialist_npi);
                CREATE INDEX IF NOT EXISTS specialist_calibrations_workspace
                  ON specialist_calibrations(workspace_id, specialist_npi);
                CREATE INDEX IF NOT EXISTS profile_items_workspace
                  ON physician_profile_items(workspace_id, persona_id);
                CREATE INDEX IF NOT EXISTS training_sessions_workspace
                  ON training_sessions(workspace_id, persona_id, id DESC);
                CREATE INDEX IF NOT EXISTS proposed_learnings_workspace
                  ON proposed_agent_learnings(workspace_id, persona_id, id DESC);
                CREATE INDEX IF NOT EXISTS practice_updates_workspace
                  ON practice_updates(workspace_id, persona_id, id DESC);
                """
            )
            if "last_started" not in {
                row["name"] for row in db.execute("PRAGMA table_info(patient_activity)")
            }:
                db.execute("ALTER TABLE patient_activity ADD COLUMN last_started TEXT")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @staticmethod
    def _columns(db: sqlite3.Connection, table: str) -> set[str]:
        return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}

    def _migrate_demo_tables(self, db: sqlite3.Connection) -> None:
        """Move pre-workspace demo rows into a non-issued legacy workspace."""
        now = self._now()
        expiry = (datetime.now(UTC) + timedelta(days=3650)).isoformat(timespec="seconds")
        migrated = False
        table_definitions = {
            "patient_activity": """(
              workspace_id TEXT NOT NULL, patient_id TEXT NOT NULL,
              last_opened TEXT, last_started TEXT, last_consultation TEXT,
              consultation_count INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(workspace_id, patient_id)
            )""",
            "agent_preferences": """(
              workspace_id TEXT NOT NULL, key TEXT NOT NULL, statement TEXT NOT NULL,
              provenance TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, key)
            )""",
            "network_members": """(
              workspace_id TEXT NOT NULL, npi TEXT NOT NULL, added_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, npi)
            )""",
        }
        copy_columns = {
            "patient_activity": (
                "patient_id,last_opened,last_started,last_consultation,consultation_count"
            ),
            "agent_preferences": "key,statement,provenance,status,updated_at",
            "network_members": "npi,added_at",
        }
        for table, definition in table_definitions.items():
            existing_columns = self._columns(db, table)
            if "workspace_id" in existing_columns:
                continue
            legacy = f"{table}_pre_workspace"
            db.execute(f"ALTER TABLE {table} RENAME TO {legacy}")
            db.execute(f"CREATE TABLE {table} {definition}")
            columns = copy_columns[table]
            selected_columns = columns
            if table == "patient_activity" and "last_started" not in existing_columns:
                selected_columns = (
                    "patient_id,last_opened,NULL,last_consultation,consultation_count"
                )
            db.execute(
                f"INSERT INTO {table}(workspace_id,{columns}) "
                f"SELECT ?,{selected_columns} FROM {legacy}",
                (self.LEGACY_WORKSPACE_ID,),
            )
            db.execute(f"DROP TABLE {legacy}")
            migrated = True
        if "workspace_id" not in self._columns(db, "consultations"):
            db.execute(
                "ALTER TABLE consultations ADD COLUMN workspace_id TEXT NOT NULL "
                f"DEFAULT '{self.LEGACY_WORKSPACE_ID}'"
            )
            migrated = True
        if migrated:
            db.execute(
                """INSERT OR IGNORE INTO demo_workspaces(
                     workspace_id, created_at, last_seen_at, expires_at
                   ) VALUES (?, ?, ?, ?)""",
                (self.LEGACY_WORKSPACE_ID, now, now, expiry),
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat(timespec="seconds")

    def resolve_demo_workspace(
        self, candidate: str | None, ttl_seconds: int
    ) -> tuple[str, bool]:
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat(timespec="seconds")
        expires = (now_dt + timedelta(seconds=ttl_seconds)).isoformat(timespec="seconds")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if candidate:
                row = db.execute(
                    "SELECT expires_at FROM demo_workspaces WHERE workspace_id=?",
                    (candidate,),
                ).fetchone()
                if row and row["expires_at"] > now:
                    db.execute(
                        "UPDATE demo_workspaces SET last_seen_at=?, expires_at=? "
                        "WHERE workspace_id=?",
                        (now, expires, candidate),
                    )
                    return candidate, False
            while True:
                workspace_id = secrets.token_urlsafe(32)
                try:
                    db.execute(
                        """INSERT INTO demo_workspaces(
                             workspace_id, created_at, last_seen_at, expires_at
                           ) VALUES (?, ?, ?, ?)""",
                        (workspace_id, now, now, expires),
                    )
                    return workspace_id, True
                except sqlite3.IntegrityError:
                    continue

    def cleanup_expired_demo_workspaces(self) -> int:
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT workspace_id FROM demo_workspaces WHERE expires_at < ? "
                "AND workspace_id <> ?",
                (now, self.LEGACY_WORKSPACE_ID),
            ).fetchall()
            workspace_ids = [row["workspace_id"] for row in rows]
            for workspace_id in workspace_ids:
                for table in (
                    "patient_activity", "consultations", "agent_preferences", "network_members",
                    "specialist_case_reviews", "specialist_calibrations",
                    "physician_profile_items", "training_responses", "training_sessions",
                    "proposed_agent_learnings", "practice_updates",
                ):
                    db.execute(f"DELETE FROM {table} WHERE workspace_id=?", (workspace_id,))
                db.execute(
                    "DELETE FROM demo_workspaces WHERE workspace_id=?", (workspace_id,)
                )
        return len(workspace_ids)

    def opened(self, workspace_id: str, patient_id: str) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO patient_activity(workspace_id, patient_id, last_opened)
                   VALUES (?, ?, ?) ON CONFLICT(workspace_id, patient_id)
                   DO UPDATE SET last_opened=excluded.last_opened""",
                (workspace_id, patient_id, self._now()),
            )

    def started(self, workspace_id: str, patient_id: str) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO patient_activity(workspace_id, patient_id, last_started)
                   VALUES (?, ?, ?) ON CONFLICT(workspace_id, patient_id)
                   DO UPDATE SET last_started=excluded.last_started""",
                (workspace_id, patient_id, self._now()),
            )

    def completed(self, workspace_id: str, result: ConsultationResult) -> int:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO consultations(
                     workspace_id, patient_id, completed_at, result_json
                   ) VALUES (?, ?, ?, ?)""",
                (workspace_id, result.patient_id, now, result.model_dump_json()),
            )
            db.execute(
                """INSERT INTO patient_activity(
                     workspace_id, patient_id, last_consultation, consultation_count
                   ) VALUES (?, ?, ?, 1) ON CONFLICT(workspace_id, patient_id) DO UPDATE SET
                   last_consultation=excluded.last_consultation,
                   consultation_count=patient_activity.consultation_count+1""",
                (workspace_id, result.patient_id, now),
            )
            return int(cursor.lastrowid)

    def activity(self, workspace_id: str, patient_ids: list[str]) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM patient_activity WHERE workspace_id=?", (workspace_id,)
            ).fetchall()
            consultations = db.execute(
                "SELECT id, patient_id, completed_at, result_json "
                "FROM consultations WHERE workspace_id=? ORDER BY id DESC",
                (workspace_id,),
            ).fetchall()
        records = {
            row["patient_id"]: {
                "patient_id": row["patient_id"],
                "last_opened": row["last_opened"],
                "last_started": row["last_started"],
            }
            for row in rows
        }
        consultation_counts: dict[str, int] = {}
        latest: dict[str, sqlite3.Row] = {}
        for consultation in consultations:
            patient_id = consultation["patient_id"]
            consultation_counts[patient_id] = consultation_counts.get(patient_id, 0) + 1
            latest.setdefault(patient_id, consultation)

        def projected(patient_id: str) -> dict:
            activity = records.get(
                patient_id,
                {"patient_id": patient_id, "last_opened": None, "last_started": None},
            )
            latest_record = latest.get(patient_id)
            result = json.loads(latest_record["result_json"]) if latest_record else None
            recommended = result["recommended_physician"] if result else None
            latest_at = latest_record["completed_at"] if latest_record else None
            return {
                **activity,
                "last_consultation": latest_at,
                "consultation_count": consultation_counts.get(patient_id, 0),
                "has_consultation": latest_record is not None,
                "latest_consultation_id": latest_record["id"] if latest_record else None,
                "latest_consulted_at": latest_at,
                "latest_recommended_physician": (
                    recommended["physician_name"] if recommended else None
                ),
                "latest_recommended_specialty": (
                    recommended["specialty"] if recommended else None
                ),
            }

        return [
            projected(patient_id)
            for patient_id in patient_ids
        ]

    def reset_demo_case(self, workspace_id: str, patient_id: str) -> dict:
        """Remove one demo case's Lamina workflow history, never its clinical source."""
        with self._connect() as db:
            record_ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM consultations WHERE workspace_id=? AND patient_id=?",
                    (workspace_id, patient_id),
                ).fetchall()
            ]
            removed = db.execute(
                "SELECT COUNT(*) FROM consultations WHERE workspace_id=? AND patient_id=?",
                (workspace_id, patient_id),
            ).fetchone()[0]
            db.execute(
                "DELETE FROM consultations WHERE workspace_id=? AND patient_id=?",
                (workspace_id, patient_id),
            )
            for record_id in record_ids:
                db.execute(
                    "DELETE FROM specialist_case_reviews "
                    "WHERE workspace_id=? AND consultation_record_id=?",
                    (workspace_id, record_id),
                )
                db.execute(
                    "DELETE FROM specialist_calibrations "
                    "WHERE workspace_id=? AND consultation_record_id=?",
                    (workspace_id, record_id),
                )
            db.execute(
                """UPDATE patient_activity SET last_started=NULL,
                   last_consultation=NULL, consultation_count=0
                   WHERE workspace_id=? AND patient_id=?""",
                (workspace_id, patient_id),
            )
            remaining = db.execute(
                "SELECT COUNT(*) FROM consultations WHERE workspace_id=?", (workspace_id,)
            ).fetchone()[0]
        return {
            "patient_id": patient_id,
            "removed_consultations": removed,
            "remaining_consultations": remaining,
            "reset_complete": True,
        }

    def history(self, workspace_id: str, limit: int = 30) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM consultations WHERE workspace_id=?
                   ORDER BY id DESC LIMIT ?""",
                (workspace_id, limit),
            ).fetchall()
        return [
            {"id": row["id"], "patient_id": row["patient_id"],
             "completed_at": row["completed_at"],
             "result": json.loads(row["result_json"])}
            for row in rows
        ]

    def consultation(self, workspace_id: str, record_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM consultations WHERE workspace_id=? AND id=?",
                (workspace_id, record_id),
            ).fetchone()
        return (
            {"id": row["id"], "patient_id": row["patient_id"],
             "completed_at": row["completed_at"], "result": json.loads(row["result_json"])}
            if row else None
        )

    def specialist_reviews(self, workspace_id: str, specialist_npi: str) -> dict[int, str]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT consultation_record_id, reviewed_at
                   FROM specialist_case_reviews
                   WHERE workspace_id=? AND specialist_npi=?""",
                (workspace_id, specialist_npi),
            ).fetchall()
        return {int(row["consultation_record_id"]): row["reviewed_at"] for row in rows}

    def mark_specialist_case_reviewed(
        self, workspace_id: str, consultation_record_id: int, specialist_npi: str
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO specialist_case_reviews(
                     workspace_id, consultation_record_id, specialist_npi, reviewed_at
                   ) VALUES (?, ?, ?, ?)
                   ON CONFLICT(workspace_id, consultation_record_id, specialist_npi)
                   DO UPDATE SET reviewed_at=excluded.reviewed_at""",
                (workspace_id, consultation_record_id, specialist_npi, now),
            )
        return {"reviewed": True, "reviewed_at": now}

    def specialist_calibrations(
        self, workspace_id: str, specialist_npi: str
    ) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT learning_key, consultation_record_id, statement, provenance,
                          status, created_at, updated_at
                   FROM specialist_calibrations
                   WHERE workspace_id=? AND specialist_npi=?
                   ORDER BY updated_at, learning_key""",
                (workspace_id, specialist_npi),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_specialist_calibration(
        self,
        workspace_id: str,
        specialist_npi: str,
        consultation_record_id: int,
        learning_key: str,
        statement: str,
        status: str,
    ) -> dict:
        provenance = (
            "Specialist-confirmed synthetic demo learning"
            if status == "confirmed"
            else "Specialist-edited synthetic demo draft"
            if status == "suggested"
            else "Specialist-rejected synthetic demo suggestion"
        )
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO specialist_calibrations(
                     workspace_id, specialist_npi, learning_key,
                     consultation_record_id, statement, provenance, status,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(
                     workspace_id, specialist_npi, learning_key, consultation_record_id
                   ) DO UPDATE SET statement=excluded.statement,
                     provenance=excluded.provenance, status=excluded.status,
                     updated_at=excluded.updated_at""",
                (
                    workspace_id,
                    specialist_npi,
                    learning_key,
                    consultation_record_id,
                    statement,
                    provenance,
                    status,
                    now,
                    now,
                ),
            )
            row = db.execute(
                """SELECT learning_key, consultation_record_id, statement, provenance,
                          status, created_at, updated_at
                   FROM specialist_calibrations
                   WHERE workspace_id=? AND specialist_npi=? AND learning_key=?
                     AND consultation_record_id=?""",
                (workspace_id, specialist_npi, learning_key, consultation_record_id),
            ).fetchone()
        return dict(row)

    def profile_items(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT item_id AS id, category, title, detail, provenance,
                          shareable, created_at, updated_at
                   FROM physician_profile_items
                   WHERE workspace_id=? AND persona_id=? ORDER BY created_at, item_id""",
                (workspace_id, persona_id),
            ).fetchall()
        return [{**dict(row), "shareable": bool(row["shareable"])} for row in rows]

    def upsert_profile_item(
        self,
        workspace_id: str,
        persona_id: str,
        item_id: str,
        category: str,
        title: str,
        detail: str | None,
        shareable: bool,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO physician_profile_items(
                     workspace_id, persona_id, item_id, category, title, detail,
                     provenance, shareable, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'physician_entered', ?, ?, ?)
                   ON CONFLICT(workspace_id, persona_id, item_id) DO UPDATE SET
                     category=excluded.category, title=excluded.title,
                     detail=excluded.detail, provenance='physician_entered',
                     shareable=excluded.shareable, updated_at=excluded.updated_at""",
                (
                    workspace_id,
                    persona_id,
                    item_id,
                    category,
                    title,
                    detail,
                    int(shareable),
                    now,
                    now,
                ),
            )
            row = db.execute(
                """SELECT item_id AS id, category, title, detail, provenance,
                          shareable, created_at, updated_at
                   FROM physician_profile_items
                   WHERE workspace_id=? AND persona_id=? AND item_id=?""",
                (workspace_id, persona_id, item_id),
            ).fetchone()
        return {**dict(row), "shareable": bool(row["shareable"])}

    def start_training_session(self, workspace_id: str, persona_id: str) -> dict:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO training_sessions(
                     workspace_id, persona_id, status, created_at
                   ) VALUES (?, ?, 'active', ?)""",
                (workspace_id, persona_id, now),
            )
            session_id = int(cursor.lastrowid)
        return {
            "id": session_id,
            "persona_id": persona_id,
            "status": "active",
            "created_at": now,
            "completed_at": None,
        }

    def training_session(
        self, workspace_id: str, persona_id: str, session_id: int
    ) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, persona_id, status, created_at, completed_at
                   FROM training_sessions
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, session_id),
            ).fetchone()
        return dict(row) if row else None

    def training_sessions(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id, persona_id, status, created_at, completed_at
                   FROM training_sessions WHERE workspace_id=? AND persona_id=?
                   ORDER BY id DESC""",
                (workspace_id, persona_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def save_training_response(
        self,
        workspace_id: str,
        persona_id: str,
        session_id: int,
        question_id: str,
        answer: str | list[str] | None,
        skipped: bool,
    ) -> dict:
        now = self._now()
        answer_json = json.dumps(answer) if answer is not None else None
        with self._connect() as db:
            db.execute(
                """INSERT INTO training_responses(
                     workspace_id, session_id, persona_id, question_id,
                     answer_json, skipped, answered_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(workspace_id, session_id, question_id) DO UPDATE SET
                     answer_json=excluded.answer_json, skipped=excluded.skipped,
                     answered_at=excluded.answered_at""",
                (
                    workspace_id,
                    session_id,
                    persona_id,
                    question_id,
                    answer_json,
                    int(skipped),
                    now,
                ),
            )
        return {
            "session_id": session_id,
            "question_id": question_id,
            "answer": answer,
            "skipped": skipped,
            "answered_at": now,
        }

    def training_responses(
        self, workspace_id: str, persona_id: str, session_id: int | None = None
    ) -> list[dict]:
        query = (
            """SELECT session_id, question_id, answer_json, skipped, answered_at
               FROM training_responses WHERE workspace_id=? AND persona_id=?"""
        )
        parameters: tuple = (workspace_id, persona_id)
        if session_id is not None:
            query += " AND session_id=?"
            parameters += (session_id,)
        query += " ORDER BY answered_at, session_id, question_id"
        with self._connect() as db:
            rows = db.execute(query, parameters).fetchall()
        return [
            {
                "session_id": row["session_id"],
                "question_id": row["question_id"],
                "answer": json.loads(row["answer_json"]) if row["answer_json"] else None,
                "skipped": bool(row["skipped"]),
                "answered_at": row["answered_at"],
            }
            for row in rows
        ]

    def complete_training_session(
        self, workspace_id: str, persona_id: str, session_id: int
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE training_sessions SET status='completed', completed_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=? AND status='active'""",
                (now, workspace_id, persona_id, session_id),
            ).rowcount
        if not updated:
            return self.training_session(workspace_id, persona_id, session_id)
        return self.training_session(workspace_id, persona_id, session_id)

    def proposed_learnings(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id, persona_id, source_type, source_reference, statement,
                          provenance, status, created_at, updated_at
                   FROM proposed_agent_learnings
                   WHERE workspace_id=? AND persona_id=? ORDER BY id DESC""",
                (workspace_id, persona_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_proposed_learning(
        self,
        workspace_id: str,
        persona_id: str,
        source_type: str,
        source_reference: str,
        statement: str,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO proposed_agent_learnings(
                     workspace_id, persona_id, source_type, source_reference,
                     statement, provenance, status, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?,
                     'Proposed from physician training response · not confirmed',
                     'suggested', ?, ?)
                   ON CONFLICT(workspace_id, persona_id, source_type, source_reference)
                   DO NOTHING""",
                (
                    workspace_id,
                    persona_id,
                    source_type,
                    source_reference,
                    statement,
                    now,
                    now,
                ),
            )
            row = db.execute(
                """SELECT id, persona_id, source_type, source_reference, statement,
                          provenance, status, created_at, updated_at
                   FROM proposed_agent_learnings
                   WHERE workspace_id=? AND persona_id=? AND source_type=?
                     AND source_reference=?""",
                (workspace_id, persona_id, source_type, source_reference),
            ).fetchone()
        return dict(row)

    def update_proposed_learning(
        self,
        workspace_id: str,
        persona_id: str,
        learning_id: int,
        statement: str,
        status: str,
    ) -> dict | None:
        provenance = (
            "Physician-confirmed training learning"
            if status == "confirmed"
            else "Physician-edited training draft"
            if status == "suggested"
            else "Physician-rejected training suggestion"
        )
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE proposed_agent_learnings
                   SET statement=?, provenance=?, status=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (
                    statement,
                    provenance,
                    status,
                    now,
                    workspace_id,
                    persona_id,
                    learning_id,
                ),
            ).rowcount
            row = db.execute(
                """SELECT id, persona_id, source_type, source_reference, statement,
                          provenance, status, created_at, updated_at
                   FROM proposed_agent_learnings
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, learning_id),
            ).fetchone()
        return dict(row) if updated and row else None

    def create_practice_update(
        self,
        workspace_id: str,
        persona_id: str,
        update_type: str,
        title: str,
        body: str,
        provenance: str,
        agent_drafted: bool = False,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO practice_updates(
                     workspace_id, persona_id, update_type, title, body, provenance,
                     status, agent_drafted, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)""",
                (
                    workspace_id,
                    persona_id,
                    update_type,
                    title,
                    body,
                    provenance,
                    int(agent_drafted),
                    now,
                    now,
                ),
            )
            update_id = int(cursor.lastrowid)
        return self.practice_update(workspace_id, persona_id, update_id)

    def practice_update(
        self, workspace_id: str, persona_id: str, update_id: int
    ) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, persona_id, update_type AS type, title, body,
                          provenance, status, agent_drafted, created_at,
                          updated_at, published_at
                   FROM practice_updates
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, update_id),
            ).fetchone()
        return (
            {**dict(row), "agent_drafted": bool(row["agent_drafted"])} if row else None
        )

    def practice_updates(
        self,
        workspace_id: str,
        persona_id: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        query = (
            """SELECT id, persona_id, update_type AS type, title, body,
                      provenance, status, agent_drafted, created_at,
                      updated_at, published_at
               FROM practice_updates WHERE workspace_id=?"""
        )
        parameters: tuple = (workspace_id,)
        if persona_id is not None:
            query += " AND persona_id=?"
            parameters += (persona_id,)
        if status is not None:
            query += " AND status=?"
            parameters += (status,)
        query += " ORDER BY COALESCE(published_at, updated_at) DESC, id DESC"
        with self._connect() as db:
            rows = db.execute(query, parameters).fetchall()
        return [{**dict(row), "agent_drafted": bool(row["agent_drafted"])} for row in rows]

    def edit_practice_update(
        self,
        workspace_id: str,
        persona_id: str,
        update_id: int,
        update_type: str,
        title: str,
        body: str,
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE practice_updates SET update_type=?, title=?, body=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=? AND status='draft'""",
                (update_type, title, body, now, workspace_id, persona_id, update_id),
            ).rowcount
        return self.practice_update(workspace_id, persona_id, update_id) if updated else None

    def set_practice_update_status(
        self, workspace_id: str, persona_id: str, update_id: int, status: str
    ) -> dict | None:
        now = self._now()
        published_at = now if status == "published" else None
        with self._connect() as db:
            updated = db.execute(
                """UPDATE practice_updates
                   SET status=?,
                     published_at=CASE WHEN ?='published' THEN ? ELSE published_at END,
                     updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (
                    status,
                    status,
                    published_at,
                    now,
                    workspace_id,
                    persona_id,
                    update_id,
                ),
            ).rowcount
        return self.practice_update(workspace_id, persona_id, update_id) if updated else None

    def network_members(self, workspace_id: str) -> list[dict]:
        """Physician relationships the clinician recorded, oldest first.

        Membership is a workspace relationship only. It is deliberately separate
        from physician-agent activation state and never mutates directory identity.
        """
        with self._connect() as db:
            rows = db.execute(
                """SELECT npi, added_at FROM network_members WHERE workspace_id=?
                   ORDER BY added_at, npi""",
                (workspace_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def add_network_member(self, workspace_id: str, npi: str) -> dict:
        """Idempotent: re-adding an existing relationship keeps the original date."""
        with self._connect() as db:
            db.execute(
                """INSERT INTO network_members(workspace_id, npi, added_at)
                   VALUES (?, ?, ?) ON CONFLICT(workspace_id, npi) DO NOTHING""",
                (workspace_id, npi, self._now()),
            )
            row = db.execute(
                """SELECT npi, added_at FROM network_members
                   WHERE workspace_id=? AND npi=?""",
                (workspace_id, npi),
            ).fetchone()
        return dict(row)

    def remove_network_member(self, workspace_id: str, npi: str) -> bool:
        with self._connect() as db:
            return db.execute(
                "DELETE FROM network_members WHERE workspace_id=? AND npi=?",
                (workspace_id, npi),
            ).rowcount > 0

    @staticmethod
    def _claim_dict(row: sqlite3.Row | None) -> dict | None:
        return dict(row) if row else None

    def active_provider_claim(self, npi: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT * FROM provider_claims WHERE npi=?
                   AND status IN ('claimed', 'verification_pending', 'verified')
                   ORDER BY id DESC LIMIT 1""",
                (npi,),
            ).fetchone()
        return self._claim_dict(row)

    def provider_claim(self, claim_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM provider_claims WHERE id=?", (claim_id,)).fetchone()
        return self._claim_dict(row)

    def provider_claims(self, auth_user_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM provider_claims WHERE auth_user_id=? ORDER BY claimed_at, id",
                (auth_user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def claim_provider(self, auth_user_id: str, npi: str) -> tuple[dict, bool]:
        """Create one active claim per NPI, returning (claim, conflict)."""
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                """SELECT * FROM provider_claims WHERE npi=?
                   AND status IN ('claimed', 'verification_pending', 'verified')
                   ORDER BY id DESC LIMIT 1""",
                (npi,),
            ).fetchone()
            if existing:
                return dict(existing), existing["auth_user_id"] != auth_user_id
            cursor = db.execute(
                """INSERT INTO provider_claims(
                     auth_user_id, npi, status, claimed_at, updated_at
                   ) VALUES (?, ?, 'claimed', ?, ?)""",
                (auth_user_id, npi, now, now),
            )
            row = db.execute(
                "SELECT * FROM provider_claims WHERE id=?", (cursor.lastrowid,)
            ).fetchone()
        return dict(row), False

    def submit_provider_verification(self, claim_id: int, auth_user_id: str) -> dict | None:
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM provider_claims WHERE id=? AND auth_user_id=?",
                (claim_id, auth_user_id),
            ).fetchone()
            if not row:
                return None
            if row["status"] == "claimed":
                db.execute(
                    """UPDATE provider_claims SET status='verification_pending',
                       verification_submitted_at=?, updated_at=? WHERE id=?""",
                    (now, now, claim_id),
                )
            elif row["status"] not in {"verification_pending", "verified"}:
                raise ValueError("This claim cannot be submitted for verification")
            updated = db.execute(
                "SELECT * FROM provider_claims WHERE id=?", (claim_id,)
            ).fetchone()
        return dict(updated)

    def verify_provider_claim(
        self,
        claim_id: int,
        auth_user_id: str,
        verification_method: str,
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM provider_claims WHERE id=? AND auth_user_id=?",
                (claim_id, auth_user_id),
            ).fetchone()
            if not row:
                return None
            if row["status"] == "verification_pending":
                db.execute(
                    """UPDATE provider_claims SET status='verified', verified_at=?,
                       verification_method=?, updated_at=? WHERE id=?""",
                    (now, verification_method, now, claim_id),
                )
            elif not (
                row["status"] == "verified"
                and row["verification_method"] == verification_method
            ):
                raise ValueError("This claim is not awaiting verification")
            updated = db.execute(
                "SELECT * FROM provider_claims WHERE id=?", (claim_id,)
            ).fetchone()
        return dict(updated)

    def provider_agent_state(self, npi: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM provider_agent_state WHERE npi=?", (npi,)).fetchone()
        if not row:
            return None
        state = dict(row)
        state["practice_confirmed"] = bool(state["practice_confirmed"])
        state["preferences"] = (
            json.loads(state.pop("preferences_json"))
            if state.get("preferences_json") else None
        )
        return state

    def save_provider_agent_preferences(
        self,
        npi: str,
        practice_confirmed: bool,
        preferences: dict,
    ) -> dict:
        now = self._now()
        payload = json.dumps(preferences, separators=(",", ":"), sort_keys=True)
        with self._connect() as db:
            db.execute(
                """INSERT INTO provider_agent_state(
                     npi, status, practice_confirmed, preferences_json, updated_at
                   ) VALUES (?, 'inactive', ?, ?, ?)
                   ON CONFLICT(npi) DO UPDATE SET
                     practice_confirmed=excluded.practice_confirmed,
                     preferences_json=excluded.preferences_json,
                     updated_at=excluded.updated_at""",
                (npi, int(practice_confirmed), payload, now),
            )
        return self.provider_agent_state(npi)

    def activate_provider_agent(self, npi: str) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO provider_agent_state(npi, status, activated_at, updated_at)
                   VALUES (?, 'active', ?, ?)
                   ON CONFLICT(npi) DO UPDATE SET status='active',
                     activated_at=COALESCE(provider_agent_state.activated_at, excluded.activated_at),
                     updated_at=excluded.updated_at""",
                (npi, now, now),
            )
        return self.provider_agent_state(npi)

    def disable_provider_agent(self, npi: str) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """UPDATE provider_agent_state SET status='disabled', disabled_at=?, updated_at=?
                   WHERE npi=?""",
                (now, now, npi),
            )
        return self.provider_agent_state(npi)

    def preferences(self, workspace_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT key, statement, provenance, status, updated_at
                   FROM agent_preferences WHERE workspace_id=? ORDER BY key""",
                (workspace_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_preference(
        self, workspace_id: str, key: str, statement: str, status: str
    ) -> dict:
        provenance = "Physician-confirmed demo preference" if status == "confirmed" else (
            "Physician-edited draft" if status == "suggested" else "Rejected suggestion"
        )
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO agent_preferences(
                     workspace_id,key,statement,provenance,status,updated_at
                   ) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET
                   statement=excluded.statement, provenance=excluded.provenance,
                   status=excluded.status, updated_at=excluded.updated_at""",
                (workspace_id, key, statement, provenance, status, now),
            )
        return {"key": key, "statement": statement, "provenance": provenance,
                "status": status, "updated_at": now}


workflow_store = WorkflowStore()
