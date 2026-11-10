"""Practice rules on the canonical operational rule store.

`physician_referral_preferences` is the ONE store pilot triage reads. Practice rows
use `scope='practice'`, a practice-namespaced `workspace_id`, and a free-string
`referral_type`, so demo code (which reads by demo workspace id) never sees them.

Content is immutable per row (DB trigger): a revision inserts version N+1 with
`supersedes_id` and marks the prior row superseded, so any recommendation's cited
`(rule_id, version)` can always be recovered exactly.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from backend.models.referral import ReferralRequirement

from .models import PracticeRule, PracticeRuleContent, PracticeRuleInput
from .store import PilotStore, new_id, now_iso

OPERATIONAL = ("confirmed", "inferred_active")


class RuleNotFoundError(LookupError):
    pass


class RuleConflictError(ValueError):
    pass


def practice_workspace_key(practice_id: str) -> str:
    """Namespaced so it can never equal an anonymous demo workspace id."""
    return f"practice:{practice_id}"


def normalize_referral_type(value: str) -> str:
    return " ".join(value.split()).casefold()


def _slug(text: str) -> str:
    cleaned = "".join(char if char.isalnum() else "_" for char in text.casefold())
    return "_".join(part for part in cleaned.split("_") if part)[:80] or "item"


def _normalize_requirements(items: list[ReferralRequirement], required: bool) -> list:
    normalized = []
    for item in items:
        key = _slug(item.key or item.label)
        normalized.append(
            ReferralRequirement(
                key=key, label=item.label.strip(), required=required,
                freshness_days=item.freshness_days,
            )
        )
    return normalized


def content_from_input(update: PracticeRuleInput) -> PracticeRuleContent:
    return PracticeRuleContent(
        good_fit=[value.strip() for value in update.good_fit if value.strip()],
        redirect=[value.strip() for value in update.outside_scope if value.strip()],
        required=_normalize_requirements(update.required, True),
        helpful=_normalize_requirements(update.helpful, False),
        urgent_signals=[value.strip() for value in update.urgent_signals if value.strip()],
        modality=update.modality,
        modality_notes=update.note.strip() if update.note else None,
    )


def _source_text(update: PracticeRuleInput) -> str:
    # Structured entry has no NL source; store a stable, readable rendering.
    return json.dumps(update.model_dump(mode="json"), sort_keys=True)


def _row_to_rule(row: dict[str, Any]) -> PracticeRule:
    return PracticeRule(
        id=row["id"],
        practice_id=row["practice_id"],
        referral_type=row["referral_type"],
        content=PracticeRuleContent.model_validate_json(row["structured_rules_json"]),
        source_text=row["source_text"],
        source=row["source"],
        scope=row["scope"],
        operational_status=row["operational_status"],
        physician_confirmed=bool(row["physician_confirmed"]),
        confidence=row["confidence"],
        provenance=json.loads(row["provenance_json"]) if row["provenance_json"] else None,
        publishable=bool(row["publishable"]),
        version=row["version"],
        supersedes_id=row["supersedes_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        confirmed_at=row["confirmed_at"],
    )


class PracticeRules:
    def __init__(self, store: PilotStore) -> None:
        self.store = store

    def _connect(self) -> sqlite3.Connection:
        return self.store._connect()

    def _row(self, db: sqlite3.Connection, practice_id: str, rule_id: str) -> dict | None:
        row = db.execute(
            "SELECT * FROM physician_referral_preferences WHERE id = ? AND practice_id = ? "
            "AND scope = 'practice'",
            (rule_id, practice_id),
        ).fetchone()
        return dict(row) if row else None

    def get(self, practice_id: str, rule_id: str) -> PracticeRule:
        with self._connect() as db:
            row = self._row(db, practice_id, rule_id)
        if not row:
            raise RuleNotFoundError(rule_id)
        return _row_to_rule(row)

    def list(self, practice_id: str, *, include_history: bool = False) -> list[PracticeRule]:
        clause = "" if include_history else "AND operational_status IN ('confirmed', 'inferred_active')"
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM physician_referral_preferences WHERE practice_id = ? "
                f"AND scope = 'practice' {clause} ORDER BY referral_type, version",
                (practice_id,),
            ).fetchall()
        return [_row_to_rule(dict(row)) for row in rows]

    def operational(self, practice_id: str, referral_type: str) -> list[PracticeRule]:
        """Exactly the rules triage may act on: confirmed or inferred-active."""
        target = normalize_referral_type(referral_type)
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM physician_referral_preferences WHERE practice_id = ? "
                "AND scope = 'practice' AND operational_status IN ('confirmed', 'inferred_active') "
                "ORDER BY created_at, id",
                (practice_id,),
            ).fetchall()
        return [
            _row_to_rule(dict(row))
            for row in rows
            if normalize_referral_type(row["referral_type"]) == target
        ]

    def referral_types(self, practice_id: str) -> list[str]:
        return sorted({rule.referral_type for rule in self.list(practice_id)})

    def create(
        self,
        practice_id: str,
        physician_id: str,
        update: PracticeRuleInput,
        *,
        actor: str,
        source: str = "physician_authored_structured",
        operational_status: str = "confirmed",
        confidence: float | None = None,
        provenance: dict | None = None,
        supersedes: PracticeRule | None = None,
        source_text: str | None = None,
        event_type: str | None = None,
        content: PracticeRuleContent | None = None,
    ) -> PracticeRule:
        content = content or content_from_input(update)
        now = now_iso()
        rule_id = new_id("rule")
        confirmed = operational_status == "confirmed"
        version = (supersedes.version + 1) if supersedes else 1
        with self._connect() as db:
            if supersedes is not None:
                changed = db.execute(
                    "UPDATE physician_referral_preferences SET operational_status = 'superseded', "
                    "status = 'superseded', updated_at = ? WHERE id = ? AND practice_id = ? "
                    "AND scope = 'practice' AND operational_status IN "
                    "('confirmed', 'inferred_active', 'inferred')",
                    (now, supersedes.id, practice_id),
                ).rowcount
                if not changed:
                    raise RuleConflictError("This rule has already been revised or retired")
            db.execute(
                "INSERT INTO physician_referral_preferences (id, workspace_id, physician_id, "
                "case_family, source_text, structured_rules_json, status, source, supersedes_id, "
                "representation_snapshot_id_at_confirmation, created_at, updated_at, confirmed_at, "
                "referral_type, scope, practice_id, confidence, operational_status, "
                "physician_confirmed, provenance_json, publishable, version) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'practice', ?, ?, ?, ?, ?, ?, ?)",
                (
                    rule_id, practice_workspace_key(practice_id), physician_id,
                    update.referral_type.strip(), source_text or _source_text(update),
                    content.model_dump_json(),
                    "confirmed" if confirmed else "draft", source,
                    supersedes.id if supersedes else None, now, now, now if confirmed else None,
                    update.referral_type.strip(), practice_id, confidence, operational_status,
                    1 if confirmed else 0,
                    json.dumps({**(provenance or {}), "actor": actor}, sort_keys=True),
                    1 if update.publishable else 0, version,
                ),
            )
            self.store.append_event(
                event_type or ("learning_corrected" if supersedes else (
                    "learning_confirmed" if confirmed else "learning_proposed"
                )),
                actor=actor, practice_id=practice_id,
                metadata={
                    "rule_id": rule_id, "version": version, "referral_type": update.referral_type,
                    "supersedes_id": supersedes.id if supersedes else None,
                    "operational_status": operational_status,
                },
                db=db,
            )
        return self.get(practice_id, rule_id)

    def revise(
        self, practice_id: str, rule_id: str, physician_id: str, update: PracticeRuleInput,
        *, actor: str,
    ) -> PracticeRule:
        current = self.get(practice_id, rule_id)
        # Publication is a separate, explicit decision: a content edit keeps it.
        update = update.model_copy(update={"publishable": current.publishable})
        return self.create(
            practice_id, physician_id, update, actor=actor, supersedes=current,
            provenance={"revision_of": current.id, "revision_of_version": current.version},
        )

    def retire(self, practice_id: str, rule_id: str, *, actor: str) -> PracticeRule:
        now = now_iso()
        with self._connect() as db:
            changed = db.execute(
                "UPDATE physician_referral_preferences SET operational_status = 'rejected', "
                "status = 'rejected', updated_at = ? WHERE id = ? AND practice_id = ? "
                "AND scope = 'practice' AND operational_status IN "
                "('confirmed', 'inferred_active', 'inferred')",
                (now, rule_id, practice_id),
            ).rowcount
            if not changed:
                raise RuleConflictError("This rule is not active")
            self.store.append_event(
                "learning_retired", actor=actor, practice_id=practice_id,
                metadata={"rule_id": rule_id}, db=db,
            )
        return self.get(practice_id, rule_id)

    def set_status(
        self, practice_id: str, rule_id: str, operational_status: str, *, actor: str,
        event_type: str, metadata: dict | None = None, from_statuses: tuple[str, ...] = ("inferred", "inferred_active"),
    ) -> PracticeRule:
        """Status-only change (content stays immutable). Confirming in place sets
        physician_confirmed and confirmed_at."""
        now = now_iso()
        confirmed = operational_status == "confirmed"
        legacy = {"confirmed": "confirmed", "superseded": "superseded", "rejected": "rejected"}.get(operational_status, "draft")
        placeholders = ", ".join("?" for _ in from_statuses)
        with self._connect() as db:
            changed = db.execute(
                "UPDATE physician_referral_preferences SET operational_status = ?, status = ?, "
                "physician_confirmed = CASE WHEN ? THEN 1 ELSE physician_confirmed END, "
                "confirmed_at = CASE WHEN ? THEN ? ELSE confirmed_at END, updated_at = ? "
                f"WHERE id = ? AND practice_id = ? AND scope = 'practice' AND operational_status IN ({placeholders})",
                (operational_status, legacy, confirmed, confirmed, now, now, rule_id, practice_id, *from_statuses),
            ).rowcount
            if not changed:
                raise RuleConflictError("This proposal is no longer pending")
            self.store.append_event(
                event_type, actor=actor, practice_id=practice_id,
                metadata={"rule_id": rule_id, "operational_status": operational_status, **(metadata or {})}, db=db,
            )
        return self.get(practice_id, rule_id)

    def set_publishable(self, practice_id: str, rule_id: str, publishable: bool, *, actor: str) -> PracticeRule:
        with self._connect() as db:
            changed = db.execute(
                "UPDATE physician_referral_preferences SET publishable = ?, updated_at = ? WHERE id = ? "
                "AND practice_id = ? AND scope = 'practice' AND operational_status IN ('confirmed', 'inferred_active')",
                (1 if publishable else 0, now_iso(), rule_id, practice_id),
            ).rowcount
            if not changed:
                raise RuleConflictError("Only an active rule can be published")
            self.store.append_event(
                "rule_publication_changed", actor=actor, practice_id=practice_id,
                metadata={"rule_id": rule_id, "publishable": publishable}, db=db,
            )
        return self.get(practice_id, rule_id)

    def proposals(self, practice_id: str) -> list[PracticeRule]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM physician_referral_preferences WHERE practice_id = ? AND scope = 'practice' "
                "AND operational_status = 'inferred' ORDER BY created_at DESC",
                (practice_id,),
            ).fetchall()
        return [_row_to_rule(dict(row)) for row in rows]

    def history(self, practice_id: str, rule_id: str) -> list[PracticeRule]:
        """Full lineage: walk supersedes_id backwards and successors forwards."""
        all_rules = {rule.id: rule for rule in self.list(practice_id, include_history=True)}
        if rule_id not in all_rules:
            raise RuleNotFoundError(rule_id)
        lineage = [all_rules[rule_id]]
        while lineage[0].supersedes_id and lineage[0].supersedes_id in all_rules:
            lineage.insert(0, all_rules[lineage[0].supersedes_id])
        successors = {rule.supersedes_id: rule for rule in all_rules.values() if rule.supersedes_id}
        while lineage[-1].id in successors:
            lineage.append(successors[lineage[-1].id])
        return lineage


def rules_snapshot(rules: list[PracticeRule]) -> tuple[str, dict]:
    """A content-addressed snapshot of exactly the rule versions triage used."""
    entries = [
        {
            "rule_id": rule.id,
            "version": rule.version,
            "referral_type": rule.referral_type,
            "operational_status": rule.operational_status,
            "physician_confirmed": rule.physician_confirmed,
            "content": rule.content.model_dump(mode="json"),
        }
        for rule in sorted(rules, key=lambda item: (item.id, item.version))
    ]
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()[:16]
    return f"rs_{digest}", {"rules": entries}
