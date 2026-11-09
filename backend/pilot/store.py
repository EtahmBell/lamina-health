"""Persistence for the real practice pilot.

Shares the workflow SQLite file (one backup unit) but owns its own tables, and
never reads demo-workspace tables. Every pilot row is keyed by `practice_id`.
Recommendations, decisions, and events are append-only (enforced by triggers).
"""

from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from backend.workflow import WorkflowStore, workflow_store

_SCHEMA = """
CREATE TABLE IF NOT EXISTS practices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  specialty TEXT,
  website TEXT,
  address TEXT,
  phone TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_members (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  user_id TEXT NOT NULL,
  physician_owner_scope_id TEXT REFERENCES physician_owner_scopes(id),
  role TEXT NOT NULL CHECK(role IN ('physician', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'removed')),
  label TEXT,
  invited_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(role != 'physician' OR physician_owner_scope_id IS NOT NULL)
);
-- Pilot simplification: one active practice per account.
CREATE UNIQUE INDEX IF NOT EXISTS practice_members_one_active_per_user
  ON practice_members(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS practice_members_practice
  ON practice_members(practice_id, status);
CREATE TABLE IF NOT EXISTS practice_invitations (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  role TEXT NOT NULL CHECK(role IN ('staff')),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS intake_referrals (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL CHECK(source IN ('manual', 'upload', 'public_form')),
  status TEXT NOT NULL CHECK(status IN (
    'received', 'triaged', 'needs_information', 'ready_for_review',
    'accepted', 'redirected', 'declined')),
  sender_json TEXT NOT NULL,
  patient_json TEXT NOT NULL,
  referral_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  clinical_context TEXT,
  sender_priority TEXT,
  submitted_items_json TEXT NOT NULL DEFAULT '[]',
  received_at TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  sender_status_token_hash TEXT NOT NULL UNIQUE,
  current_recommendation_id TEXT,
  review_json TEXT,
  escalated_at TEXT,
  escalated_by TEXT,
  escalation_note TEXT,
  information_request_json TEXT,
  disposition_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_referrals_practice
  ON intake_referrals(practice_id, status, received_at DESC);
CREATE TABLE IF NOT EXISTS referral_documents (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  referral_id TEXT NOT NULL REFERENCES intake_referrals(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  extraction_status TEXT NOT NULL,
  extracted_pages_json TEXT,
  page_count INTEGER
);
CREATE INDEX IF NOT EXISTS referral_documents_referral
  ON referral_documents(practice_id, referral_id);
CREATE TABLE IF NOT EXISTS triage_recommendations (
  id TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES intake_referrals(id),
  practice_id TEXT NOT NULL,
  recommendation_json TEXT NOT NULL,
  generator TEXT NOT NULL,
  model_id TEXT,
  rules_snapshot_id TEXT NOT NULL,
  rules_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_recommendations_referral
  ON triage_recommendations(practice_id, referral_id, created_at);
CREATE TABLE IF NOT EXISTS recommendation_decisions (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES triage_recommendations(id),
  referral_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accepted', 'edited', 'rejected')),
  changed_fields_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS recommendation_decisions_one_per_recommendation
  ON recommendation_decisions(recommendation_id);
CREATE TABLE IF NOT EXISTS pilot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  practice_id TEXT,
  owner_scope_id TEXT,
  referral_id TEXT,
  actor TEXT NOT NULL,
  autonomy TEXT NOT NULL CHECK(autonomy IN ('automatic', 'human')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_events_practice ON pilot_events(practice_id, id);
CREATE INDEX IF NOT EXISTS pilot_events_type ON pilot_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS pilot_events_actor ON pilot_events(actor, event_type, id);

CREATE TRIGGER IF NOT EXISTS pilot_events_no_update BEFORE UPDATE ON pilot_events
BEGIN SELECT RAISE(ABORT, 'pilot_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pilot_events_no_delete BEFORE DELETE ON pilot_events
BEGIN SELECT RAISE(ABORT, 'pilot_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS triage_recommendations_no_update
BEFORE UPDATE ON triage_recommendations
BEGIN SELECT RAISE(ABORT, 'triage recommendations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS triage_recommendations_no_delete
BEFORE DELETE ON triage_recommendations
BEGIN SELECT RAISE(ABORT, 'triage recommendations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_decisions_no_update
BEFORE UPDATE ON recommendation_decisions
BEGIN SELECT RAISE(ABORT, 'recommendation decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_decisions_no_delete
BEFORE DELETE ON recommendation_decisions
BEGIN SELECT RAISE(ABORT, 'recommendation decisions are immutable'); END;
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(12)}"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _loads(value: str | None, default: Any = None) -> Any:
    return json.loads(value) if value else default


class PilotStore:
    def __init__(self, path: Path | None = None, workflow: WorkflowStore | None = None) -> None:
        # Constructing the workflow store first guarantees the shared tables
        # (owner scopes, claims, canonical rule store) and their migrations exist.
        self.workflow = workflow or (WorkflowStore(path) if path else workflow_store)
        self.path = self.workflow.path
        with self._connect() as db:
            db.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    # ------------------------------------------------------------------ events

    def append_event(
        self,
        event_type: str,
        *,
        actor: str,
        autonomy: str = "human",
        practice_id: str | None = None,
        owner_scope_id: str | None = None,
        referral_id: str | None = None,
        metadata: dict | None = None,
        db: sqlite3.Connection | None = None,
    ) -> None:
        statement = (
            "INSERT INTO pilot_events (event_type, practice_id, owner_scope_id, referral_id, "
            "actor, autonomy, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        values = (
            event_type, practice_id, owner_scope_id, referral_id, actor, autonomy,
            json.dumps(metadata or {}, sort_keys=True), now_iso(),
        )
        if db is not None:
            db.execute(statement, values)
            return
        with self._connect() as own:
            own.execute(statement, values)

    def events(
        self,
        *,
        practice_id: str | None = None,
        event_type: str | None = None,
        referral_id: str | None = None,
        actor: str | None = None,
    ) -> list[dict]:
        clauses, values = [], []
        for column, value in (
            ("practice_id", practice_id), ("event_type", event_type),
            ("referral_id", referral_id), ("actor", actor),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                values.append(value)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as db:
            rows = db.execute(f"SELECT * FROM pilot_events {where} ORDER BY id", values).fetchall()
        return [{**dict(row), "metadata": _loads(row["metadata_json"], {})} for row in rows]

    def last_event_at(self, actor: str, event_type: str) -> str | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT created_at FROM pilot_events WHERE actor = ? AND event_type = ? "
                "ORDER BY id DESC LIMIT 1",
                (actor, event_type),
            ).fetchone()
        return row["created_at"] if row else None

    # --------------------------------------------------------------- practices

    def create_practice(
        self, *, user_id: str, owner_scope_id: str, fields: dict[str, Any]
    ) -> tuple[dict, dict]:
        now = now_iso()
        practice_id, member_id = new_id("prc"), new_id("mem")
        with self._connect() as db:
            db.execute(
                "INSERT INTO practices (id, name, specialty, website, address, phone, "
                "contact_email, status, created_by_user_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
                (
                    practice_id, fields["name"], fields.get("specialty"), fields.get("website"),
                    fields.get("address"), fields.get("phone"), fields.get("contact_email"),
                    user_id, now, now,
                ),
            )
            db.execute(
                "INSERT INTO practice_members (id, practice_id, user_id, physician_owner_scope_id, "
                "role, status, label, invited_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'physician', 'active', NULL, NULL, ?, ?)",
                (member_id, practice_id, user_id, owner_scope_id, now, now),
            )
            self.append_event(
                "practice_created", actor=f"user:{user_id}", practice_id=practice_id,
                owner_scope_id=owner_scope_id, metadata={"name": fields["name"]}, db=db,
            )
        return self.practice(practice_id), self.membership_for_user(user_id)

    def update_practice(self, practice_id: str, fields: dict[str, Any], actor: str) -> dict:
        allowed = ("name", "specialty", "website", "address", "phone", "contact_email")
        updates = {key: fields.get(key) for key in allowed}
        with self._connect() as db:
            db.execute(
                f"UPDATE practices SET {', '.join(f'{key} = ?' for key in updates)}, "
                "updated_at = ? WHERE id = ?",
                (*updates.values(), now_iso(), practice_id),
            )
            self.append_event(
                "practice_updated", actor=actor, practice_id=practice_id,
                metadata={"fields": sorted(key for key, value in updates.items() if value)}, db=db,
            )
        return self.practice(practice_id)

    def practice(self, practice_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM practices WHERE id = ?", (practice_id,)).fetchone()
        return dict(row) if row else None

    def membership_for_user(self, user_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM practice_members WHERE user_id = ? AND status = 'active'",
                (user_id,),
            ).fetchone()
        return dict(row) if row else None

    def members(self, practice_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM practice_members WHERE practice_id = ? AND status = 'active' "
                "ORDER BY created_at",
                (practice_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def physician_scope_ids(self, practice_id: str) -> list[str]:
        return [
            member["physician_owner_scope_id"]
            for member in self.members(practice_id)
            if member["role"] == "physician" and member["physician_owner_scope_id"]
        ]

    def remove_member(self, practice_id: str, member_id: str, actor: str) -> bool:
        with self._connect() as db:
            changed = db.execute(
                "UPDATE practice_members SET status = 'removed', updated_at = ? "
                "WHERE id = ? AND practice_id = ? AND role = 'staff' AND status = 'active'",
                (now_iso(), member_id, practice_id),
            ).rowcount
            if changed:
                self.append_event(
                    "staff_removed", actor=actor, practice_id=practice_id,
                    metadata={"member_id": member_id}, db=db,
                )
        return bool(changed)

    # ------------------------------------------------------------- invitations

    def create_invitation(
        self, practice_id: str, *, role: str, label: str | None, actor: str, ttl_days: int = 14
    ) -> tuple[dict, str]:
        token = secrets.token_urlsafe(32)
        now = datetime.now(UTC)
        invitation_id = new_id("inv")
        with self._connect() as db:
            db.execute(
                "INSERT INTO practice_invitations (id, practice_id, role, token_hash, label, "
                "created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    invitation_id, practice_id, role, hash_token(token), label, actor,
                    now.isoformat(timespec="seconds"),
                    (now + timedelta(days=ttl_days)).isoformat(timespec="seconds"),
                ),
            )
            self.append_event(
                "staff_invited", actor=actor, practice_id=practice_id,
                metadata={"invitation_id": invitation_id, "role": role}, db=db,
            )
        return self.invitation(invitation_id), token

    def invitation(self, invitation_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM practice_invitations WHERE id = ?", (invitation_id,)
            ).fetchone()
        return dict(row) if row else None

    def invitation_by_token(self, token: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM practice_invitations WHERE token_hash = ?", (hash_token(token),)
            ).fetchone()
        return dict(row) if row else None

    def invitations(self, practice_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM practice_invitations WHERE practice_id = ? ORDER BY created_at DESC",
                (practice_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def revoke_invitation(self, practice_id: str, invitation_id: str, actor: str) -> bool:
        with self._connect() as db:
            changed = db.execute(
                "UPDATE practice_invitations SET revoked_at = ? WHERE id = ? AND practice_id = ? "
                "AND accepted_at IS NULL AND revoked_at IS NULL",
                (now_iso(), invitation_id, practice_id),
            ).rowcount
            if changed:
                self.append_event(
                    "staff_invitation_revoked", actor=actor, practice_id=practice_id,
                    metadata={"invitation_id": invitation_id}, db=db,
                )
        return bool(changed)

    def accept_invitation(self, invitation: dict, user_id: str) -> dict:
        """Single-use: the conditional UPDATE is the race guard."""
        now = now_iso()
        member_id = new_id("mem")
        with self._connect() as db:
            claimed = db.execute(
                "UPDATE practice_invitations SET accepted_by_user_id = ?, accepted_at = ? "
                "WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
                (user_id, now, invitation["id"], now),
            ).rowcount
            if not claimed:
                raise ValueError("invitation_unavailable")
            db.execute(
                "INSERT INTO practice_members (id, practice_id, user_id, physician_owner_scope_id, "
                "role, status, label, invited_by, created_at, updated_at) "
                "VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?)",
                (
                    member_id, invitation["practice_id"], user_id, invitation["role"],
                    invitation.get("label"), invitation["created_by"], now, now,
                ),
            )
            self.append_event(
                "staff_joined", actor=f"user:{user_id}", practice_id=invitation["practice_id"],
                metadata={"invitation_id": invitation["id"], "member_id": member_id}, db=db,
            )
        return self.membership_for_user(user_id)

    # --------------------------------------------------------------- referrals

    def insert_referral(self, row: dict[str, Any], event_metadata: dict, actor: str) -> None:
        columns = list(row)
        with self._connect() as db:
            db.execute(
                f"INSERT INTO intake_referrals ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                [row[column] for column in columns],
            )
            self.append_event(
                "referral_received", actor=actor, practice_id=row["practice_id"],
                referral_id=row["id"], metadata=event_metadata, db=db,
            )

    def referral_row(self, practice_id: str, referral_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM intake_referrals WHERE id = ? AND practice_id = ?",
                (referral_id, practice_id),
            ).fetchone()
        return dict(row) if row else None

    def referral_rows(self, practice_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM intake_referrals WHERE practice_id = ? "
                "ORDER BY received_at DESC, created_at DESC",
                (practice_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_referral(
        self,
        practice_id: str,
        referral_id: str,
        *,
        expected_status: str,
        changes: dict[str, Any],
        events: list[dict],
        decision: dict | None = None,
        recommendation: dict | None = None,
    ) -> bool:
        """Optimistic, single-transaction transition: the row must still be in
        `expected_status`, so two concurrent actions cannot both apply."""
        changes = {**changes, "updated_at": now_iso()}
        with self._connect() as db:
            if recommendation is not None:
                self._insert_recommendation(db, recommendation)
                changes["current_recommendation_id"] = recommendation["id"]
            changed = db.execute(
                f"UPDATE intake_referrals SET {', '.join(f'{key} = ?' for key in changes)} "
                "WHERE id = ? AND practice_id = ? AND status = ?",
                (*changes.values(), referral_id, practice_id, expected_status),
            ).rowcount
            if not changed:
                db.rollback()
                return False
            if decision is not None:
                db.execute(
                    "INSERT INTO recommendation_decisions (id, recommendation_id, referral_id, "
                    "practice_id, decision, changed_fields_json, reason, actor, actor_role, "
                    "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        decision["id"], decision["recommendation_id"], referral_id, practice_id,
                        decision["decision"], json.dumps(decision["changed_fields"], sort_keys=True),
                        decision.get("reason"), decision["actor"], decision["actor_role"],
                        decision["created_at"],
                    ),
                )
            for event in events:
                self.append_event(
                    event["event_type"], actor=event["actor"],
                    autonomy=event.get("autonomy", "human"), practice_id=practice_id,
                    referral_id=referral_id, metadata=event.get("metadata"), db=db,
                )
        return True

    # ---------------------------------------------------------------- documents

    def insert_document(self, row: dict[str, Any], actor: str) -> None:
        columns = list(row)
        with self._connect() as db:
            db.execute(
                f"INSERT INTO referral_documents ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                [row[column] for column in columns],
            )
            self.append_event(
                "document_uploaded", actor=actor, practice_id=row["practice_id"],
                referral_id=row["referral_id"],
                metadata={
                    "document_id": row["id"], "content_type": row["content_type"],
                    "size_bytes": row["size_bytes"], "extraction_status": row["extraction_status"],
                },
                db=db,
            )

    def document_rows(self, practice_id: str, referral_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM referral_documents WHERE practice_id = ? AND referral_id = ? "
                "ORDER BY uploaded_at",
                (practice_id, referral_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def document_row(self, practice_id: str, document_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM referral_documents WHERE practice_id = ? AND id = ?",
                (practice_id, document_id),
            ).fetchone()
        return dict(row) if row else None

    # ----------------------------------------------------------------- triage

    @staticmethod
    def _insert_recommendation(db: sqlite3.Connection, recommendation: dict) -> None:
        db.execute(
            "INSERT INTO triage_recommendations (id, referral_id, practice_id, "
            "recommendation_json, generator, model_id, rules_snapshot_id, rules_snapshot_json, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                recommendation["id"], recommendation["referral_id"],
                recommendation["practice_id"], json.dumps(recommendation["payload"]),
                recommendation["generator"], recommendation.get("model_id"),
                recommendation["rules_snapshot_id"],
                json.dumps(recommendation["rules_snapshot"], sort_keys=True),
                recommendation["created_at"],
            ),
        )

    def recommendation_rows(self, practice_id: str, referral_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM triage_recommendations WHERE practice_id = ? AND referral_id = ? "
                "ORDER BY created_at, rowid",
                (practice_id, referral_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def recommendation_row(self, practice_id: str, recommendation_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM triage_recommendations WHERE practice_id = ? AND id = ?",
                (practice_id, recommendation_id),
            ).fetchone()
        return dict(row) if row else None

    def decision_rows(self, practice_id: str, referral_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM recommendation_decisions WHERE practice_id = ? AND referral_id = ? "
                "ORDER BY created_at, rowid",
                (practice_id, referral_id),
            ).fetchall()
        return [
            {**dict(row), "changed_fields": _loads(row["changed_fields_json"], {})} for row in rows
        ]

    def decision_for(self, recommendation_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM recommendation_decisions WHERE recommendation_id = ?",
                (recommendation_id,),
            ).fetchone()
        return {**dict(row), "changed_fields": _loads(row["changed_fields_json"], {})} if row else None


_stores: dict[str, PilotStore] = {}


def pilot_store_for(workflow: WorkflowStore) -> PilotStore:
    """One PilotStore per workflow database file."""
    key = str(Path(workflow.path).resolve())
    if key not in _stores:
        _stores[key] = PilotStore(workflow=workflow)
    return _stores[key]
