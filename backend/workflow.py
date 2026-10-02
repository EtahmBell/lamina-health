"""Small Lamina-owned demo workflow record, separate from clinical FHIR data."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from backend.config import environment
from backend.models import ConsultationResult


class WorkflowStore:
    def __init__(self, path: Path | None = None) -> None:
        default = Path(__file__).resolve().parents[1] / "data" / "workflow.sqlite"
        self.path = path or Path(environment.get("LAMINA_WORKFLOW_DATABASE", str(default)))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS patient_activity (
                  patient_id TEXT PRIMARY KEY, last_opened TEXT, last_started TEXT,
                  last_consultation TEXT, consultation_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS consultations (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL,
                  completed_at TEXT NOT NULL, result_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_preferences (
                  key TEXT PRIMARY KEY, statement TEXT NOT NULL,
                  provenance TEXT NOT NULL, status TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS network_members (
                  npi TEXT PRIMARY KEY, added_at TEXT NOT NULL
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
            if "last_started" not in {
                row["name"] for row in db.execute("PRAGMA table_info(patient_activity)")
            }:
                db.execute("ALTER TABLE patient_activity ADD COLUMN last_started TEXT")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat(timespec="seconds")

    def opened(self, patient_id: str) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO patient_activity(patient_id, last_opened) VALUES (?, ?)
                   ON CONFLICT(patient_id) DO UPDATE SET last_opened=excluded.last_opened""",
                (patient_id, self._now()),
            )

    def started(self, patient_id: str) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO patient_activity(patient_id, last_started) VALUES (?, ?)
                   ON CONFLICT(patient_id) DO UPDATE SET last_started=excluded.last_started""",
                (patient_id, self._now()),
            )

    def completed(self, result: ConsultationResult) -> int:
        now = self._now()
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO consultations(patient_id, completed_at, result_json) VALUES (?, ?, ?)",
                (result.patient_id, now, result.model_dump_json()),
            )
            db.execute(
                """INSERT INTO patient_activity(patient_id, last_consultation, consultation_count)
                   VALUES (?, ?, 1) ON CONFLICT(patient_id) DO UPDATE SET
                   last_consultation=excluded.last_consultation,
                   consultation_count=patient_activity.consultation_count+1""",
                (result.patient_id, now),
            )
            return int(cursor.lastrowid)

    def activity(self, patient_ids: list[str]) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM patient_activity").fetchall()
            consultations = db.execute(
                "SELECT id, patient_id, completed_at, result_json "
                "FROM consultations ORDER BY id DESC"
            ).fetchall()
        records = {row["patient_id"]: dict(row) for row in rows}
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

    def reset_demo_case(self, patient_id: str) -> dict:
        """Remove one demo case's Lamina workflow history, never its clinical source."""
        with self._connect() as db:
            removed = db.execute(
                "SELECT COUNT(*) FROM consultations WHERE patient_id=?", (patient_id,)
            ).fetchone()[0]
            db.execute("DELETE FROM consultations WHERE patient_id=?", (patient_id,))
            db.execute(
                """UPDATE patient_activity SET last_started=NULL,
                   last_consultation=NULL, consultation_count=0 WHERE patient_id=?""",
                (patient_id,),
            )
            remaining = db.execute("SELECT COUNT(*) FROM consultations").fetchone()[0]
        return {
            "patient_id": patient_id,
            "removed_consultations": removed,
            "remaining_consultations": remaining,
            "reset_complete": True,
        }

    def history(self, limit: int = 30) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM consultations ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            {"id": row["id"], "patient_id": row["patient_id"],
             "completed_at": row["completed_at"],
             "result": json.loads(row["result_json"])}
            for row in rows
        ]

    def consultation(self, record_id: int) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM consultations WHERE id=?", (record_id,)).fetchone()
        return (
            {"id": row["id"], "patient_id": row["patient_id"],
             "completed_at": row["completed_at"], "result": json.loads(row["result_json"])}
            if row else None
        )

    def network_members(self) -> list[dict]:
        """Physician relationships the clinician recorded, oldest first.

        Membership is a workspace relationship only. It is deliberately separate
        from physician-agent activation state and never mutates directory identity.
        """
        with self._connect() as db:
            rows = db.execute(
                "SELECT npi, added_at FROM network_members ORDER BY added_at, npi"
            ).fetchall()
        return [dict(row) for row in rows]

    def add_network_member(self, npi: str) -> dict:
        """Idempotent: re-adding an existing relationship keeps the original date."""
        with self._connect() as db:
            db.execute(
                "INSERT INTO network_members(npi, added_at) VALUES (?, ?) "
                "ON CONFLICT(npi) DO NOTHING",
                (npi, self._now()),
            )
            row = db.execute(
                "SELECT npi, added_at FROM network_members WHERE npi=?", (npi,)
            ).fetchone()
        return dict(row)

    def remove_network_member(self, npi: str) -> bool:
        with self._connect() as db:
            return db.execute("DELETE FROM network_members WHERE npi=?", (npi,)).rowcount > 0

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

    def preferences(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM agent_preferences ORDER BY key").fetchall()
        return [dict(row) for row in rows]

    def update_preference(self, key: str, statement: str, status: str) -> dict:
        provenance = "Physician-confirmed demo preference" if status == "confirmed" else (
            "Physician-edited draft" if status == "suggested" else "Rejected suggestion"
        )
        now = self._now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO agent_preferences(key,statement,provenance,status,updated_at)
                   VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
                   statement=excluded.statement, provenance=excluded.provenance,
                   status=excluded.status, updated_at=excluded.updated_at""",
                (key, statement, provenance, status, now),
            )
        return {"key": key, "statement": statement, "provenance": provenance,
                "status": status, "updated_at": now}


workflow_store = WorkflowStore()
