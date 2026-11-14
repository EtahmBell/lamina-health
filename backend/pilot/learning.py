"""Learning from corrections: single correction → evidence; repeated similar
correction → proposed learning; meaningful pattern → at most one proactive question
per day. Nothing becomes operational without a physician answer.

Detected patterns (deliberately few, each maps cleanly onto a rule field):
* modality: the team changed the suggested modality to the same value for the same
  referral type at least twice → propose that default modality.
* required item: the team requested the same extra item (not flagged by triage) for
  the same referral type at least twice → propose it as a required item.
* optional item (Step 17): the physician ACCEPTED at least three referrals of a type while
  the same required item was still missing → ask whether it should be optional.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from .models import PracticeRuleInput
from .practice import PilotError, PracticeContext
from .rules import PracticeRules, normalize_referral_type
from .store import PilotStore, new_id, now_iso
from .teaching import TeachingService
from .triage import _tokens

REPEAT_THRESHOLD = 2
ACCEPTED_WITHOUT_THRESHOLD = 3
QUESTION_INTERVAL = timedelta(hours=24)
MODALITY_WORDS = {"econsult": "eConsult", "in_person": "an in-person visit", "either": "either modality"}


class LearningService:
    def __init__(self, store: PilotStore, rules: PracticeRules, teaching: TeachingService) -> None:
        self.store = store
        self.rules = rules
        self.teaching = teaching

    # --------------------------------------------------------------- detection

    def _referral_types(self, practice_id: str) -> dict[str, str]:
        return {row["id"]: row["referral_type"] for row in self.store.fetch_all(
            "SELECT id, referral_type FROM intake_referrals WHERE practice_id = ?", (practice_id,))}

    def _patterns(self, practice_id: str) -> list[dict]:
        types = self._referral_types(practice_id)
        groups: dict[str, dict] = {}
        # Physician signals only: corrections (current model) and physician edits from the retired
        # approval step. A staff review was never physician agreement or correction.
        modality_changes = [
            ({"decision_id": row["id"]}, row["referral_id"], json.loads(row["changed_fields_json"]).get("suggested_modality"))
            for row in self.store.fetch_all(
                "SELECT * FROM recommendation_decisions WHERE practice_id = ? AND decision = 'edited' "
                "AND actor_role = 'physician'", (practice_id,))
        ] + [
            ({"correction_id": row["id"]}, row["referral_id"], {"from": json.loads(row["from_value"]), "to": json.loads(row["to_value"])})
            for row in self.store.fetch_all(
                "SELECT * FROM triage_corrections WHERE practice_id = ? AND field = 'suggested_modality'", (practice_id,))
        ]
        for ref, referral_id, change in modality_changes:
            referral_type = types.get(referral_id)
            if not change or not referral_type or change["to"] not in MODALITY_WORDS:
                continue
            signature = f"modality:{normalize_referral_type(referral_type)}:{change['to']}"
            group = groups.setdefault(signature, {"kind": "modality", "referral_type": referral_type,
                                                  "value": change["to"], "evidence": []})
            if any(item["referral_id"] == referral_id for item in group["evidence"]):
                continue  # one referral is one piece of evidence, however many times it was corrected
            group["evidence"].append({**ref, "referral_id": referral_id})
        extra = defaultdict(list)
        for event in self.store.events(practice_id=practice_id, event_type="information_requested"):
            referral_type = types.get(event["referral_id"] or "")
            for label in event["metadata"].get("extra_items", []):
                if referral_type and _tokens(label):
                    key = "_".join(sorted(_tokens(label)))[:80]
                    extra[(normalize_referral_type(referral_type), key)].append((referral_type, label, event["referral_id"]))
        for (type_key, item_key), hits in extra.items():
            if len({hit[2] for hit in hits}) < REPEAT_THRESHOLD:
                continue
            groups[f"required:{type_key}:{item_key}"] = {
                "kind": "required", "referral_type": hits[0][0], "value": hits[0][1],
                "evidence": [{"referral_id": hit[2]} for hit in hits],
            }
        groups.update(self._accepted_without(practice_id, types))
        return [{**group, "signature": signature} for signature, group in groups.items()
                if len({item["referral_id"] for item in group["evidence"]})
                >= (ACCEPTED_WITHOUT_THRESHOLD if group["kind"] == "optional" else REPEAT_THRESHOLD)]

    def _accepted_without(self, practice_id: str, types: dict[str, str]) -> dict[str, dict]:
        """Accepted referrals whose recommendation still listed a required item as missing."""
        groups: dict[str, dict] = {}
        for event in self.store.events(practice_id=practice_id, event_type="referral_accepted"):
            referral = self.store.referral_row(practice_id, event["referral_id"] or "")
            if not referral or not referral["current_recommendation_id"]:
                continue
            row = self.store.recommendation_row(practice_id, referral["current_recommendation_id"])
            if not row:
                continue
            recommendation = json.loads(row["recommendation_json"])
            for item in recommendation.get("requirements", []):
                if item.get("required") and item.get("state") != "satisfied":
                    signature = f"optional:{normalize_referral_type(types[referral['id']])}:{item['key']}"
                    group = groups.setdefault(signature, {"kind": "optional", "referral_type": types[referral["id"]],
                                                          "value": item["key"], "label": item["label"], "evidence": []})
                    if referral["id"] not in {entry["referral_id"] for entry in group["evidence"]}:
                        group["evidence"].append({"referral_id": referral["id"]})
        return groups

    def _already_true(self, practice_id: str, pattern: dict) -> bool:
        for rule in self.rules.operational(practice_id, pattern["referral_type"]):
            if pattern["kind"] == "modality" and rule.content.modality == pattern["value"]:
                return True
            if pattern["kind"] == "required" and any(
                _tokens(item.label) == _tokens(pattern["value"]) for item in rule.content.required
            ):
                return True
        if pattern["kind"] == "optional":
            # Already optional (or no longer required) for this type: nothing to ask.
            return not any(item.key == pattern["value"] for rule in self.rules.operational(practice_id, pattern["referral_type"])
                           for item in rule.content.required)
        return False

    def detect(self, context: PracticeContext) -> list[dict]:
        """Idempotent: each pattern signature is proposed/asked at most once."""
        created = []
        for pattern in self._patterns(context.practice_id):
            if self.store.fetch_one(
                "SELECT 1 FROM learning_questions WHERE practice_id = ? AND signature = ?",
                (context.practice_id, pattern["signature"]),
            ) or self._already_true(context.practice_id, pattern):
                continue
            count = len({item["referral_id"] for item in pattern["evidence"]})
            if pattern["kind"] == "modality":
                content = {"good_fit": [], "outside_scope": [], "required": [], "helpful": [], "urgent_signals": [],
                           "modality": pattern["value"], "note": None}
                question = (f"You’ve changed {pattern['referral_type']} referrals to {MODALITY_WORDS[pattern['value']]} "
                            f"{count} times. Should I treat {MODALITY_WORDS[pattern['value']]} as your default for this type?")
                text = f"Default modality for {pattern['referral_type']}: {pattern['value']} (from {count} corrections)"
            elif pattern["kind"] == "optional":
                content = {"good_fit": [], "outside_scope": [], "required": [], "helpful": [], "urgent_signals": [],
                           "modality": "unspecified", "note": None, "make_optional": [pattern["value"]],
                           "answered_topics": ["requirements"]}
                question = (f"You accepted {count} {pattern['referral_type']} referrals without "
                            f"“{pattern['label']}”. Should it be optional (helpful, not required) for this type?")
                text = f"Make {pattern['label']} optional for {pattern['referral_type']} (from {count} acceptances)"
            else:
                label = pattern["value"][:1].upper() + pattern["value"][1:]
                key = "_".join(sorted(_tokens(label)))[:80]
                content = {"good_fit": [], "outside_scope": [], "urgent_signals": [], "helpful": [],
                           "required": [{"key": key, "label": label, "required": True, "freshness_days": None}],
                           "modality": "unspecified", "note": None}
                question = (f"You’ve asked for “{label}” on {count} {pattern['referral_type']} referrals. "
                            "Should I treat it as required before review?")
                text = f"Require {label} for {pattern['referral_type']} (from {count} corrections)"
            question_id = new_id("lq")
            proposal = self.teaching.propose(
                context, text, source="correction_pattern",
                interpretation={"referral_type": pattern["referral_type"], "content": content, "structured": True,
                                "confidence": min(0.9, 0.5 + 0.1 * count), "clarification": None,
                                "interpreter": "correction_pattern"},
                extra_provenance={"evidence": pattern["evidence"], "signature": pattern["signature"],
                                  "question_id": question_id},
            )
            self.store.execute([(
                ("INSERT INTO learning_questions (id, practice_id, proposal_rule_id, signature, question, "
                "evidence_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"),
                (question_id, context.practice_id, proposal["id"], pattern["signature"], question,
                 json.dumps(pattern["evidence"]), now_iso()),
            )])
            created.append(proposal)
        return created

    def on_decision(self, context: PracticeContext, _referral_id: str) -> None:
        if context.role in {"physician", "staff"}:
            self.detect(context)

    # --------------------------------------------------------------- questions

    def question_for_today(self, practice_id: str, *, mark_shown: bool, actor: str = "agent:learning") -> dict | None:
        rows = self.store.fetch_all(
            "SELECT * FROM learning_questions WHERE practice_id = ? ORDER BY created_at", (practice_id,))
        cutoff = (datetime.now(UTC) - QUESTION_INTERVAL).isoformat(timespec="seconds")
        recent = [row for row in rows if (row["last_shown_at"] and row["last_shown_at"] > cutoff)
                  or (row["answered_at"] and row["answered_at"] > cutoff)]
        if recent:
            current = next((row for row in recent if row["status"] == "pending"), None)
            return self._question_view(current) if current else None
        pending = [row for row in rows if row["status"] == "pending"]
        if not pending:
            return None
        chosen = max(pending, key=lambda row: len(json.loads(row["evidence_json"])))
        if mark_shown:
            self.store.execute(
                [("UPDATE learning_questions SET last_shown_at = ? WHERE id = ?", (now_iso(), chosen["id"]))],
                [{"event_type": "learning_question_shown", "actor": actor, "autonomy": "automatic",
                  "practice_id": practice_id, "metadata": {"question_id": chosen["id"], "signature": chosen["signature"]}}],
            )
        return self._question_view(chosen)

    @staticmethod
    def _question_view(row: dict) -> dict:
        return {"id": row["id"], "question": row["question"], "proposal_id": row["proposal_rule_id"],
                "evidence_count": len(json.loads(row["evidence_json"])), "status": row["status"],
                "created_at": row["created_at"]}

    def answer(self, context: PracticeContext, question_id: str, answer: str, note: str | None,
               edits: PracticeRuleInput | None) -> dict:
        context.require_physician("answer the practice agent's question")
        row = self.store.fetch_one(
            "SELECT * FROM learning_questions WHERE id = ? AND practice_id = ?", (question_id, context.practice_id))
        if not row:
            raise PilotError("question_not_found", "Question not found", 404)
        if row["status"] != "pending":
            raise PilotError("question_answered", "This question has already been answered")
        result: dict = {}
        if answer == "yes":
            result = self.teaching.confirm(context, row["proposal_rule_id"])
            status = "confirmed"
        elif answer == "edit":
            if edits is None:
                raise PilotError("edits_required", "Provide the edited rule", 422)
            result = self.teaching.confirm(context, row["proposal_rule_id"], edits)
            status = "edited"
        elif answer in {"depends", "ignore"}:
            result = self.teaching.reject(context, row["proposal_rule_id"], note or answer)
            # Stored statuses are 'depends' / 'ignored' (the table's CHECK constraint).
            status = "ignored" if answer == "ignore" else answer
        else:
            raise PilotError("invalid_answer", "Answer yes, edit, depends, or ignore", 422)
        self.store.execute([(
            ("UPDATE learning_questions SET status = ?, answer_note = ?, answered_by = ?, answered_at = ? "
            "WHERE id = ? AND status = 'pending'"),
            (status, (note or "").strip()[:1000] or None, context.actor, now_iso(), question_id),
        )], [{"event_type": "learning_question_answered", "actor": context.actor, "practice_id": context.practice_id,
              "metadata": {"question_id": question_id, "answer": answer}}])
        return {"question": self._question_view({**row, "status": status}), **result}

