"""Small Lamina-owned demo workflow record, separate from clinical FHIR data."""

from __future__ import annotations

import json
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from backend.config import environment
from backend.models import ConsultationResult

# A believable starting roster for a brand-new workspace, so Network -> Colleagues
# never opens empty (see WorkflowStore.network_members). Deliberately drawn only from
# the network-only expansion physicians -- never a consult-engine participant
# (physician-jung, -onadeko, -sanchez, etc.) or an engagement persona (iain, onadeko,
# sofia) -- so existing consult/engagement tests that build up membership or feed
# visibility from a clean slate are unaffected by this baseline. The rest of the
# controlled population is discoverable via search/add or through consultations.
_DEFAULT_NETWORK_MEMBER_NPIS = (
    "9900000011",  # Dr. Lianne Cha -- Primary Care
    "9900000018",  # Dr. Josh Miller -- Rheumatology
    "9900000013",  # Dr. Noah Islam -- Pulmonology
    "9900000023",  # Dr. Maya Ramanathan -- Endocrinology
    "9900000024",  # Dr. Nina Park -- Obstetrics & Gynecology
    "9900000028",  # Dr. Natalie Rosen -- Hematology/Oncology
    "9900000016",  # Dr. Chris Mithel -- Dermatology
    "9900000021",  # Dr. Carson Murtuza-Lanier -- Psychiatry
    "9900000015",  # Dr. Hamidou Guechtouli -- Infectious Disease
    "9900000022",  # Dr. Dan Nakajima -- Pulmonology (Sleep medicine)
    "9900000027",  # Dr. Amina Rahman -- Pulmonology
)


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
                CREATE TABLE IF NOT EXISTS demo_workspace_bootstraps (
                  bootstrap_hash TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  FOREIGN KEY(workspace_id) REFERENCES demo_workspaces(workspace_id)
                    ON DELETE CASCADE
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
                CREATE TABLE IF NOT EXISTS network_seed_state (
                  workspace_id TEXT NOT NULL PRIMARY KEY, seeded_at TEXT NOT NULL
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
                  completed_at TEXT,
                  mode TEXT NOT NULL DEFAULT 'daily',
                  question_limit INTEGER NOT NULL DEFAULT 10,
                  answer_target INTEGER,
                  lifecycle_state TEXT NOT NULL DEFAULT 'active',
                  questions_complete_at TEXT,
                  review_completed_at TEXT,
                  review_deferred INTEGER NOT NULL DEFAULT 0,
                  focused_seed_id TEXT
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
                  review_action TEXT,
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
                CREATE TABLE IF NOT EXISTS physician_interests (
                  workspace_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                  interest_id TEXT NOT NULL, interest_type TEXT NOT NULL,
                  title TEXT NOT NULL, detail TEXT, provenance TEXT NOT NULL,
                  confirmed INTEGER NOT NULL DEFAULT 1,
                  shareable INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, persona_id, interest_id)
                );
                CREATE TABLE IF NOT EXISTS training_session_questions (
                  workspace_id TEXT NOT NULL, session_id INTEGER NOT NULL,
                  persona_id TEXT NOT NULL, question_id TEXT NOT NULL,
                  root_question_id TEXT NOT NULL, parent_question_id TEXT,
                  branch_depth INTEGER NOT NULL DEFAULT 0,
                  branch_path_json TEXT NOT NULL DEFAULT '[]',
                  triggering_answer TEXT, priority INTEGER NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'assigned', created_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, session_id, question_id)
                );
                CREATE TABLE IF NOT EXISTS generated_training_questions (
                  workspace_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                  session_id INTEGER NOT NULL, question_id TEXT NOT NULL,
                  question_json TEXT NOT NULL, provider TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, persona_id, question_id)
                );
                CREATE TABLE IF NOT EXISTS deferred_training_questions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  workspace_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                  source_session_id INTEGER NOT NULL, question_id TEXT NOT NULL,
                  question_json TEXT NOT NULL, provider TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'pending',
                  consumed_session_id INTEGER, created_at TEXT NOT NULL,
                  UNIQUE(workspace_id, persona_id, question_id, status)
                );
                CREATE TABLE IF NOT EXISTS physician_agent_initialization (
                  workspace_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                  initialized_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  PRIMARY KEY(workspace_id, persona_id)
                );
                CREATE TABLE IF NOT EXISTS agent_chat_responses (
                  response_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL, mode TEXT NOT NULL,
                  test_case_id TEXT, request_json TEXT NOT NULL,
                  response_json TEXT NOT NULL, provider TEXT NOT NULL,
                  feedback TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS focused_training_seeds (
                  seed_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL, chat_response_id TEXT NOT NULL,
                  question_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                  started_session_id INTEGER, created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS profile_enrichment_jobs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  workspace_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                  status TEXT NOT NULL, provider TEXT NOT NULL,
                  found_count INTEGER NOT NULL DEFAULT 0, message TEXT,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS profile_candidate_facts (
                  candidate_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL, job_id INTEGER NOT NULL,
                  category TEXT NOT NULL, proposed_title TEXT NOT NULL,
                  proposed_detail TEXT, source_type TEXT NOT NULL,
                  source_title TEXT NOT NULL, source_url TEXT,
                  retrieved_at TEXT NOT NULL,
                  model_generated_summary INTEGER NOT NULL DEFAULT 0,
                  confidence TEXT, review_status TEXT NOT NULL,
                  reviewed_at TEXT,
                  PRIMARY KEY(workspace_id, persona_id, candidate_id)
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
                CREATE TABLE IF NOT EXISTS physician_owner_scopes (
                  id TEXT PRIMARY KEY,
                  provider_claim_id INTEGER NOT NULL UNIQUE,
                  auth_user_id TEXT NOT NULL,
                  npi TEXT NOT NULL,
                  storage_scope_id TEXT NOT NULL UNIQUE,
                  physician_id TEXT NOT NULL UNIQUE,
                  provider_identity_json TEXT NOT NULL,
                  publication_status TEXT NOT NULL DEFAULT 'private'
                    CHECK(publication_status IN ('private', 'published', 'unpublished')),
                  clinical_access INTEGER NOT NULL DEFAULT 0,
                  selected INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  FOREIGN KEY(provider_claim_id) REFERENCES provider_claims(id)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS physician_owner_scopes_selected_user
                  ON physician_owner_scopes(auth_user_id) WHERE selected=1;
                CREATE INDEX IF NOT EXISTS physician_owner_scopes_user
                  ON physician_owner_scopes(auth_user_id, updated_at);
                CREATE INDEX IF NOT EXISTS physician_owner_scopes_npi
                  ON physician_owner_scopes(npi);
                """
            )
            self._migrate_demo_tables(db)
            self._migrate_engagement_tables(db)
            db.executescript(
                """
                CREATE INDEX IF NOT EXISTS consultations_workspace_id
                  ON consultations(workspace_id, id DESC);
                CREATE INDEX IF NOT EXISTS demo_workspaces_expiry
                  ON demo_workspaces(expires_at);
                CREATE INDEX IF NOT EXISTS demo_workspace_bootstraps_expiry
                  ON demo_workspace_bootstraps(expires_at);
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
                CREATE INDEX IF NOT EXISTS interests_workspace
                  ON physician_interests(workspace_id, persona_id);
                CREATE INDEX IF NOT EXISTS training_questions_workspace
                  ON training_session_questions(workspace_id, persona_id, session_id);
                CREATE INDEX IF NOT EXISTS generated_training_workspace
                  ON generated_training_questions(workspace_id, persona_id, session_id);
                CREATE INDEX IF NOT EXISTS deferred_training_workspace
                  ON deferred_training_questions(workspace_id, persona_id, status, id);
                CREATE INDEX IF NOT EXISTS agent_chat_workspace
                  ON agent_chat_responses(workspace_id, persona_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS focused_seed_workspace
                  ON focused_training_seeds(workspace_id, persona_id, status, created_at DESC);
                CREATE INDEX IF NOT EXISTS enrichment_jobs_workspace
                  ON profile_enrichment_jobs(workspace_id, persona_id, id DESC);
                CREATE INDEX IF NOT EXISTS candidate_facts_workspace
                  ON profile_candidate_facts(workspace_id, persona_id, job_id);
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

    def _migrate_engagement_tables(self, db: sqlite3.Connection) -> None:
        """Add Pass 5 engagement fields without replacing existing rows."""
        additions = {
            "training_sessions": {
                "mode": "TEXT NOT NULL DEFAULT 'daily'",
                "question_limit": "INTEGER NOT NULL DEFAULT 5",
                "answer_target": "INTEGER",
                "lifecycle_state": "TEXT NOT NULL DEFAULT 'active'",
                "questions_complete_at": "TEXT",
                "review_completed_at": "TEXT",
                "review_deferred": "INTEGER NOT NULL DEFAULT 0",
                "focused_seed_id": "TEXT",
            },
            "proposed_agent_learnings": {
                "review_action": "TEXT",
            },
            "practice_updates": {
                "post_type": "TEXT",
                "authored_by": "TEXT NOT NULL DEFAULT 'physician'",
                "drafted_by": "TEXT NOT NULL DEFAULT 'physician'",
                "physician_approved": "INTEGER NOT NULL DEFAULT 0",
                "visibility": "TEXT NOT NULL DEFAULT 'network'",
                "source_input_json": "TEXT",
                "synthetic_case": "INTEGER NOT NULL DEFAULT 0",
                "case_safety_label": "TEXT",
            },
        }
        for table, columns in additions.items():
            existing = self._columns(db, table)
            for column, definition in columns.items():
                if column not in existing:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        db.execute("UPDATE practice_updates SET post_type=update_type WHERE post_type IS NULL")
        db.execute(
            """UPDATE practice_updates SET drafted_by='lamina_agent'
               WHERE agent_drafted=1 AND drafted_by='physician'"""
        )
        db.execute("UPDATE practice_updates SET physician_approved=1 WHERE status='published'")
        db.execute(
            "UPDATE training_sessions SET answer_target=question_limit "
            "WHERE answer_target IS NULL"
        )
        db.execute(
            "UPDATE training_sessions SET lifecycle_state='questions_complete', "
            "questions_complete_at=completed_at "
            "WHERE status='completed' AND lifecycle_state='active'"
        )
        db.execute(
            "UPDATE proposed_agent_learnings SET review_action='confirm' "
            "WHERE review_action IS NULL AND status='confirmed'"
        )
        db.execute(
            "UPDATE proposed_agent_learnings SET review_action='reject' "
            "WHERE review_action IS NULL AND status='rejected'"
        )
        db.execute(
            "UPDATE proposed_agent_learnings SET review_action='edit' "
            "WHERE review_action IS NULL AND provenance='Physician-edited training draft'"
        )

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat(timespec="seconds")

    def resolve_demo_workspace(
        self,
        candidate: str | None,
        ttl_seconds: int,
        bootstrap_hash: str | None = None,
        bootstrap_ttl_seconds: int = 120,
    ) -> tuple[str, bool]:
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat(timespec="seconds")
        expires = (now_dt + timedelta(seconds=ttl_seconds)).isoformat(timespec="seconds")
        bootstrap_expires = (
            now_dt + timedelta(seconds=bootstrap_ttl_seconds)
        ).isoformat(timespec="seconds")
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
            elif bootstrap_hash:
                db.execute(
                    "DELETE FROM demo_workspace_bootstraps WHERE expires_at <= ?",
                    (now,),
                )
                row = db.execute(
                    """SELECT b.workspace_id, w.expires_at AS workspace_expires_at
                       FROM demo_workspace_bootstraps b
                       JOIN demo_workspaces w ON w.workspace_id=b.workspace_id
                       WHERE b.bootstrap_hash=? AND b.expires_at>?""",
                    (bootstrap_hash, now),
                ).fetchone()
                if row and row["workspace_expires_at"] > now:
                    db.execute(
                        "UPDATE demo_workspaces SET last_seen_at=?, expires_at=? "
                        "WHERE workspace_id=?",
                        (now, expires, row["workspace_id"]),
                    )
                    return str(row["workspace_id"]), False
                if row:
                    db.execute(
                        "DELETE FROM demo_workspace_bootstraps WHERE bootstrap_hash=?",
                        (bootstrap_hash,),
                    )
            while True:
                workspace_id = secrets.token_urlsafe(32)
                try:
                    db.execute(
                        """INSERT INTO demo_workspaces(
                             workspace_id, created_at, last_seen_at, expires_at
                           ) VALUES (?, ?, ?, ?)""",
                        (workspace_id, now, now, expires),
                    )
                except sqlite3.IntegrityError:
                    continue
                break
            if bootstrap_hash and not candidate:
                db.execute(
                    """INSERT INTO demo_workspace_bootstraps(
                         bootstrap_hash, workspace_id, created_at, expires_at
                       ) VALUES (?, ?, ?, ?)""",
                    (bootstrap_hash, workspace_id, now, bootstrap_expires),
                )
            return workspace_id, True

    def cleanup_expired_demo_workspaces(self) -> int:
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "DELETE FROM demo_workspace_bootstraps WHERE expires_at < ?", (now,)
            )
            rows = db.execute(
                "SELECT workspace_id FROM demo_workspaces WHERE expires_at < ? "
                "AND workspace_id <> ?",
                (now, self.LEGACY_WORKSPACE_ID),
            ).fetchall()
            workspace_ids = [row["workspace_id"] for row in rows]
            for workspace_id in workspace_ids:
                for table in (
                    "patient_activity",
                    "consultations",
                    "agent_preferences",
                    "network_members",
                    "specialist_case_reviews",
                    "specialist_calibrations",
                    "physician_profile_items",
                    "training_responses",
                    "training_sessions",
                    "training_session_questions",
                    "generated_training_questions",
                    "deferred_training_questions",
                    "physician_agent_initialization",
                    "agent_chat_responses",
                    "focused_training_seeds",
                    "proposed_agent_learnings",
                    "practice_updates",
                    "physician_interests",
                    "profile_candidate_facts",
                    "profile_enrichment_jobs",
                ):
                    db.execute(f"DELETE FROM {table} WHERE workspace_id=?", (workspace_id,))
                db.execute("DELETE FROM demo_workspaces WHERE workspace_id=?", (workspace_id,))
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
            {
                "id": row["id"],
                "patient_id": row["patient_id"],
                "completed_at": row["completed_at"],
                "result": json.loads(row["result_json"]),
            }
            for row in rows
        ]

    def consultation(self, workspace_id: str, record_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM consultations WHERE workspace_id=? AND id=?",
                (workspace_id, record_id),
            ).fetchone()
        return (
            {
                "id": row["id"],
                "patient_id": row["patient_id"],
                "completed_at": row["completed_at"],
                "result": json.loads(row["result_json"]),
            }
            if row
            else None
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
        provenance: str = "physician_entered",
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO physician_profile_items(
                     workspace_id, persona_id, item_id, category, title, detail,
                     provenance, shareable, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(workspace_id, persona_id, item_id) DO UPDATE SET
                     category=excluded.category, title=excluded.title,
                     detail=excluded.detail, provenance=excluded.provenance,
                     shareable=excluded.shareable, updated_at=excluded.updated_at""",
                (
                    workspace_id,
                    persona_id,
                    item_id,
                    category,
                    title,
                    detail,
                    provenance,
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

    def physician_interests(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT interest_id AS id, interest_type, title, detail,
                          provenance, confirmed, shareable, created_at, updated_at
                   FROM physician_interests
                   WHERE workspace_id=? AND persona_id=? ORDER BY created_at, interest_id""",
                (workspace_id, persona_id),
            ).fetchall()
        return [
            {
                **dict(row),
                "confirmed": bool(row["confirmed"]),
                "shareable": bool(row["shareable"]),
            }
            for row in rows
        ]

    def upsert_physician_interest(
        self,
        workspace_id: str,
        persona_id: str,
        interest_id: str,
        interest_type: str,
        title: str,
        detail: str | None,
        confirmed: bool,
        shareable: bool,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO physician_interests(
                     workspace_id, persona_id, interest_id, interest_type, title,
                     detail, provenance, confirmed, shareable, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'physician_entered', ?, ?, ?, ?)
                   ON CONFLICT(workspace_id, persona_id, interest_id) DO UPDATE SET
                     interest_type=excluded.interest_type, title=excluded.title,
                     detail=excluded.detail, provenance='physician_entered',
                     confirmed=excluded.confirmed, shareable=excluded.shareable,
                     updated_at=excluded.updated_at""",
                (
                    workspace_id,
                    persona_id,
                    interest_id,
                    interest_type,
                    title,
                    detail,
                    int(confirmed),
                    int(shareable),
                    now,
                    now,
                ),
            )
        return next(
            item
            for item in self.physician_interests(workspace_id, persona_id)
            if item["id"] == interest_id
        )

    def start_training_session(
        self,
        workspace_id: str,
        persona_id: str,
        mode: str = "daily",
        question_limit: int = 10,
        *,
        focused_seed_id: str | None = None,
        track: str = "standard",
    ) -> dict:
        """`track` ("quick" or "standard") scopes the one-active-session-per-persona
        invariant to sessions of the same track, so the Dashboard's quick-training
        burst and the full My Agent -> Train flow can each have their own active
        session without one silently reusing/blocking the other."""
        now = self._now()
        track_clause = "AND mode = 'quick'" if track == "quick" else "AND mode != 'quick'"
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                f"""SELECT id FROM training_sessions
                   WHERE workspace_id=? AND persona_id=? AND status='active'
                     AND lifecycle_state='active' {track_clause}
                   ORDER BY id DESC LIMIT 1""",
                (workspace_id, persona_id),
            ).fetchone()
            if existing:
                session_id = int(existing["id"])
                db.commit()
                session = self.training_session(workspace_id, persona_id, session_id)
                assert session is not None
                return session
            cursor = db.execute(
                """INSERT INTO training_sessions(
                     workspace_id, persona_id, status, created_at, mode, question_limit,
                     answer_target, lifecycle_state, focused_seed_id
                   ) VALUES (?, ?, 'active', ?, ?, ?, ?, 'active', ?)""",
                (
                    workspace_id,
                    persona_id,
                    now,
                    mode,
                    question_limit,
                    question_limit,
                    focused_seed_id,
                ),
            )
            session_id = int(cursor.lastrowid)
        return {
            "id": session_id,
            "persona_id": persona_id,
            "status": "active",
            "created_at": now,
            "completed_at": None,
            "mode": mode,
            "question_limit": question_limit,
            "answer_target": question_limit,
            "lifecycle_state": "active",
            "questions_complete_at": None,
            "review_completed_at": None,
            "review_deferred": False,
            "focused_seed_id": focused_seed_id,
        }

    def training_session(self, workspace_id: str, persona_id: str, session_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, persona_id, status, created_at, completed_at,
                          mode, question_limit, answer_target, lifecycle_state,
                          questions_complete_at, review_completed_at,
                          review_deferred, focused_seed_id
                   FROM training_sessions
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, session_id),
            ).fetchone()
        if not row:
            return None
        return {**dict(row), "review_deferred": bool(row["review_deferred"])}

    def training_sessions(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id, persona_id, status, created_at, completed_at,
                          mode, question_limit, answer_target, lifecycle_state,
                          questions_complete_at, review_completed_at,
                          review_deferred, focused_seed_id
                   FROM training_sessions WHERE workspace_id=? AND persona_id=?
                   ORDER BY id DESC""",
                (workspace_id, persona_id),
            ).fetchall()
        return [{**dict(row), "review_deferred": bool(row["review_deferred"])} for row in rows]

    def normalize_unstarted_training_session(
        self,
        workspace_id: str,
        persona_id: str,
        session_id: int,
        answer_target: int = 10,
    ) -> dict | None:
        """Normalize a zero-response legacy session without discarding physician work."""
        with self._connect() as db:
            response_count = db.execute(
                """SELECT COUNT(*) FROM training_responses
                   WHERE workspace_id=? AND persona_id=? AND session_id=?""",
                (workspace_id, persona_id, session_id),
            ).fetchone()[0]
            if response_count == 0:
                db.execute(
                    """UPDATE training_sessions
                       SET question_limit=?, answer_target=?
                       WHERE workspace_id=? AND persona_id=? AND id=?
                         AND status='active' AND mode!='focused'""",
                    (answer_target, answer_target, workspace_id, persona_id, session_id),
                )
        return self.training_session(workspace_id, persona_id, session_id)

    def abandon_training_session(
        self, workspace_id: str, persona_id: str, session_id: int
    ) -> dict | None:
        """Archive an unusable/duplicate active session while retaining its audit rows."""
        now = self._now()
        with self._connect() as db:
            db.execute(
                """UPDATE training_sessions
                   SET status='completed', lifecycle_state='abandoned',
                       completed_at=COALESCE(completed_at, ?)
                   WHERE workspace_id=? AND persona_id=? AND id=? AND status='active'""",
                (now, workspace_id, persona_id, session_id),
            )
        return self.training_session(workspace_id, persona_id, session_id)

    def assign_training_question(
        self,
        workspace_id: str,
        persona_id: str,
        session_id: int,
        question: dict,
        priority: int,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT OR IGNORE INTO training_session_questions(
                     workspace_id, session_id, persona_id, question_id,
                     root_question_id, parent_question_id, branch_depth,
                     branch_path_json, triggering_answer, priority, status, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?)""",
                (
                    workspace_id,
                    session_id,
                    persona_id,
                    question["id"],
                    question.get("root_question_id", question["id"]),
                    question.get("parent_question_id"),
                    question.get("branch_depth", 0),
                    json.dumps(question.get("branch_path", [])),
                    question.get("branch_condition"),
                    priority,
                    now,
                ),
            )
        return next(
            item
            for item in self.training_session_questions(workspace_id, persona_id, session_id)
            if item["question_id"] == question["id"]
        )

    def training_session_questions(
        self, workspace_id: str, persona_id: str, session_id: int
    ) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT question_id, root_question_id, parent_question_id,
                          branch_depth, branch_path_json, triggering_answer,
                          priority, status, created_at
                   FROM training_session_questions
                   WHERE workspace_id=? AND persona_id=? AND session_id=?
                   ORDER BY priority DESC, created_at, question_id""",
                (workspace_id, persona_id, session_id),
            ).fetchall()
        return [
            {
                **dict(row),
                "branch_path": json.loads(row["branch_path_json"]),
            }
            for row in rows
        ]

    def save_generated_training_question(
        self,
        workspace_id: str,
        persona_id: str,
        session_id: int,
        question: dict,
        provider: str,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO generated_training_questions(
                     workspace_id, persona_id, session_id, question_id,
                     question_json, provider, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(workspace_id, persona_id, question_id) DO UPDATE SET
                     question_json=excluded.question_json,
                     provider=excluded.provider""",
                (
                    workspace_id,
                    persona_id,
                    session_id,
                    question["id"],
                    json.dumps(question),
                    provider,
                    now,
                ),
            )
        return {**question, "generation_provider": provider}

    def generated_training_question(
        self, workspace_id: str, persona_id: str, question_id: str
    ) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT question_json, provider
                   FROM generated_training_questions
                   WHERE workspace_id=? AND persona_id=? AND question_id=?""",
                (workspace_id, persona_id, question_id),
            ).fetchone()
        if not row:
            return None
        return {**json.loads(row["question_json"]), "generation_provider": row["provider"]}

    def defer_training_question(
        self,
        workspace_id: str,
        persona_id: str,
        source_session_id: int,
        question: dict,
        provider: str,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT OR IGNORE INTO deferred_training_questions(
                     workspace_id, persona_id, source_session_id, question_id,
                     question_json, provider, status, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (
                    workspace_id,
                    persona_id,
                    source_session_id,
                    question["id"],
                    json.dumps(question),
                    provider,
                    now,
                ),
            )
        return {**question, "generation_provider": provider, "deferred": True}

    def deferred_training_questions(
        self, workspace_id: str, persona_id: str, *, pending_only: bool = True
    ) -> list[dict]:
        status_clause = " AND status='pending'" if pending_only else ""
        with self._connect() as db:
            rows = db.execute(
                f"""SELECT id, source_session_id, question_id, question_json,
                          provider, status, consumed_session_id, created_at
                   FROM deferred_training_questions
                   WHERE workspace_id=? AND persona_id=?{status_clause}
                   ORDER BY id""",
                (workspace_id, persona_id),
            ).fetchall()
        return [
            {
                **json.loads(row["question_json"]),
                "deferred_id": row["id"],
                "source_session_id": row["source_session_id"],
                "generation_provider": row["provider"],
                "deferred": True,
            }
            for row in rows
        ]

    def consume_deferred_training_question(
        self,
        workspace_id: str,
        persona_id: str,
        deferred_id: int,
        session_id: int,
    ) -> None:
        with self._connect() as db:
            db.execute(
                """UPDATE deferred_training_questions
                   SET status='consumed', consumed_session_id=?
                   WHERE workspace_id=? AND persona_id=? AND id=? AND status='pending'""",
                (session_id, workspace_id, persona_id, deferred_id),
            )

    def initialization_state(self, workspace_id: str, persona_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT initialized_at, updated_at
                   FROM physician_agent_initialization
                   WHERE workspace_id=? AND persona_id=?""",
                (workspace_id, persona_id),
            ).fetchone()
        return dict(row) if row else None

    def mark_initialized(self, workspace_id: str, persona_id: str) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO physician_agent_initialization(
                     workspace_id, persona_id, initialized_at, updated_at
                   ) VALUES (?, ?, ?, ?)
                   ON CONFLICT(workspace_id, persona_id) DO UPDATE SET
                     updated_at=excluded.updated_at""",
                (workspace_id, persona_id, now, now),
            )
        state = self.initialization_state(workspace_id, persona_id)
        assert state is not None
        return state

    def reset_training(self, workspace_id: str, persona_id: str) -> dict[str, int]:
        """Reset only workspace-local training-derived state for one demo persona."""
        tables = (
            ("training_responses", "responses"),
            ("training_session_questions", "assignments"),
            ("generated_training_questions", "generated_questions"),
            ("deferred_training_questions", "deferred_questions"),
            ("training_sessions", "sessions"),
        )
        counts: dict[str, int] = {}
        with self._connect() as db:
            for table, key in tables:
                counts[key] = db.execute(
                    f"DELETE FROM {table} WHERE workspace_id=? AND persona_id=?",
                    (workspace_id, persona_id),
                ).rowcount
            counts["training_learnings"] = db.execute(
                """DELETE FROM proposed_agent_learnings
                   WHERE workspace_id=? AND persona_id=? AND source_type='training_response'""",
                (workspace_id, persona_id),
            ).rowcount
            counts["initialization"] = db.execute(
                "DELETE FROM physician_agent_initialization "
                "WHERE workspace_id=? AND persona_id=?",
                (workspace_id, persona_id),
            ).rowcount
            counts["focused_seeds"] = db.execute(
                "DELETE FROM focused_training_seeds "
                "WHERE workspace_id=? AND persona_id=?",
                (workspace_id, persona_id),
            ).rowcount
        return counts

    def save_agent_chat_response(
        self,
        workspace_id: str,
        persona_id: str,
        response_id: str,
        mode: str,
        test_case_id: str | None,
        request_payload: dict,
        response_payload: dict,
        provider: str,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO agent_chat_responses(
                     response_id, workspace_id, persona_id, mode, test_case_id,
                     request_json, response_json, provider, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    response_id,
                    workspace_id,
                    persona_id,
                    mode,
                    test_case_id,
                    json.dumps(request_payload),
                    json.dumps(response_payload),
                    provider,
                    now,
                    now,
                ),
            )
        return {**response_payload, "response_id": response_id, "provider": provider}

    def agent_chat_response(
        self, workspace_id: str, persona_id: str, response_id: str
    ) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT response_id, mode, test_case_id, request_json,
                          response_json, provider, feedback, created_at
                   FROM agent_chat_responses
                   WHERE workspace_id=? AND persona_id=? AND response_id=?""",
                (workspace_id, persona_id, response_id),
            ).fetchone()
        if not row:
            return None
        return {
            **dict(row),
            "request": json.loads(row["request_json"]),
            "response": json.loads(row["response_json"]),
        }

    def set_agent_chat_feedback(
        self, workspace_id: str, persona_id: str, response_id: str, feedback: str
    ) -> None:
        with self._connect() as db:
            db.execute(
                """UPDATE agent_chat_responses SET feedback=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND response_id=?""",
                (feedback, self._now(), workspace_id, persona_id, response_id),
            )

    def create_focused_training_seed(
        self,
        workspace_id: str,
        persona_id: str,
        seed_id: str,
        chat_response_id: str,
        question: dict,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO focused_training_seeds(
                     seed_id, workspace_id, persona_id, chat_response_id,
                     question_json, status, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                (
                    seed_id,
                    workspace_id,
                    persona_id,
                    chat_response_id,
                    json.dumps(question),
                    now,
                    now,
                ),
            )
        return {
            "seed_id": seed_id,
            "chat_response_id": chat_response_id,
            "status": "pending",
            "question": question,
            "created_at": now,
        }

    def focused_training_seed(
        self, workspace_id: str, persona_id: str, seed_id: str
    ) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT seed_id, chat_response_id, question_json, status,
                          started_session_id, created_at
                   FROM focused_training_seeds
                   WHERE workspace_id=? AND persona_id=? AND seed_id=?""",
                (workspace_id, persona_id, seed_id),
            ).fetchone()
        if not row:
            return None
        return {**dict(row), "question": json.loads(row["question_json"])}

    def start_focused_training_seed(
        self, workspace_id: str, persona_id: str, seed_id: str, session_id: int
    ) -> None:
        with self._connect() as db:
            db.execute(
                """UPDATE focused_training_seeds
                   SET status='started', started_session_id=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND seed_id=?
                     AND status='pending'""",
                (session_id, self._now(), workspace_id, persona_id, seed_id),
            )

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
        query = """SELECT session_id, question_id, answer_json, skipped, answered_at
               FROM training_responses WHERE workspace_id=? AND persona_id=?"""
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

    def training_history(self, workspace_id: str, persona_id: str) -> list[dict]:
        sessions = self.training_sessions(workspace_id, persona_id)
        responses = self.training_responses(workspace_id, persona_id)
        learnings = self.proposed_learnings(workspace_id, persona_id)
        deferred = self.deferred_training_questions(
            workspace_id, persona_id, pending_only=False
        )
        entries: list[dict] = []
        for session in sessions:
            if session["lifecycle_state"] == "abandoned":
                continue
            session_id = session["id"]
            session_responses = [item for item in responses if item["session_id"] == session_id]
            prefix = f"session:{session_id}:"
            session_learnings = [
                item for item in learnings if item["source_reference"].startswith(prefix)
            ]
            entries.append(
                {
                    "session_id": session_id,
                    "mode": session["mode"],
                    "lifecycle_state": session["lifecycle_state"],
                    "started_at": session["created_at"],
                    "completed_at": session["completed_at"],
                    "answered_count": sum(not item["skipped"] for item in session_responses),
                    "target_count": session["answer_target"],
                    "proposed_count": len(session_learnings),
                    "confirmed_count": sum(
                        item.get("review_action") == "confirm" for item in session_learnings
                    ),
                    "edited_count": sum(
                        item.get("review_action") == "edit" for item in session_learnings
                    ),
                    "rejected_count": sum(
                        item.get("review_action") == "reject" for item in session_learnings
                    ),
                    "deferred_branch_count": sum(
                        item["source_session_id"] == session_id for item in deferred
                    ),
                }
            )
        return entries

    def complete_training_session(
        self, workspace_id: str, persona_id: str, session_id: int
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE training_sessions
                   SET status='completed', completed_at=COALESCE(completed_at, ?),
                       questions_complete_at=COALESCE(questions_complete_at, ?),
                       lifecycle_state=CASE
                         WHEN lifecycle_state='active' THEN 'questions_complete'
                         ELSE lifecycle_state END
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (now, now, workspace_id, persona_id, session_id),
            ).rowcount
        if not updated:
            return self.training_session(workspace_id, persona_id, session_id)
        return self.training_session(workspace_id, persona_id, session_id)

    def complete_training_review(
        self,
        workspace_id: str,
        persona_id: str,
        session_id: int,
        *,
        deferred: bool = False,
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            db.execute(
                """UPDATE training_sessions
                   SET lifecycle_state='review_complete', review_completed_at=?,
                       review_deferred=?
                   WHERE workspace_id=? AND persona_id=? AND id=?
                     AND status='completed'""",
                (now, int(deferred), workspace_id, persona_id, session_id),
            )
        return self.training_session(workspace_id, persona_id, session_id)

    def proposed_learnings(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id, persona_id, source_type, source_reference, statement,
                          provenance, status, review_action, created_at, updated_at
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
                          provenance, status, review_action, created_at, updated_at
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
        review_action: str | None = None,
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
                   SET statement=?, provenance=?, status=?, review_action=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (
                    statement,
                    provenance,
                    status,
                    review_action,
                    now,
                    workspace_id,
                    persona_id,
                    learning_id,
                ),
            ).rowcount
            row = db.execute(
                """SELECT id, persona_id, source_type, source_reference, statement,
                          provenance, status, review_action, created_at, updated_at
                   FROM proposed_agent_learnings
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, learning_id),
            ).fetchone()
        return dict(row) if updated and row else None

    def create_enrichment_job(self, workspace_id: str, persona_id: str, provider: str) -> dict:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO profile_enrichment_jobs(
                     workspace_id, persona_id, status, provider, created_at, updated_at
                   ) VALUES (?, ?, 'running', ?, ?, ?)""",
                (workspace_id, persona_id, provider, now, now),
            )
            job_id = int(cursor.lastrowid)
        return self.enrichment_job(workspace_id, persona_id, job_id)

    def enrichment_job(self, workspace_id: str, persona_id: str, job_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, persona_id, status, provider, found_count, message,
                          created_at, updated_at
                   FROM profile_enrichment_jobs
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, job_id),
            ).fetchone()
        return dict(row) if row else None

    def latest_enrichment(self, workspace_id: str, persona_id: str) -> dict:
        with self._connect() as db:
            row = db.execute(
                """SELECT id FROM profile_enrichment_jobs
                   WHERE workspace_id=? AND persona_id=? ORDER BY id DESC LIMIT 1""",
                (workspace_id, persona_id),
            ).fetchone()
        if not row:
            return {"status": "idle", "provider": None, "found_count": 0, "candidates": []}
        job = self.enrichment_job(workspace_id, persona_id, row["id"])
        assert job is not None
        job["candidates"] = self.profile_candidate_facts(workspace_id, persona_id)
        return job

    def complete_enrichment_job(
        self,
        workspace_id: str,
        persona_id: str,
        job_id: int,
        candidates: list[dict],
        message: str | None = None,
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            for candidate in candidates:
                db.execute(
                    """INSERT OR REPLACE INTO profile_candidate_facts(
                         candidate_id, workspace_id, persona_id, job_id, category,
                         proposed_title, proposed_detail, source_type, source_title,
                         source_url, retrieved_at, model_generated_summary,
                         confidence, review_status, reviewed_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', NULL)""",
                    (
                        candidate["candidate_id"],
                        workspace_id,
                        persona_id,
                        job_id,
                        candidate["category"],
                        candidate["proposed_title"],
                        candidate.get("proposed_detail"),
                        candidate["source_type"],
                        candidate["source_title"],
                        candidate.get("source_url"),
                        candidate.get("retrieved_at", now),
                        int(candidate.get("model_generated_summary", False)),
                        candidate.get("confidence"),
                    ),
                )
            db.execute(
                """UPDATE profile_enrichment_jobs
                   SET status='complete', found_count=?, message=?, updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (len(candidates), message, now, workspace_id, persona_id, job_id),
            )
        result = self.enrichment_job(workspace_id, persona_id, job_id)
        assert result is not None
        result["candidates"] = self.profile_candidate_facts(workspace_id, persona_id)
        return result

    def profile_candidate_facts(self, workspace_id: str, persona_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT candidate_id, category, proposed_title, proposed_detail,
                          source_type, source_title, source_url, retrieved_at,
                          model_generated_summary, confidence, review_status, reviewed_at
                   FROM profile_candidate_facts
                   WHERE workspace_id=? AND persona_id=? ORDER BY job_id, candidate_id""",
                (workspace_id, persona_id),
            ).fetchall()
        return [
            {
                **dict(row),
                "model_generated_summary": bool(row["model_generated_summary"]),
            }
            for row in rows
        ]

    def review_profile_candidate(
        self,
        workspace_id: str,
        persona_id: str,
        candidate_id: str,
        status: str,
        title: str | None = None,
        detail: str | None = None,
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE profile_candidate_facts
                   SET review_status=?,
                       proposed_title=COALESCE(?, proposed_title),
                       proposed_detail=COALESCE(?, proposed_detail), reviewed_at=?
                   WHERE workspace_id=? AND persona_id=? AND candidate_id=?""",
                (status, title, detail, now, workspace_id, persona_id, candidate_id),
            ).rowcount
        if not updated:
            return None
        return next(
            item
            for item in self.profile_candidate_facts(workspace_id, persona_id)
            if item["candidate_id"] == candidate_id
        )

    def create_practice_update(
        self,
        workspace_id: str,
        persona_id: str,
        update_type: str,
        title: str,
        body: str,
        provenance: str,
        agent_drafted: bool = False,
        source_input: dict | None = None,
        synthetic_case: bool = False,
        case_safety_label: str | None = None,
        visibility: str = "network",
    ) -> dict:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO practice_updates(
                     workspace_id, persona_id, update_type, title, body, provenance,
                     status, agent_drafted, created_at, updated_at, post_type,
                     authored_by, drafted_by, physician_approved, visibility,
                     source_input_json, synthetic_case, case_safety_label
                   ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'physician',
                     ?, 0, ?, ?, ?, ?)""",
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
                    update_type,
                    "lamina_agent" if agent_drafted else "physician",
                    visibility,
                    json.dumps(source_input) if source_input is not None else None,
                    int(synthetic_case),
                    case_safety_label,
                ),
            )
            update_id = int(cursor.lastrowid)
        return self.practice_update(workspace_id, persona_id, update_id)

    def practice_update(self, workspace_id: str, persona_id: str, update_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, persona_id, post_type AS type, title, body,
                          provenance, status, agent_drafted, authored_by, drafted_by,
                          physician_approved, visibility, source_input_json,
                          synthetic_case, case_safety_label, created_at,
                          updated_at, published_at
                   FROM practice_updates
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (workspace_id, persona_id, update_id),
            ).fetchone()
        return self._post_dict(row)

    @staticmethod
    def _post_dict(row: sqlite3.Row | None) -> dict | None:
        if not row:
            return None
        result = dict(row)
        source_input_json = result.pop("source_input_json")
        return {
            **result,
            "agent_drafted": bool(row["agent_drafted"]),
            "physician_approved": bool(row["physician_approved"]),
            "synthetic_case": bool(row["synthetic_case"]),
            "source_input": json.loads(source_input_json) if source_input_json else None,
        }

    def practice_updates(
        self,
        workspace_id: str,
        persona_id: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        query = """SELECT id, persona_id, post_type AS type, title, body,
                      provenance, status, agent_drafted, authored_by, drafted_by,
                      physician_approved, visibility, source_input_json,
                      synthetic_case, case_safety_label, created_at,
                      updated_at, published_at
               FROM practice_updates WHERE workspace_id=?"""
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
        return [self._post_dict(row) for row in rows]

    def edit_practice_update(
        self,
        workspace_id: str,
        persona_id: str,
        update_id: int,
        update_type: str,
        title: str,
        body: str,
        source_input: dict | None = None,
        synthetic_case: bool | None = None,
        case_safety_label: str | None = None,
    ) -> dict | None:
        now = self._now()
        with self._connect() as db:
            updated = db.execute(
                """UPDATE practice_updates SET update_type=?, post_type=?, title=?,
                     body=?, source_input_json=COALESCE(?, source_input_json),
                     synthetic_case=COALESCE(?, synthetic_case),
                     case_safety_label=COALESCE(?, case_safety_label), updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=? AND status='draft'""",
                (
                    update_type,
                    update_type,
                    title,
                    body,
                    json.dumps(source_input) if source_input is not None else None,
                    int(synthetic_case) if synthetic_case is not None else None,
                    case_safety_label,
                    now,
                    workspace_id,
                    persona_id,
                    update_id,
                ),
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
                     physician_approved=CASE WHEN ?='published' THEN 1
                                             ELSE physician_approved END,
                     updated_at=?
                   WHERE workspace_id=? AND persona_id=? AND id=?""",
                (
                    status,
                    status,
                    published_at,
                    status,
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

        A brand-new workspace is lazily seeded with a believable starting roster
        (see `_DEFAULT_NETWORK_MEMBER_NPIS`) the first time membership is read, so
        Network -> Colleagues never opens empty. This only fires when the table has
        no rows at all for the workspace; once seeded (or once a physician
        explicitly removes every colleague down to zero), it is not re-seeded.
        """
        with self._connect() as db:
            rows = db.execute(
                """SELECT npi, added_at FROM network_members WHERE workspace_id=?
                   ORDER BY added_at, npi""",
                (workspace_id,),
            ).fetchall()
            if not rows and not self._workspace_seeded(db, workspace_id):
                self._seed_default_network_members(db, workspace_id)
                rows = db.execute(
                    """SELECT npi, added_at FROM network_members WHERE workspace_id=?
                       ORDER BY added_at, npi""",
                    (workspace_id,),
                ).fetchall()
        return [dict(row) for row in rows]

    def _workspace_seeded(self, db: sqlite3.Connection, workspace_id: str) -> bool:
        row = db.execute(
            "SELECT 1 FROM network_seed_state WHERE workspace_id=?", (workspace_id,)
        ).fetchone()
        return row is not None

    def _seed_default_network_members(self, db: sqlite3.Connection, workspace_id: str) -> None:
        base = self._now()
        for offset, npi in enumerate(_DEFAULT_NETWORK_MEMBER_NPIS):
            seeded_at = (
                datetime.now(UTC) - timedelta(days=90 - offset * 7)
            ).isoformat().replace("+00:00", "Z")
            db.execute(
                """INSERT INTO network_members(workspace_id, npi, added_at)
                   VALUES (?, ?, ?) ON CONFLICT(workspace_id, npi) DO NOTHING""",
                (workspace_id, npi, seeded_at),
            )
        db.execute(
            "INSERT INTO network_seed_state(workspace_id, seeded_at) VALUES (?, ?) "
            "ON CONFLICT(workspace_id) DO NOTHING",
            (workspace_id, base),
        )

    def add_network_member(self, workspace_id: str, npi: str) -> dict:
        """Idempotent: re-adding an existing relationship keeps the original date.

        Also marks the workspace as past the lazy-seed point (see `network_members`)
        so an explicit add never races with — or is later undone by — auto-seeding,
        and so removing every colleague down to zero never silently re-seeds them.
        """
        with self._connect() as db:
            db.execute(
                "INSERT INTO network_seed_state(workspace_id, seeded_at) VALUES (?, ?) "
                "ON CONFLICT(workspace_id) DO NOTHING",
                (workspace_id, self._now()),
            )
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
            return (
                db.execute(
                    "DELETE FROM network_members WHERE workspace_id=? AND npi=?",
                    (workspace_id, npi),
                ).rowcount
                > 0
            )

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

    @staticmethod
    def _owner_scope_dict(row: sqlite3.Row | None) -> dict | None:
        if not row:
            return None
        result = dict(row)
        result["provider_identity"] = json.loads(result.pop("provider_identity_json"))
        result["clinical_access"] = bool(result["clinical_access"])
        result["selected"] = bool(result["selected"])
        return result

    def ensure_physician_owner_scope(self, claim: dict, provider_identity: dict) -> dict:
        """Idempotently bind an active claim to an opaque private engagement scope."""
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM physician_owner_scopes WHERE provider_claim_id=?",
                (claim["id"],),
            ).fetchone()
            if existing:
                return self._owner_scope_dict(existing)  # type: ignore[return-value]
            selected = not bool(
                db.execute(
                    "SELECT 1 FROM physician_owner_scopes WHERE auth_user_id=? AND selected=1",
                    (claim["auth_user_id"],),
                ).fetchone()
            )
            scope_id = f"pos-{secrets.token_hex(16)}"
            storage_scope_id = f"physician-owner-{secrets.token_hex(16)}"
            physician_id = f"claimed-physician-{secrets.token_hex(16)}"
            db.execute(
                """INSERT INTO physician_owner_scopes(
                     id, provider_claim_id, auth_user_id, npi, storage_scope_id,
                     physician_id, provider_identity_json, selected, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    scope_id,
                    claim["id"],
                    claim["auth_user_id"],
                    claim["npi"],
                    storage_scope_id,
                    physician_id,
                    json.dumps(provider_identity, separators=(",", ":"), sort_keys=True),
                    int(selected),
                    now,
                    now,
                ),
            )
            row = db.execute(
                "SELECT * FROM physician_owner_scopes WHERE id=?", (scope_id,)
            ).fetchone()
        return self._owner_scope_dict(row)  # type: ignore[return-value]

    def physician_owner_scopes(self, auth_user_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM physician_owner_scopes WHERE auth_user_id=?
                   ORDER BY selected DESC, created_at, id""",
                (auth_user_id,),
            ).fetchall()
        return [self._owner_scope_dict(row) for row in rows]  # type: ignore[misc]

    def physician_owner_scope_for_claim(self, claim_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM physician_owner_scopes WHERE provider_claim_id=?",
                (claim_id,),
            ).fetchone()
        return self._owner_scope_dict(row)

    def selected_physician_owner_scope(self, auth_user_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT * FROM physician_owner_scopes WHERE auth_user_id=?
                   ORDER BY selected DESC, created_at, id LIMIT 1""",
                (auth_user_id,),
            ).fetchone()
        return self._owner_scope_dict(row)

    def select_physician_owner_scope(self, auth_user_id: str, claim_id: int) -> dict | None:
        now = self._now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            owned = db.execute(
                """SELECT id FROM physician_owner_scopes
                   WHERE auth_user_id=? AND provider_claim_id=?""",
                (auth_user_id, claim_id),
            ).fetchone()
            if not owned:
                return None
            db.execute(
                "UPDATE physician_owner_scopes SET selected=0, updated_at=? WHERE auth_user_id=?",
                (now, auth_user_id),
            )
            db.execute(
                "UPDATE physician_owner_scopes SET selected=1, updated_at=? WHERE id=?",
                (now, owned["id"]),
            )
            row = db.execute(
                "SELECT * FROM physician_owner_scopes WHERE id=?", (owned["id"],)
            ).fetchone()
        return self._owner_scope_dict(row)

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

    def update_preference(self, workspace_id: str, key: str, statement: str, status: str) -> dict:
        provenance = (
            "Physician-confirmed demo preference"
            if status == "confirmed"
            else ("Physician-edited draft" if status == "suggested" else "Rejected suggestion")
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
        return {
            "key": key,
            "statement": statement,
            "provenance": provenance,
            "status": status,
            "updated_at": now,
        }


workflow_store = WorkflowStore()
