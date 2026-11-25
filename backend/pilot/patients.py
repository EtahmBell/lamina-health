"""Basic patient identity (run 3): one record per patient per practice; referrals link to it.

Matching only SUGGESTS possible duplicates for staff to confirm -- on name and date of birth, plus
phone and MRN when present. Nothing is ever merged automatically. A merge moves the merged
record's referrals onto the surviving record and marks the merged one; it is recorded in
`patient_merges` (append-only) with exactly which referrals moved, so an unmerge puts them back.
Both are pilot events. Every query is scoped to the practice.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .practice import PilotError, PracticeContext
from .store import (
    PilotStore,
    new_id,
    now_iso,
)

_NOISE = re.compile(r"\b(synthetic|mr|mrs|ms|miss|dr|jr|sr|ii|iii)\b\.?", re.IGNORECASE)


def name_tokens(name: str) -> list[str]:
    """"Rivera, Morgan" and "MORGAN RIVERA" give the same tokens; hyphens split surnames."""
    text = name.strip()
    if "," in text:
        last, _, first = text.partition(",")
        text = f"{first} {last}"
    text = _NOISE.sub(" ", text.casefold())
    return [token for token in re.split(r"[^a-z0-9']+", text) if token]


def name_key(name: str) -> str:
    return " ".join(sorted(name_tokens(name)))


def digits(value: str | None) -> str | None:
    found = re.sub(r"\D", "", value or "")
    return found[-10:] if len(found) >= 7 else None


class PatientService:
    def __init__(self, store: PilotStore) -> None:
        self.store = store

    # -------------------------------------------------------------------- records

    def create(self, practice_id: str, actor: str, *, name: str, date_of_birth: str | None = None,
               phone: str | None = None, mrn: str | None = None, db: Any = None) -> str:
        patient_id = new_id("pat")
        now = now_iso()
        statement = ("INSERT INTO patients (id, practice_id, name, name_key, date_of_birth, phone_digits, mrn, merged_into_id, "
                     "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
        values = (patient_id, practice_id, " ".join(name.split())[:200], name_key(name), date_of_birth,
                  digits(phone), (mrn or "").strip().upper() or None, actor, now, now)
        if db is not None:
            db.execute(statement, values)
        else:
            self.store.execute([(statement, values)])
        return patient_id

    def _row(self, practice_id: str, patient_id: str) -> dict:
        row = self.store.fetch_one("SELECT * FROM patients WHERE practice_id = ? AND id = ?", (practice_id, patient_id))
        if not row:
            raise PilotError("patient_not_found", "Patient not found", 404)
        return row

    def resolve(self, practice_id: str, patient_id: str) -> str:
        """Follow merges to the surviving record."""
        seen = set()
        current = patient_id
        while current and current not in seen:
            seen.add(current)
            row = self._row(practice_id, current)
            if not row["merged_into_id"]:
                return current
            current = row["merged_into_id"]
        return current

    @staticmethod
    def view(row: dict) -> dict:
        return {"id": row["id"], "name": row["name"], "date_of_birth": row["date_of_birth"],
                "phone_last4": (row["phone_digits"] or "")[-4:] or None, "mrn": row["mrn"],
                "merged_into_id": row["merged_into_id"], "created_at": row["created_at"]}

    # ------------------------------------------------------------------- matching

    def candidates(self, practice_id: str, *, name: str | None, date_of_birth: str | None = None,
                   phone: str | None = None, mrn: str | None = None, exclude: str | None = None,
                   limit: int = 5) -> list[dict]:
        """Possible matches with the reasons, strongest first. Suggestions only."""
        tokens = set(name_tokens(name or ""))
        key = " ".join(sorted(tokens))
        phone_digits, mrn_value = digits(phone), (mrn or "").strip().upper() or None
        rows = self.store.fetch_all(
            "SELECT * FROM patients WHERE practice_id = ? AND merged_into_id IS NULL AND id <> ? AND "
            "(date_of_birth = ? OR name_key = ? OR (phone_digits IS NOT NULL AND phone_digits = ?) OR (mrn IS NOT NULL AND mrn = ?))",
            (practice_id, exclude or "", date_of_birth or "", key or "~no-name~", phone_digits or "~no-phone~", mrn_value or "~no-mrn~"))
        found = []
        for row in rows:
            reasons = []
            other = set(row["name_key"].split())
            same_name = bool(key) and row["name_key"] == key
            shared = tokens & other
            same_dob = bool(date_of_birth) and row["date_of_birth"] == date_of_birth
            if same_name:
                reasons.append("same name")
            elif shared:
                reasons.append("shares part of the name")
            if same_dob:
                reasons.append("same date of birth")
            if phone_digits and row["phone_digits"] == phone_digits:
                reasons.append("same phone")
            if mrn_value and row["mrn"] == mrn_value:
                reasons.append("same MRN")
            if mrn_value and row["mrn"] == mrn_value or (same_name and same_dob):
                strength = "strong"
            elif same_dob and shared or ("same phone" in reasons and shared) or (same_name and not date_of_birth):
                strength = "possible"
            else:
                continue
            found.append({"patient": self.view(row), "strength": strength, "reasons": reasons})
        found.sort(key=lambda item: (item["strength"] != "strong", -len(item["reasons"])))
        return found[:limit]

    def detail(self, context: PracticeContext, patient_id: str) -> dict:
        row = self._row(context.practice_id, patient_id)
        referrals = self.store.fetch_all(
            "SELECT id, referral_type, status, received_at FROM intake_referrals WHERE practice_id = ? AND patient_id = ? "
            "ORDER BY received_at DESC", (context.practice_id, patient_id))
        merges = [self._merge_view(item) for item in self.store.fetch_all(
            "SELECT * FROM patient_merges WHERE practice_id = ? AND (survivor_id = ? OR merged_id = ?) ORDER BY created_at DESC",
            (context.practice_id, patient_id, patient_id))]
        undone = {item["reverses_id"] for item in merges if item["action"] == "unmerge"}
        for item in merges:
            item["undone"] = item["id"] in undone
        duplicates = [] if row["merged_into_id"] else self.candidates(
            context.practice_id, name=row["name"], date_of_birth=row["date_of_birth"],
            phone=row["phone_digits"], mrn=row["mrn"], exclude=patient_id)
        return {"patient": self.view(row), "referrals": referrals, "possible_duplicates": duplicates, "merges": merges}

    @staticmethod
    def _merge_view(row: dict) -> dict:
        return {"id": row["id"], "action": row["action"], "survivor_id": row["survivor_id"], "merged_id": row["merged_id"],
                "referral_ids": json.loads(row["referral_ids_json"]), "reverses_id": row["reverses_id"],
                "reason": row["reason"], "actor": row["actor"], "created_at": row["created_at"]}

    # -------------------------------------------------------------- merge / unmerge

    def merge(self, context: PracticeContext, survivor_id: str, merged_id: str, reason: str | None) -> dict:
        """A person confirmed these are the same patient. Reversible (see `unmerge`)."""
        if survivor_id == merged_id:
            raise PilotError("same_patient", "Choose two different patient records", 422)
        survivor, merged = self._row(context.practice_id, survivor_id), self._row(context.practice_id, merged_id)
        if survivor["merged_into_id"] or merged["merged_into_id"]:
            raise PilotError("already_merged", "One of these records was already merged", 409)
        moved = [row["id"] for row in self.store.fetch_all(
            "SELECT id FROM intake_referrals WHERE practice_id = ? AND patient_id = ?", (context.practice_id, merged_id))]
        merge_id, now = new_id("pmg"), now_iso()
        statements = [
            ("UPDATE patients SET merged_into_id = ?, updated_at = ? WHERE id = ? AND practice_id = ? AND merged_into_id IS NULL",
             (survivor_id, now, merged_id, context.practice_id)),
            (("INSERT INTO patient_merges (id, practice_id, action, survivor_id, merged_id, referral_ids_json, reverses_id, "
             "reason, actor, actor_role, created_at) VALUES (?, ?, 'merge', ?, ?, ?, NULL, ?, ?, ?, ?)"),
             (merge_id, context.practice_id, survivor_id, merged_id, json.dumps(moved), (reason or "").strip()[:500] or None,
              context.actor, context.role, now)),
            *[("UPDATE intake_referrals SET patient_id = ? WHERE id = ? AND practice_id = ?", (survivor_id, rid, context.practice_id))
              for rid in moved],
        ]
        if not self.store.execute(statements, events=[{
                "event_type": "patient_merged", "actor": context.actor, "practice_id": context.practice_id,
                "metadata": {"merge_id": merge_id, "survivor_id": survivor_id, "merged_id": merged_id,
                             "referral_count": len(moved), "role": context.role}}]):
            raise PilotError("already_merged", "One of these records was already merged", 409)
        return self.detail(context, survivor_id)

    def unmerge(self, context: PracticeContext, merge_id: str, reason: str | None = None) -> dict:
        row = self.store.fetch_one("SELECT * FROM patient_merges WHERE practice_id = ? AND id = ? AND action = 'merge'",
                                   (context.practice_id, merge_id))
        if not row:
            raise PilotError("merge_not_found", "Merge not found", 404)
        if self.store.fetch_one("SELECT id FROM patient_merges WHERE reverses_id = ?", (merge_id,)):
            raise PilotError("already_unmerged", "This merge was already undone", 409)
        moved = json.loads(row["referral_ids_json"])
        undo_id, now = new_id("pmg"), now_iso()
        statements = [
            ("UPDATE patients SET merged_into_id = NULL, updated_at = ? WHERE id = ? AND practice_id = ? AND merged_into_id = ?",
             (now, row["merged_id"], context.practice_id, row["survivor_id"])),
            (("INSERT INTO patient_merges (id, practice_id, action, survivor_id, merged_id, referral_ids_json, reverses_id, "
             "reason, actor, actor_role, created_at) VALUES (?, ?, 'unmerge', ?, ?, ?, ?, ?, ?, ?, ?)"),
             (undo_id, context.practice_id, row["survivor_id"], row["merged_id"], json.dumps(moved), merge_id,
              (reason or "").strip()[:500] or None, context.actor, context.role, now)),
            # Only referrals still on the surviving record go back (one moved since stays where it is).
            *[("UPDATE intake_referrals SET patient_id = ? WHERE id = ? AND practice_id = ? AND patient_id = ?",
               (row["merged_id"], rid, context.practice_id, row["survivor_id"])) for rid in moved],
        ]
        if not self.store.execute(statements, events=[{
                "event_type": "patient_unmerged", "actor": context.actor, "practice_id": context.practice_id,
                "metadata": {"merge_id": merge_id, "unmerge_id": undo_id, "survivor_id": row["survivor_id"],
                             "merged_id": row["merged_id"], "referral_count": len(moved), "role": context.role}}]):
            raise PilotError("already_unmerged", "This merge can't be undone (the record changed since)", 409)
        return self.detail(context, row["merged_id"])
