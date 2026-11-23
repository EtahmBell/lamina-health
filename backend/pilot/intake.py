"""Inbound referral intake: creation, documents, triage, review actions, disposition.

All state changes go through `_transition`, which validates against the explicit
status machine and applies the change with an optimistic status check in one
transaction together with its decision row and pilot events. Model output never
moves a referral by itself: triage only produces a recommendation. There is no separate
approval step: the physician's accept / redirect / decline IS the sign-off on the triage.
Before deciding, the physician may correct fit, priority or visit type (each correction is
recorded with actor and role). Staff do the paperwork: request information, verify what
arrives, and mark a referral ready for the physician or flag it.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, date, datetime
from typing import Any

from .attribution import ActorDirectory
from .documents import (
    DocumentRejectedError,
    DocumentStorage,
    LocalDocumentStorage,
    extract_pages,
    safe_filename,
    sha256_hex,
    validate_document,
)
from .models import (
    EDITABLE_TRIAGE_FIELDS,
    TERMINAL_STATUSES,
    DispositionInput,
    IntakeReferral,
    IntakeReferralInput,
    IntakeStatus,
    RecordItemInput,
    ReferralDocument,
    RequestInformationInput,
    SubmittedItem,
    TriageEditInput,
    TriageRecommendation,
    item_verified,
)
from .practice import PilotError, PracticeContext
from .rationale import rationale_view
from .rules import PracticeRules
from .standing import referral_standing
from .store import PilotStore, hash_token, new_id, now_iso
from .triage import DocumentText, EvidenceExtractor, default_extractor, triage_referral
from .voice import Voice

S = IntakeStatus
ALLOWED_TRANSITIONS: dict[IntakeStatus, frozenset[IntakeStatus]] = {
    S.RECEIVED: frozenset({S.TRIAGED, S.DECLINED, S.REDIRECTED}),
    S.TRIAGED: frozenset({S.NEEDS_INFORMATION, S.READY_FOR_REVIEW, S.ACCEPTED, S.REDIRECTED, S.DECLINED}),
    S.NEEDS_INFORMATION: frozenset({S.READY_FOR_REVIEW, S.ACCEPTED, S.REDIRECTED, S.DECLINED}),
    S.READY_FOR_REVIEW: frozenset({S.NEEDS_INFORMATION, S.ACCEPTED, S.REDIRECTED, S.DECLINED}),
    S.ACCEPTED: frozenset(),
    S.REDIRECTED: frozenset(),
    S.DECLINED: frozenset(),
}
DISPOSITION_STATUS = {"accept": S.ACCEPTED, "redirect": S.REDIRECTED, "decline": S.DECLINED}
# The clinical parts of a recommendation. A change to one of these is shown to the physician
# ("Changed since you last looked"). Readiness, missing items, evidence and next step are
# workflow progress, not a new clinical recommendation.
MATERIAL_TRIAGE_FIELDS = ("fit", "suggested_priority", "suggested_modality", "requires_physician")
# What a physician may correct before deciding. Staff never change these.
CORRECTABLE_FIELDS = ("fit", "suggested_priority", "suggested_modality")
# Events that change the clinical triage, for the "changed since you last looked" note.
CHANGE_EVENTS = {"recommendation_changed", "recommendation_changed_after_approval", "triage_corrected"}
APPROVAL_REMOVED = (
    "Triage no longer needs a separate approval. The physician's accept, redirect or decline is the "
    "sign-off; staff can mark the referral ready for the physician or flag it")


def material_changes(previous: TriageRecommendation, current: TriageRecommendation) -> dict[str, dict]:
    changes = {
        field: {"from": getattr(previous, field), "to": getattr(current, field)}
        for field in MATERIAL_TRIAGE_FIELDS
        if getattr(previous, field) != getattr(current, field)
    }
    # Recommendations made before Step 16 carry no type_match; only compare when both do.
    if previous.type_match is not None and current.type_match is not None:
        before, after = previous.type_match.get("rule_type"), current.type_match.get("rule_type")
        if before != after:
            changes["rule_type"] = {"from": before, "to": after}
    return changes


def nonmaterial_changes(previous: TriageRecommendation, current: TriageRecommendation) -> dict[str, dict]:
    fields = ("readiness", "next_step", "missing_items", "rules_snapshot_id")
    return {
        field: {"from": getattr(previous, field), "to": getattr(current, field)}
        for field in fields if getattr(previous, field) != getattr(current, field)
    }
DISPOSITION_EVENT = {
    "accept": "referral_accepted", "redirect": "referral_redirected", "decline": "referral_declined",
}


def can_transition(current: IntakeStatus, target: IntakeStatus) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def _parse_received_at(value: str | None) -> str:
    if not value:
        return now_iso()
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise PilotError("invalid_received_at", "Received date must be an ISO date or time", 422) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    if parsed > datetime.now(UTC):
        raise PilotError("invalid_received_at", "Received date cannot be in the future", 422)
    return parsed.astimezone(UTC).isoformat(timespec="seconds")


class IntakeService:
    def __init__(
        self,
        store: PilotStore,
        storage: DocumentStorage | None = None,
        extractor: EvidenceExtractor | None | bool = True,
        today: date | None = None,
    ) -> None:
        self.store = store
        self.rules = PracticeRules(store)
        self._storage = storage
        # `True` means "use the configured default" (off unless explicitly enabled).
        self._extractor = extractor
        self._today = today
        # Wired by PilotServices: missing-info reconciliation, correction learning, etc.
        self.after_triage: list[Any] = []
        self.after_decision: list[Any] = []
        self.request_projection: Any = None
        self.representation: Any = None  # RepresentationService, wired by PilotServices
        self.detail_extensions: list[Any] = []

    @property
    def storage(self) -> DocumentStorage:
        if self._storage is None:
            self._storage = LocalDocumentStorage()
        return self._storage

    def _resolved_extractor(self) -> EvidenceExtractor | None:
        if self._extractor is True:
            return default_extractor()
        return self._extractor or None

    # -------------------------------------------------------------- projection

    def _document(self, row: dict) -> ReferralDocument:
        return ReferralDocument(
            id=row["id"], referral_id=row["referral_id"], filename=row["filename"],
            content_type=row["content_type"], size_bytes=row["size_bytes"], sha256=row["sha256"],
            uploaded_by=row["uploaded_by"], uploaded_at=row["uploaded_at"],
            extraction_status=row["extraction_status"], page_count=row["page_count"],
        )

    def _referral(self, row: dict) -> IntakeReferral:
        return IntakeReferral(
            id=row["id"],
            practice_id=row["practice_id"],
            source=row["source"],
            status=row["status"],
            sender=json.loads(row["sender_json"]),
            receiver_practice_id=row["practice_id"],
            patient=json.loads(row["patient_json"]),
            referral_type=row["referral_type"],
            reason=row["reason"],
            clinical_context=row["clinical_context"],
            sender_priority=row["sender_priority"],
            submitted_items=json.loads(row["submitted_items_json"] or "[]"),
            received_at=row["received_at"],
            entered_at=row["entered_at"],
            entered_by=row["entered_by"],
            submitted_referral_type=row.get("submitted_referral_type"),
            current_recommendation_id=row["current_recommendation_id"],
            review=json.loads(row["review_json"]) if row["review_json"] else None,
            escalated_at=row["escalated_at"],
            escalated_by=row["escalated_by"],
            escalation_note=row["escalation_note"],
            information_request=(
                json.loads(row["information_request_json"]) if row["information_request_json"] else None
            ),
            disposition=json.loads(row["disposition_json"]) if row["disposition_json"] else None,
            handoff=json.loads(row["handoff_json"]) if row.get("handoff_json") else None,
            documents=[
                self._document(document)
                for document in self.store.document_rows(row["practice_id"], row["id"])
            ],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row(self, context: PracticeContext, referral_id: str) -> dict:
        row = self.store.referral_row(context.practice_id, referral_id)
        if not row:
            # Same response for "doesn't exist" and "belongs to another practice".
            raise PilotError("referral_not_found", "Referral not found", 404)
        return row

    def get(self, context: PracticeContext, referral_id: str) -> IntakeReferral:
        return self._referral(self._row(context, referral_id))

    def recommendation(self, practice_id: str, recommendation_id: str | None) -> TriageRecommendation | None:
        if not recommendation_id:
            return None
        row = self.store.recommendation_row(practice_id, recommendation_id)
        return TriageRecommendation.model_validate_json(row["recommendation_json"]) if row else None

    def detail(self, context: PracticeContext, referral_id: str) -> dict:
        referral = self.get(context, referral_id)
        recommendation = self.recommendation(context.practice_id, referral.current_recommendation_id)
        snapshot = None
        if recommendation:
            row = self.store.recommendation_row(context.practice_id, recommendation.id)
            snapshot = json.loads(row["rules_snapshot_json"]) if row else None
        directory = ActorDirectory(self.store, context.practice_id)
        sender = referral.sender.model_dump(mode="json")
        history = []
        for event in self.store.events(practice_id=context.practice_id, referral_id=referral_id):
            # Chat audit rows are never part of a referral's clinical history.
            # Chat turns and the agent's own bookkeeping (what a capability prepared) are not part
            # of a referral's history; the draft it creates appears as the draft itself.
            if event["event_type"] in {"agent_conversation_turn", "agent_prepared_shadow", "agent_prepared_active"}:
                continue
            who = directory.describe(event["actor"], sender)
            history.append({
                "id": event["id"], "event_type": event["event_type"], "actor": event["actor"],
                "actor_name": who["name"], "actor_role": who["role"],
                "autonomy": event["autonomy"], "metadata": event["metadata"],
                "created_at": event["created_at"],
            })
        result = {
            "referral": referral.model_dump(mode="json"),
            "recommendation": recommendation.model_dump(mode="json") if recommendation else None,
            "rules_snapshot": snapshot,
            "physician_name": self.physician_name(context.practice_id, directory),
            # Reviews from the retired "approve triage" step, labelled honestly: a staff review is
            # never physician agreement. Only the physician's decision (signoff) is a sign-off.
            "legacy_review": self._legacy_review(referral, recommendation, directory),
            "corrections": [self._correction_view(row, directory) for row in
                            self.store.corrections(context.practice_id, referral_id)],
            "signoff": self._signoff_view(context.practice_id, referral_id, directory),
            "changes_since_seen": self._changes_since_seen(context, referral_id, history),
            # A physician's earlier correction that a NEWER rule version now disagrees with.
            "correction_conflicts": [
                {**item, "corrected_by_name": directory.describe(item["corrected_by"])["name"] if item["corrected_by"] else None,
                 "rule_by_name": directory.describe(item["rule_by"])["name"] if item["rule_by"] else None,
                 "corrected_by_you": item["corrected_by"] == context.actor, "rule_by_you": item["rule_by"] == context.actor}
                for item in self._correction_conflicts(referral, recommendation)],
            "effective_triage": self._effective(recommendation, referral),
            "history": history,
            "allowed_actions": self.allowed_actions(context, referral, recommendation),
        }
        for extend in self.detail_extensions:
            result.update(extend(context, referral_id))
        self._name_actors(result, referral, directory, sender)
        voice = Voice.for_context(context, result["physician_name"])
        if result["recommendation"]:
            # Display text rendered from structured rationale for THIS reader (never a rewrite).
            result["recommendation"]["rationale"] = [rationale_view(item, voice) for item in result["recommendation"]["rationale"]]
        requests = result.get("information_requests") or []
        result["standing"] = referral_standing(
            status=referral.status, recommendation=result["recommendation"],
            next_step=(result["effective_triage"] or {}).get("next_step"), requests=requests, voice=voice)
        self._summarize_history(result, requests)
        result["office_notification"] = self._office_notification(context, referral, result, directory, voice)
        return result

    @staticmethod
    def _summarize_history(result: dict, requests: list[dict]) -> None:
        """Information-request and reply events say what was asked or sent, so the history
        names the items next to the named actor."""
        by_request = {request["id"]: request for request in requests}
        labels = {item["key"]: item["label"] for item in (result.get("recommendation") or {}).get("requirements", [])}
        for event in result["history"]:
            metadata = event.get("metadata") or {}
            if event["event_type"] in {"missing_information_request_created", "missing_information_request_sent"}:
                request = by_request.get(metadata.get("request_id") or "")
                if request:
                    asked = ", ".join(item["label"] for item in request.get("items", []))
                    sent_via = metadata.get("sent_via") or ""
                    via = ("sent outside Lamina by fax/email" if sent_via == "manual"
                           else f"emailed through {sent_via}" if sent_via else "")
                    event["summary"] = f"Asked for {asked}" + (f" · {via}" if via and event["event_type"].endswith("_sent") else "")
            elif event["event_type"] == "sender_response_received":
                keys = metadata.get("item_keys") or []
                sent = ", ".join(labels.get(key, key.replace("_", " ")) for key in keys)
                event["summary"] = (f"Sent {sent}" if sent else "Sent a message") + (" with a message" if sent and metadata.get("has_message") else "")
            elif event["event_type"] == "referring_office_notified":
                event["summary"] = "Marked as sent to the referring office (outside Lamina)"

    def _office_notification(self, context: PracticeContext, referral: IntakeReferral, result: dict,
                             directory: ActorDirectory, voice: Voice) -> dict | None:
        """Decline / redirect: has anyone told the referring office? Lamina never sends this; a
        person sends it outside Lamina and marks it sent. A draft is offered to copy."""
        disposition = referral.disposition or {}
        if referral.status not in {IntakeStatus.DECLINED.value, IntakeStatus.REDIRECTED.value} or not disposition:
            return None
        sent = [event for event in result["history"] if event["event_type"] == "referring_office_notified"]
        if sent:
            last = sent[-1]
            return {"state": "sent", "by_name": last["actor_name"], "at": last["created_at"], "draft": None}
        doctor = result["physician_name"] or "The physician"
        patient = referral.patient.name
        try:
            received = datetime.fromisoformat(referral.received_at).strftime("%b %d, %Y").replace(" 0", " ")
        except (TypeError, ValueError):
            received = (referral.received_at or "")[:10]
        reason = (disposition.get("reason") or "").strip().rstrip(".")
        if referral.status == IntakeStatus.REDIRECTED.value:
            body = (f"{doctor} has reviewed the {referral.referral_type} referral for {patient} (received {received}) "
                    f"and recommends redirecting it to {disposition.get('redirect_to') or 'another service'}."
                    + (f" Reason: {reason}." if reason else ""))
        else:
            body = (f"{doctor} has reviewed the {referral.referral_type} referral for {patient} (received {received}) "
                    "and is unable to accept it." + (f" Reason: {reason}." if reason else ""))
        practice = context.practice.get("name") or "the practice"
        draft = (f"To: {referral.sender.name}{', ' + referral.sender.practice if referral.sender.practice else ''}\n"
                 f"Re: Referral for {patient}\n\n{body}\n\nPlease contact {practice} with any questions.")
        return {"state": "not_sent", "by_name": None, "at": None, "draft": draft}

    def mark_office_notified(self, context: PracticeContext, referral_id: str) -> dict:
        """Records that a person told the referring office about the decline / redirect outside
        Lamina. Nothing is sent from here."""
        row = self._row(context, referral_id)
        if row["status"] not in {IntakeStatus.DECLINED.value, IntakeStatus.REDIRECTED.value}:
            raise PilotError("not_closed", "Only a declined or redirected referral has a notice to send", 409)
        if self.store.events(practice_id=context.practice_id, referral_id=referral_id, event_type="referring_office_notified"):
            raise PilotError("already_notified", "The referring office was already marked as notified", 409)
        self.store.append_event("referring_office_notified", actor=context.actor, practice_id=context.practice_id,
                                referral_id=referral_id, metadata={"role": context.role, "decision": row["status"],
                                                                   "sent_via": "outside_lamina"})
        return self.detail(context, referral_id)

    @staticmethod
    def _name_actors(result: dict, referral: IntakeReferral, directory: ActorDirectory, sender: dict) -> None:
        """Attribution names the person or office, never a generic "your team". Display only:
        stored recommendations keep their exact text."""
        office = directory.describe("sender:", sender)["name"]
        for request in result.get("information_requests") or []:
            for field in ("created_by", "approved_by"):
                if request.get(field):
                    request[f"{field}_name"] = directory.describe(request[field], sender)["name"]
        items = {item.key: item for item in referral.submitted_items}
        for requirement in (result.get("recommendation") or {}).get("requirements", []):
            item = items.get(requirement["key"])
            if item is None or not requirement.get("detail"):
                continue
            text = requirement["detail"]
            if item.verified_by:
                text = text.replace("verified by your team", f"verified by {directory.describe(item.verified_by, sender)['name']}")
            if item.recorded_by:
                recorder = directory.describe(item.recorded_by, sender)["name"]
                text = text.replace("entered by your team", f"entered by {recorder}").replace(
                    "recorded by your team", f"recorded by {recorder}")
            requirement["detail"] = text.replace("sent by the referring office", f"sent by {office}")

    @staticmethod
    def _effective(recommendation: TriageRecommendation | None, referral: IntakeReferral) -> dict | None:
        """The triage the team is working from: the agent's recommendation, plus the physician's
        corrections. A review from the retired approval step still applies as it did, except that
        a STAFF review never changes the clinical fields (fit, priority, visit type): staff can't
        set those any more, so an old staff edit is history, not the working triage."""
        if recommendation is None:
            return None
        effective = {field: getattr(recommendation, field) for field in EDITABLE_TRIAGE_FIELDS}
        review = referral.review or {}
        legacy = review.get("fields") or {}
        # Fields the physician handed back to the rule ("apply the rule") drop the old edit.
        cleared = set(review.get("cleared") or [])
        if legacy:
            if review.get("role") == "physician":
                # A physician's earlier edit of a clinical field is a correction: it persists.
                effective.update({key: value for key, value in legacy.items()
                                  if key in CORRECTABLE_FIELDS and key not in cleared})
            if review.get("recommendation_id") == recommendation.id:
                allowed = EDITABLE_TRIAGE_FIELDS if review.get("role") == "physician" else ("requires_physician",)
                effective.update({key: value for key, value in legacy.items()
                                  if key in allowed and key not in CORRECTABLE_FIELDS})
        effective.update(review.get("corrections") or {})
        return effective

    def physician_name(self, practice_id: str, directory: ActorDirectory | None = None) -> str | None:
        owner = self.representation.referral_physician(practice_id) if self.representation else None
        return (directory or ActorDirectory(self.store, practice_id)).physician_name(owner)

    def _legacy_review(
        self, referral: IntakeReferral, recommendation: TriageRecommendation | None, directory: ActorDirectory,
    ) -> dict | None:
        rows = self.store.decision_rows(referral.practice_id, referral.id)
        if not rows:
            return None
        row = rows[-1]
        who = directory.describe(row["actor"])
        return {
            "kind": "physician_review" if row["actor_role"] == "physician" else "staff_review",
            "decision": row["decision"], "changed_fields": row["changed_fields"], "reason": row["reason"],
            "actor_name": who["name"], "actor_role": row["actor_role"], "created_at": row["created_at"],
            "on_current_recommendation": bool(recommendation and self.store.effective_decision(recommendation.id)),
            "counts_as_physician_signoff": False,
        }

    @staticmethod
    def _correction_view(row: dict, directory: ActorDirectory) -> dict:
        return {"id": row["id"], "field": row["field"], "from": row["from_value"], "to": row["to_value"],
                "agent_value": row["agent_value"], "reason": row["reason"], "recommendation_id": row["recommendation_id"],
                "actor_name": directory.describe(row["actor"])["name"], "actor_role": row["actor_role"],
                "created_at": row["created_at"]}

    def _signoff_view(self, practice_id: str, referral_id: str, directory: ActorDirectory) -> dict | None:
        signoff = self.store.signoff(practice_id, referral_id)
        if not signoff:
            return None
        return {"id": signoff["id"], "decision": signoff["decision"], "recommendation_id": signoff["recommendation_id"],
                "representation_version_id": signoff["representation_version_id"],
                "corrections": signoff["corrections"], "actor_name": directory.describe(signoff["actor"])["name"],
                "actor_role": signoff["actor_role"], "created_at": signoff["created_at"]}

    def _changes_since_seen(self, context: PracticeContext, referral_id: str, history: list[dict]) -> list[dict]:
        """Clinical triage changes made by someone else (or Lamina) since this person last opened
        the referral. Nothing on a first visit: everything is new then."""
        seen = self.store.last_seen_event(referral_id, context.user_id)
        if seen is None:
            return []
        changes = []
        for event in history:
            if event["event_type"] not in CHANGE_EVENTS or event["id"] <= seen or event["actor"] == context.actor:
                continue
            metadata = event["metadata"]
            fields = metadata.get("changes") or metadata.get("changed_fields") or {}
            if not isinstance(fields, dict):
                continue
            cause = metadata.get("cause") or {}
            agent = event["actor_role"] == "lamina"
            trigger = metadata.get("requested_by_name") if agent else None
            for field, change in fields.items():
                changes.append({
                    "field": field, "from": change.get("from"), "to": change.get("to"),
                    # Who caused it (a rule's author), not merely who re-ran the check.
                    "by": cause.get("by_name") or event["actor_name"], "because": cause.get("text") if agent else None,
                    "triggered_by": trigger if (not cause or cause.get("trigger_differs")) else None,
                    "at": event["created_at"]})
        return changes

    # ------------------------------------------------- corrections vs newer rules

    def _correction_sources(self, referral: IntakeReferral) -> dict[str, dict]:
        """Clinical fields the physician has overridden, with the recommendation each override
        was made against: a correction, or a physician edit from the retired approval step."""
        review = referral.review or {}
        cleared = set(review.get("cleared") or [])
        sources: dict[str, dict] = {}
        legacy = review.get("fields") or {}
        if review.get("role") == "physician":
            for field in CORRECTABLE_FIELDS:
                if field in legacy and field not in cleared:
                    sources[field] = {"value": legacy[field], "recommendation_id": review.get("recommendation_id"),
                                      "by": review.get("by")}
        rows = self.store.corrections(referral.practice_id, referral.id)
        for field, value in (review.get("corrections") or {}).items():
            last = next((row for row in reversed(rows) if row["field"] == field), None)
            if last:
                sources[field] = {"value": value, "recommendation_id": last["recommendation_id"], "by": last["actor"]}
        return sources

    def _correction_conflicts(
        self, referral: IntakeReferral, recommendation: TriageRecommendation | None,
    ) -> list[dict]:
        """An override conflicts with the rule when a NEWER version of the rule now gives a value
        that differs both from what the agent said when the override was made and from the
        override itself. Closed referrals and choices already recorded for that version don't."""
        if recommendation is None or referral.status in TERMINAL_STATUSES:
            return []
        row = self.store.recommendation_row(referral.practice_id, recommendation.id)
        now_rules = (json.loads((row or {}).get("rules_snapshot_json") or "{}") or {}).get("rules", [])
        conflicts = []
        for field, source in self._correction_sources(referral).items():
            then_row = self.store.recommendation_row(referral.practice_id, source["recommendation_id"] or "")
            if not then_row:
                continue
            agent_then = json.loads(then_row["recommendation_json"]).get(field)
            agent_now = getattr(recommendation, field)
            if agent_now in {agent_then, source["value"]}:
                continue
            then_versions = {rule["referral_type"]: rule["version"]
                             for rule in (json.loads(then_row["rules_snapshot_json"] or "{}") or {}).get("rules", [])}
            newer = next((rule for rule in now_rules
                          if rule["version"] > then_versions.get(rule["referral_type"], 0)), None)
            if newer is None:
                continue  # the agent's value moved for another reason (new information), not a rule update
            done = self.store.fetch_one(
                "SELECT choice FROM correction_conflict_resolutions WHERE referral_id = ? AND field = ? "
                "AND rule_id = ? AND rule_version = ?", (referral.id, field, newer["rule_id"], newer["version"]))
            if done:
                continue
            conflicts.append({
                "field": field, "corrected_value": source["value"], "rule_value": agent_now,
                "referral_type": newer["referral_type"], "rule_id": newer["rule_id"], "rule_version": newer["version"],
                "corrected_by": source["by"], "rule_by": self._rule_author(referral.practice_id, newer["rule_id"]),
            })
        return conflicts

    def resolve_conflict(self, context: PracticeContext, referral_id: str, field: str, choice: str) -> dict:
        """The physician keeps their earlier correction or applies the updated rule. Both choices
        are recorded; applying the rule is also recorded as a correction back to the rule's value."""
        context.require_physician("decide between your correction and your rule")
        if choice not in {"keep_correction", "apply_rule"}:
            raise PilotError("invalid_choice", "Choose keep_correction or apply_rule", 422)
        row = self._row(context, referral_id)
        referral = self._referral(row)
        recommendation = self.recommendation(context.practice_id, referral.current_recommendation_id)
        conflict = next((item for item in self._correction_conflicts(referral, recommendation) if item["field"] == field), None)
        if conflict is None:
            raise PilotError("no_conflict", "There is no open conflict for that field", 409)
        now = now_iso()
        inserts = [(
            ("INSERT INTO correction_conflict_resolutions (id, practice_id, referral_id, field, corrected_value, "
             "rule_value, rule_id, rule_version, choice, actor, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            (new_id("ccr"), context.practice_id, referral_id, field, json.dumps(conflict["corrected_value"]),
             json.dumps(conflict["rule_value"]), conflict["rule_id"], conflict["rule_version"], choice,
             context.actor, context.role, now),
        )]
        changes: dict[str, Any] = {}
        if choice == "apply_rule":
            inserts.append((
                ("INSERT INTO triage_corrections (id, practice_id, referral_id, recommendation_id, field, from_value, "
                 "to_value, agent_value, reason, actor, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
                (new_id("cor"), context.practice_id, referral_id, recommendation.id, field,
                 json.dumps(conflict["corrected_value"]), json.dumps(conflict["rule_value"]),
                 json.dumps(conflict["rule_value"]),
                 f"Applied the updated {conflict['referral_type']} rule (v{conflict['rule_version']}) instead of the earlier correction",
                 context.actor, context.role, now),
            ))
            review = dict(referral.review or {})
            review["corrections"] = {k: v for k, v in (review.get("corrections") or {}).items() if k != field}
            review["cleared"] = sorted(set(review.get("cleared") or []) | {field})
            changes["review_json"] = json.dumps(review)
        self._transition(
            context, row, IntakeStatus(row["status"]), changes=changes, inserts=inserts,
            events=[{"event_type": "correction_conflict_resolved", "actor": context.actor, "metadata": {
                "field": field, "choice": choice, "rule_id": conflict["rule_id"], "rule_version": conflict["rule_version"],
                "corrected_value": conflict["corrected_value"], "rule_value": conflict["rule_value"], "role": context.role}}],
        )
        return self.detail(context, referral_id)

    def mark_seen(self, context: PracticeContext, referral_id: str) -> dict:
        self._row(context, referral_id)
        return {"seen_at": self.store.mark_seen(context.practice_id, referral_id, context.user_id)}

    def list(self, context: PracticeContext) -> list[dict]:
        items = []
        directory = ActorDirectory(self.store, context.practice_id)
        voice = Voice.for_context(context, self.physician_name(context.practice_id, directory))
        request_rows: dict[str, list[dict]] = {}
        for request in self.store.fetch_all(
                "SELECT referral_id, status FROM missing_information_requests WHERE practice_id = ?", (context.practice_id,)):
            request_rows.setdefault(request["referral_id"], []).append({"status": request["status"]})
        notified = {event["referral_id"] for event in self.store.events(
            practice_id=context.practice_id, event_type="referring_office_notified")}
        for row in self.store.referral_rows(context.practice_id):
            referral = self._referral(row)
            recommendation = self.recommendation(context.practice_id, referral.current_recommendation_id)
            effective = self._effective(recommendation, referral) or {}
            items.append({
                "id": referral.id,
                "status": referral.status,
                "patient_name": referral.patient.name,
                "referral_type": referral.referral_type,
                "sender_name": referral.sender.name,
                "sender_practice": referral.sender.practice,
                "received_at": referral.received_at,
                "fit": effective.get("fit"),
                "priority": effective.get("suggested_priority"),
                "next_step": effective.get("next_step"),
                "requires_physician": effective.get("requires_physician"),
                "missing_items": recommendation.missing_items if recommendation else [],
                "escalated": bool(referral.escalated_at),
                "handoff": (referral.handoff or {}).get("kind"),
                "handoff_by_name": directory.describe(referral.handoff["by"])["name"] if (referral.handoff or {}).get("by") else None,
                # Decided = the physician signed it off (accept / redirect / decline).
                "decided": bool(referral.disposition),
                # The same standing the referral page shows (never "complete" while anything is open).
                "standing": referral_standing(
                    status=referral.status, recommendation=recommendation.model_dump(mode="json") if recommendation else None,
                    next_step=effective.get("next_step"), requests=request_rows.get(referral.id, []), voice=voice),
                "has_conflict": bool(self._correction_conflicts(referral, recommendation)),
                "office_notified": referral.id in notified,
            })
        return items

    def allowed_actions(
        self, context: PracticeContext, referral: IntakeReferral,
        recommendation: TriageRecommendation | None,
    ) -> list[str]:
        status = referral.status
        if status in TERMINAL_STATUSES:
            return []
        actions = ["upload_document", "record_item", "retriage"]
        # Clinical corrections before deciding: physician only. Staff do the paperwork.
        if context.role == "physician" and recommendation is not None:
            actions.append("correct")
        if context.role == "staff" and status != S.RECEIVED and (referral.handoff or {}).get("kind") != "ready":
            actions.append("mark_ready")
        if recommendation is not None and any(item.state == "sender_reported" for item in recommendation.requirements):
            actions.append("verify_item")
        actions.append("set_referral_type")
        if can_transition(status, S.NEEDS_INFORMATION) or status == S.NEEDS_INFORMATION:
            actions.append("request_information")
        if not referral.escalated_at:
            actions.append("escalate")
        if context.role == "physician" and status != S.RECEIVED:
            actions += ["accept", "redirect", "decline"]
        return actions

    # ---------------------------------------------------------------- creation

    def create(self, context: PracticeContext, update: IntakeReferralInput, source: str | None = None) -> dict:
        now = now_iso()
        referral_id = new_id("ref")
        team_member = context.role in {"physician", "staff"}
        items = [
            item.model_copy(update={
                "source": "sender_submitted",
                "recorded_by": context.actor,
                "recorded_at": now,
                # A practice member transcribed this from the referral they received; a value
                # typed by the sender on a public form stays unverified.
                "verified_by": context.actor if team_member else None,
                "verified_at": now if team_member else None,
            })
            for item in update.submitted_items
        ]
        sender_token = secrets.token_urlsafe(24)
        row = {
            "id": referral_id,
            "practice_id": context.practice_id,
            "source": source or update.source,
            "status": S.RECEIVED.value,
            "sender_json": update.sender.model_dump_json(),
            "patient_json": update.patient.model_dump_json(),
            "referral_type": " ".join(update.referral_type.split()),
            "submitted_referral_type": " ".join(update.referral_type.split()),
            "reason": update.reason.strip(),
            "clinical_context": (update.clinical_context or "").strip() or None,
            "sender_priority": update.sender_priority,
            "submitted_items_json": json.dumps([item.model_dump(mode="json") for item in items]),
            "received_at": _parse_received_at(update.received_at),
            "entered_at": now,
            "entered_by": context.actor,
            # Only the hash is stored; the token is reserved for the sender status link.
            "sender_status_token_hash": hash_token(sender_token),
            "created_at": now,
            "updated_at": now,
        }
        self.store.insert_referral(
            row,
            {"source": row["source"], "referral_type": row["referral_type"], "entered_by_role": context.role},
            context.actor,
        )
        self.run_triage(context, referral_id)
        return self.detail(context, referral_id)

    # --------------------------------------------------------------- documents

    def add_document(
        self, context: PracticeContext, referral_id: str, *, content: bytes,
        content_type: str, filename: str | None, retriage: bool = True,
    ) -> dict:
        referral = self.get(context, referral_id)
        if referral.status in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        try:
            suffix = validate_document(content, content_type)
        except DocumentRejectedError as error:
            raise PilotError("document_rejected", str(error), 422) from error
        status, pages = extract_pages(content, content_type)
        storage_key = self.storage.put(context.practice_id, content, suffix)
        document_id = new_id("doc")
        self.store.insert_document(
            {
                "id": document_id,
                "practice_id": context.practice_id,
                "referral_id": referral_id,
                "filename": safe_filename(filename),
                "content_type": content_type.split(";")[0].strip().casefold(),
                "size_bytes": len(content),
                "sha256": sha256_hex(content),
                "storage_key": storage_key,
                "uploaded_by": context.actor,
                "uploaded_at": now_iso(),
                "extraction_status": status,
                "extracted_pages_json": json.dumps(pages) if pages else None,
                "page_count": len(pages) or None,
            },
            context.actor,
        )
        if retriage:
            self.run_triage(context, referral_id)
        return self.detail(context, referral_id)

    def document_content(self, context: PracticeContext, document_id: str) -> tuple[dict, bytes]:
        row = self.store.document_row(context.practice_id, document_id)
        if not row:
            raise PilotError("document_not_found", "Document not found", 404)
        self.store.append_event(
            "document_viewed", actor=context.actor, practice_id=context.practice_id,
            referral_id=row["referral_id"], metadata={"document_id": document_id},
        )
        return row, self.storage.get(row["storage_key"])

    def _documents_text(self, practice_id: str, referral_id: str) -> list[DocumentText]:
        return [
            DocumentText(row["id"], row["filename"], json.loads(row["extracted_pages_json"]))
            for row in self.store.document_rows(practice_id, referral_id)
            if row["extraction_status"] == "extracted" and row["extracted_pages_json"]
        ]

    # ------------------------------------------------------------------ triage

    def run_triage(self, context: PracticeContext, referral_id: str) -> dict:
        """Generate and persist a new recommendation. Only deterministic requirement
        logic may move status: received -> triaged, and needs_information ->
        ready_for_review once every required item is satisfied by human-provided
        evidence. A model never changes status."""
        row = self._row(context, referral_id)
        referral = self._referral(row)
        if referral.status in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        # Step 17: the practice layer plus this referral's physician's own layer, and the exact
        # representation version used (recorded if it changed since the last one).
        owner = self.representation.referral_physician(context.practice_id) if self.representation else None
        rules, type_match = self.rules.resolve_type(context.practice_id, referral.referral_type, owner)
        recommendation, snapshot = triage_referral(
            referral, rules, self._documents_text(context.practice_id, referral_id),
            today=self._today, extractor=self._resolved_extractor(), type_match=type_match,
            allow_loosening=bool(context.practice.get("allow_physician_loosening")),
        )
        version = self.representation.record_version(
            context.practice_id, owner, actor="agent:triage", reason="triage") if self.representation else None
        if version:
            recommendation = recommendation.model_copy(update={"representation_version_id": version["id"]})
        target = referral.status
        if referral.status == S.RECEIVED:
            target = S.TRIAGED
        elif referral.status == S.NEEDS_INFORMATION and recommendation.readiness == "ready":
            target = S.READY_FOR_REVIEW
        events = [
            {"event_type": "recommendation_generated", "actor": "agent:triage", "autonomy": "automatic",
             "metadata": {
                 "recommendation_id": recommendation.id, "fit": recommendation.fit,
                 "readiness": recommendation.readiness, "next_step": recommendation.next_step,
                 "generator": recommendation.generator, "rules_snapshot_id": recommendation.rules_snapshot_id,
                 "rule_count": len(rules),
             }},
            {"event_type": "referral_triaged", "actor": "agent:triage", "autonomy": "automatic",
             "metadata": {"recommendation_id": recommendation.id, "requested_by": context.actor}},
        ]
        if recommendation.missing_items:
            events.append({
                "event_type": "missing_information_detected", "actor": "agent:triage",
                "autonomy": "automatic",
                "metadata": {"recommendation_id": recommendation.id, "items": recommendation.missing_items},
            })
        if target == S.READY_FOR_REVIEW and referral.status != S.READY_FOR_REVIEW:
            events.append({
                "event_type": "referral_became_ready", "actor": "agent:triage", "autonomy": "automatic",
                "metadata": {"recommendation_id": recommendation.id, "basis": "deterministic_requirements"},
            })
        # No approval to carry or re-request: a clinical change is simply recorded (with what
        # prompted the re-triage) and shown to the physician as "changed since you last looked".
        # The CAUSE (e.g. a physician's rule update) is recorded separately from the TRIGGER
        # (whoever's action re-ran triage), so the note never credits the wrong person.
        prior_rows = self.store.recommendation_rows(context.practice_id, referral_id)
        if prior_rows:
            previous = TriageRecommendation.model_validate_json(prior_rows[-1]["recommendation_json"])
            changed = material_changes(previous, recommendation)
            if changed:
                directory = ActorDirectory(self.store, context.practice_id)
                sender = referral.sender.model_dump(mode="json")
                trigger = directory.describe(context.actor, sender)
                cause = self._change_cause(context, prior_rows[-1], snapshot, changed, trigger, directory)
                events.append({"event_type": "recommendation_changed", "actor": "agent:triage",
                               "autonomy": "automatic", "metadata": {
                                   "recommendation_id": recommendation.id, "from_recommendation_id": previous.id,
                                   "changed_fields": changed, "requested_by": context.actor,
                                   "requested_by_name": trigger["name"], "cause": cause}})
        self._transition(
            context, row, target, events=events,
            recommendation={
                "id": recommendation.id, "referral_id": referral_id, "practice_id": context.practice_id,
                "payload": recommendation.model_dump(mode="json"), "generator": recommendation.generator,
                "model_id": recommendation.model_id, "rules_snapshot_id": recommendation.rules_snapshot_id,
                "rules_snapshot": snapshot, "created_at": recommendation.created_at,
                "representation_version_id": recommendation.representation_version_id,
            },
        )
        for hook in self.after_triage:
            hook(context, referral_id, recommendation)
        return self.detail(context, referral_id)

    def _rule_author(self, practice_id: str, rule_id: str) -> str | None:
        """Who made this rule version active: its confirmer, else its author, as stored on the
        version itself. None when the record doesn't say (author_source = 'unknown')."""
        row = self.store.fetch_one(
            "SELECT created_by, confirmed_by FROM physician_referral_preferences WHERE practice_id = ? AND id = ?",
            (practice_id, rule_id))
        return (row or {}).get("confirmed_by") or (row or {}).get("created_by")

    def _change_cause(
        self, context: PracticeContext, previous_row: dict, snapshot: dict, changed: dict,
        trigger: dict, directory: ActorDirectory,
    ) -> dict:
        """Why the clinical recommendation changed: a rule version (and who made it), a changed
        referral type, or new information on the referral (and who supplied it)."""
        before = {(r["rule_id"], r["version"]): r for r in
                  (json.loads(previous_row.get("rules_snapshot_json") or "{}") or {}).get("rules", [])}
        after = {(r["rule_id"], r["version"]): r for r in (snapshot or {}).get("rules", [])}
        rules = []
        for key, rule in after.items():
            if key in before:
                continue
            author = self._rule_author(context.practice_id, rule["rule_id"])
            updated = any(old["referral_type"] == rule["referral_type"] for old in before.values())
            rules.append({"kind": "rule_updated" if updated else "rule_added", "referral_type": rule["referral_type"],
                          "version": rule["version"], "rule_id": rule["rule_id"], "by": author,
                          "by_name": directory.describe(author)["name"] if author else None})
        for key, rule in before.items():
            if key not in after and not any(new["referral_type"] == rule["referral_type"] for new in after.values()):
                author = self._rule_author(context.practice_id, rule["rule_id"])
                rules.append({"kind": "rule_removed", "referral_type": rule["referral_type"], "version": rule["version"],
                              "rule_id": rule["rule_id"], "by": author,
                              "by_name": directory.describe(author)["name"] if author else None})
        if rules:
            verbs = {"rule_updated": "updated", "rule_added": "added", "rule_removed": "retired"}

            def describe(item: dict) -> str:
                version = f" (v{item['version']})" if item["kind"] != "rule_removed" else ""
                if item["by_name"]:
                    return f"{item['by_name']} {verbs[item['kind']]} the {item['referral_type']} rule{version}"
                # Honest when the record doesn't say who: never credit the person who re-ran it.
                return (f"the {item['referral_type']} rule was {verbs[item['kind']]}"
                        + (f" (v{item['version']}; author not recorded)" if version else " (author not recorded)"))

            text = "; ".join(describe(item) for item in rules)
            by_names = {item["by_name"] for item in rules if item["by_name"]}
            return {"kind": "rules", "rules": rules, "text": text,
                    "by_name": rules[0]["by_name"] or "Author not recorded",
                    "trigger_differs": trigger["name"] not in by_names}
        if "rule_type" in changed:
            return {"kind": "referral_type", "text": f"{trigger['name']} changed the referral type",
                    "by_name": trigger["name"], "trigger_differs": False}
        text = ("the referring office sent new information" if trigger["role"] == "referring_office"
                else f"{trigger['name']} updated the referral’s information" if trigger["role"] in {"staff", "physician"}
                else "Lamina re-checked the referral")
        return {"kind": "new_information", "text": text, "by_name": trigger["name"], "trigger_differs": False}

    # ------------------------------------------------------------- transitions

    def _transition(
        self,
        context: PracticeContext,
        row: dict,
        target: IntakeStatus,
        *,
        changes: dict[str, Any] | None = None,
        events: list[dict] | None = None,
        decision: dict | None = None,
        recommendation: dict | None = None,
        inserts: list[tuple[str, tuple]] | None = None,
    ) -> None:
        current = IntakeStatus(row["status"])
        if target != current and not can_transition(current, target):
            raise PilotError(
                "invalid_transition",
                f"A referral that is {current.value.replace('_', ' ')} cannot become "
                f"{target.value.replace('_', ' ')}",
            )
        all_changes = {**(changes or {})}
        all_events = list(events or [])
        if target != current:
            all_changes["status"] = target.value
            all_events.append({
                "event_type": "referral_status_changed", "actor": context.actor
                if not recommendation else "agent:triage",
                "autonomy": "automatic" if recommendation else "human",
                "metadata": {"from": current.value, "to": target.value},
            })
        applied = self.store.update_referral(
            context.practice_id, row["id"], expected_status=current.value,
            changes=all_changes, events=all_events, decision=decision, recommendation=recommendation,
            inserts=inserts,
        )
        if not applied:
            raise PilotError(
                "stale_referral", "This referral changed while you were working. Refresh and try again"
            )

    def correct(self, context: PracticeContext, referral_id: str, update: TriageEditInput) -> dict:
        """A physician corrects fit, priority or visit type before deciding. Each changed field is
        an append-only correction (actor, role, the agent's value, from -> to). The physician's
        accept / redirect / decline is still the sign-off; a correction is not a decision."""
        context.require_physician("change fit, priority or visit type")
        extra = [field for field in ("next_step", "requires_physician") if getattr(update, field) is not None]
        if extra:
            raise PilotError("not_correctable",
                             "Only fit, priority and visit type can be corrected. Staff mark a referral "
                             "ready or flag it for the physician", 422)
        row = self._row(context, referral_id)
        if IntakeStatus(row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        referral = self._referral(row)
        recommendation = self.recommendation(context.practice_id, referral.current_recommendation_id)
        if recommendation is None:
            raise PilotError("no_recommendation", "This referral has not been triaged yet")
        effective = self._effective(recommendation, referral) or {}
        now = now_iso()
        reason = (update.reason or "").strip() or None
        changed = {
            field: {"from": effective[field], "to": getattr(update, field)}
            for field in CORRECTABLE_FIELDS
            if getattr(update, field) is not None and getattr(update, field) != effective[field]
        }
        if not changed:
            raise PilotError("no_changes", "Change fit, priority or visit type first", 422)
        inserts = [(
            ("INSERT INTO triage_corrections (id, practice_id, referral_id, recommendation_id, field, from_value, "
            "to_value, agent_value, reason, actor, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            (new_id("cor"), context.practice_id, referral_id, recommendation.id, field,
             json.dumps(change["from"]), json.dumps(change["to"]), json.dumps(getattr(recommendation, field)),
             reason, context.actor, context.role, now),
        ) for field, change in changed.items()]
        review = dict(referral.review or {})
        review["corrections"] = {**(review.get("corrections") or {}),
                                 **{field: change["to"] for field, change in changed.items()}}
        review["corrected_by"], review["corrected_at"] = context.actor, now
        self._transition(
            context, row, IntakeStatus(row["status"]),
            changes={"review_json": json.dumps(review)}, inserts=inserts,
            events=[{"event_type": "triage_corrected", "actor": context.actor, "metadata": {
                "recommendation_id": recommendation.id, "changes": changed, "role": context.role,
                "has_reason": bool(reason)}}],
        )
        for hook in self.after_decision:
            hook(context, referral_id)
        return self.detail(context, referral_id)

    # Kept so older callers get a clear answer instead of a 404.
    def edit(self, context: PracticeContext, referral_id: str, update: TriageEditInput) -> dict:
        return self.correct(context, referral_id, update)

    def approve(self, context: PracticeContext, referral_id: str) -> dict:
        self._row(context, referral_id)
        raise PilotError("triage_approval_removed", APPROVAL_REMOVED, 410)

    def reject(self, context: PracticeContext, referral_id: str, reason: str | None) -> dict:
        self._row(context, referral_id)
        raise PilotError("triage_approval_removed", APPROVAL_REMOVED, 410)

    def mark_ready(self, context: PracticeContext, referral_id: str, note: str | None) -> dict:
        """Staff: the paperwork is done; the referral is ready for the physician's decision."""
        if context.role != "staff":
            raise PilotError("staff_only", "Marking a referral ready for the physician is a staff step", 403)
        row = self._row(context, referral_id)
        current = IntakeStatus(row["status"])
        if current in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        if current == S.RECEIVED:
            raise PilotError("invalid_transition", "Wait for triage before marking this referral ready")
        text = (note or "").strip() or None
        self._transition(
            context, row, S.READY_FOR_REVIEW,
            changes={"handoff_json": json.dumps({"kind": "ready", "note": text, "by": context.actor,
                                                 "role": context.role, "at": now_iso()})},
            events=[{"event_type": "referral_marked_ready", "actor": context.actor,
                     "metadata": {"role": context.role, "has_note": bool(text)}}],
        )
        return self.detail(context, referral_id)

    def request_information(
        self, context: PracticeContext, referral_id: str, update: RequestInformationInput
    ) -> dict:
        """Creates a persistent DRAFT MissingInformationRequest and moves the referral to
        needs_information. Nothing is sent until a human approves the draft."""
        row = self._row(context, referral_id)
        current = IntakeStatus(row["status"])
        target = S.NEEDS_INFORMATION
        if current != S.NEEDS_INFORMATION and not can_transition(current, target):
            raise PilotError("invalid_transition", "Information cannot be requested for this referral now")
        if self.request_projection is None:
            raise PilotError("not_configured", "Information requests are not available", 500)
        items = [item.strip() for item in update.items if item.strip()]
        recommendation = self.recommendation(context.practice_id, row["current_recommendation_id"])
        flagged = {label.casefold() for label in (recommendation.missing_items if recommendation else [])}
        extra_items = [item for item in items if item.casefold() not in flagged]
        draft = self.request_projection.create_draft(context, referral_id, items, update.note)
        row = self._row(context, referral_id)
        self._transition(
            context, row, target,
            events=[{
                "event_type": "information_requested", "actor": context.actor,
                "metadata": {"items": [item["label"] for item in draft["items"]], "request_id": draft["id"],
                             "sent": False, "extra_items": extra_items},
            }],
        )
        for hook in self.after_decision:
            hook(context, referral_id)
        return self.detail(context, referral_id)

    def escalate(self, context: PracticeContext, referral_id: str, note: str | None) -> dict:
        row = self._row(context, referral_id)
        current = IntakeStatus(row["status"])
        if current in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        if row["escalated_at"]:
            raise PilotError("already_escalated", "This referral is already flagged for physician review")
        target = S.READY_FOR_REVIEW if current == S.TRIAGED else current
        self._transition(
            context, row, target,
            changes={
                "escalated_at": now_iso(), "escalated_by": context.actor,
                "escalation_note": (note or "").strip() or None,
                "handoff_json": json.dumps({"kind": "flag", "note": (note or "").strip() or None,
                                            "by": context.actor, "role": context.role, "at": now_iso()}),
            },
            events=[{
                "event_type": "referral_escalated", "actor": context.actor,
                "metadata": {"role": context.role, "has_note": bool((note or "").strip())},
            }],
        )
        return self.detail(context, referral_id)

    def merge_items(self, context: PracticeContext, referral_id: str, new_items: list[SubmittedItem]) -> None:
        """Replace same-key submitted items (no re-triage; caller re-triages)."""
        row = self._row(context, referral_id)
        items = [SubmittedItem.model_validate(item) for item in json.loads(row["submitted_items_json"] or "[]")]
        keys = {item.key for item in new_items}
        items = [item for item in items if item.key not in keys] + list(new_items)
        self._transition(
            context, row, IntakeStatus(row["status"]),
            changes={"submitted_items_json": json.dumps([item.model_dump(mode="json") for item in items])},
            events=[{"event_type": "referral_item_recorded", "actor": context.actor,
                     "metadata": {"keys": sorted(keys), "source": new_items[0].source if new_items else None}}],
        )

    def record_item(self, context: PracticeContext, referral_id: str, update: RecordItemInput) -> dict:
        """A human supplies or confirms a requirement. Document confirmation must cite
        a document of this referral; then triage re-runs deterministically."""
        row = self._row(context, referral_id)
        if IntakeStatus(row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        if update.document_id:
            document = self.store.document_row(context.practice_id, update.document_id)
            if not document or document["referral_id"] != referral_id:
                raise PilotError("document_not_found", "Document not found on this referral", 404)
        items = [SubmittedItem.model_validate(item) for item in json.loads(row["submitted_items_json"] or "[]")]
        items = [item for item in items if item.key != update.key]
        items.append(SubmittedItem(
            key=update.key, value=update.value.strip(), observed_date=update.observed_date,
            source="document_confirmed" if update.document_id else "staff_entered",
            document_id=update.document_id, page=update.page,
            recorded_by=context.actor, recorded_at=now_iso(),
        ))
        self._transition(
            context, row, IntakeStatus(row["status"]),
            changes={"submitted_items_json": json.dumps([item.model_dump(mode="json") for item in items])},
            events=[{
                "event_type": "referral_item_recorded", "actor": context.actor,
                "metadata": {"key": update.key, "from_document": bool(update.document_id)},
            }],
        )
        return self.run_triage(context, referral_id)

    def verify_item(self, context: PracticeContext, referral_id: str, key: str, note: str | None = None) -> dict:
        """A practice member verifies a value the referring office supplied. The value, its
        source, and who sent it are kept; only the verification is added. Then triage
        re-runs, and only then can the requirement count as satisfied."""
        row = self._row(context, referral_id)
        if IntakeStatus(row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        items = [SubmittedItem.model_validate(item) for item in json.loads(row["submitted_items_json"] or "[]")]
        target = next((item for item in items if item.key == key), None)
        if target is None:
            raise PilotError("item_not_found", "Nothing was received for this item", 404)
        if item_verified(target):
            raise PilotError("already_verified", "This value is already verified")
        now = now_iso()
        items = [item.model_copy(update={"verified_by": context.actor, "verified_at": now}) if item.key == key else item
                 for item in items]
        self._transition(
            context, row, IntakeStatus(row["status"]),
            changes={"submitted_items_json": json.dumps([item.model_dump(mode="json") for item in items])},
            events=[{"event_type": "referral_item_verified", "actor": context.actor,
                     "metadata": {"key": key, "source": target.source, "recorded_by": target.recorded_by,
                                  "role": context.role, "has_note": bool((note or "").strip())}}],
        )
        return self.run_triage(context, referral_id)

    def set_referral_type(self, context: PracticeContext, referral_id: str, referral_type: str) -> dict:
        """The team confirms which practice referral type this is. The wording the sender
        submitted stays in `submitted_referral_type`; triage then re-runs."""
        row = self._row(context, referral_id)
        if IntakeStatus(row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        chosen = " ".join(referral_type.split())
        if not chosen:
            raise PilotError("referral_type_required", "Choose a referral type", 422)
        if chosen == row["referral_type"]:
            return self.run_triage(context, referral_id)
        self._transition(
            context, row, IntakeStatus(row["status"]),
            changes={"referral_type": chosen,
                     "submitted_referral_type": row.get("submitted_referral_type") or row["referral_type"]},
            events=[{"event_type": "referral_type_confirmed", "actor": context.actor,
                     "metadata": {"from": row["referral_type"], "to": chosen, "role": context.role,
                                  "known_type": chosen in self.rules.referral_types(context.practice_id)}}],
        )
        return self.run_triage(context, referral_id)

    def dispose(self, context: PracticeContext, referral_id: str, update: DispositionInput) -> dict:
        context.require_physician(f"{update.decision} a referral")
        if update.decision in {"redirect", "decline"} and not (update.reason or "").strip():
            raise PilotError("reason_required", f"Give a reason to {update.decision} this referral", 422)
        if update.decision == "redirect" and not (update.redirect_to or "").strip():
            raise PilotError("redirect_target_required", "Say where this referral should go instead", 422)
        row = self._row(context, referral_id)
        current = IntakeStatus(row["status"])
        if current == S.RECEIVED:
            raise PilotError("invalid_transition", "Triage this referral before deciding on it")
        target = DISPOSITION_STATUS[update.decision]
        disposition = {
            "decision": update.decision, "reason": (update.reason or "").strip() or None,
            "redirect_to": (update.redirect_to or "").strip() or None,
            "by": context.actor, "at": now_iso(),
        }
        received = datetime.fromisoformat(row["received_at"])
        # The decision IS the sign-off on the triage. Store what the agent recommended at this
        # moment, the representation version it used, the physician's corrections, and the
        # decision, in a physician-only record kept apart from anything staff did.
        referral = self._referral(row)
        recommendation = self.recommendation(context.practice_id, referral.current_recommendation_id)
        rec_row = self.store.recommendation_row(context.practice_id, recommendation.id) if recommendation else None
        corrections = [
            {key: item[key] for key in ("id", "field", "from_value", "to_value", "agent_value", "reason",
                                         "recommendation_id", "actor", "actor_role", "created_at")}
            for item in self.store.corrections(context.practice_id, referral_id)
        ]
        signoff_id = new_id("sgn")
        signoff = (
            ("INSERT INTO referral_signoffs (id, practice_id, referral_id, recommendation_id, recommendation_json, "
            "representation_version_id, rules_snapshot_id, corrections_json, effective_triage_json, decision, reason, "
            "redirect_to, actor, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            (signoff_id, context.practice_id, referral_id, recommendation.id if recommendation else None,
             recommendation.model_dump_json() if recommendation else None,
             (rec_row or {}).get("representation_version_id"),
             recommendation.rules_snapshot_id if recommendation else None,
             json.dumps(corrections), json.dumps(self._effective(recommendation, referral)),
             update.decision, disposition["reason"], disposition["redirect_to"], context.actor, context.role,
             disposition["at"]),
        )
        self._transition(
            context, row, target,
            changes={"disposition_json": json.dumps(disposition)}, inserts=[signoff],
            events=[{
                "event_type": DISPOSITION_EVENT[update.decision], "actor": context.actor,
                "metadata": {
                    "from": current.value,
                    "hours_since_received": round((datetime.now(UTC) - received).total_seconds() / 3600, 1),
                    "escalated": bool(row["escalated_at"]),
                    "signoff_id": signoff_id, "recommendation_id": recommendation.id if recommendation else None,
                    "corrections": len(corrections), "role": context.role,
                },
            }],
        )
        # Final decisions are evidence for learning too (e.g. "accepted without X").
        for hook in self.after_decision:
            hook(context, referral_id)
        return self.detail(context, referral_id)
