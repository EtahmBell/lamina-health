"""Inbound referral intake: creation, documents, triage, review actions, disposition.

All state changes go through `_transition`, which validates against the explicit
status machine and applies the change with an optimistic status check in one
transaction together with its decision row and pilot events. Model output never
moves a referral by itself: triage only produces a recommendation; humans approve,
edit, reject, request information, escalate, or decide.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, date, datetime
from typing import Any

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
)
from .practice import PilotError, PracticeContext
from .rules import PracticeRules
from .store import PilotStore, hash_token, new_id, now_iso
from .triage import DocumentText, EvidenceExtractor, default_extractor, triage_referral

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
            current_recommendation_id=row["current_recommendation_id"],
            review=json.loads(row["review_json"]) if row["review_json"] else None,
            escalated_at=row["escalated_at"],
            escalated_by=row["escalated_by"],
            escalation_note=row["escalation_note"],
            information_request=(
                json.loads(row["information_request_json"]) if row["information_request_json"] else None
            ),
            disposition=json.loads(row["disposition_json"]) if row["disposition_json"] else None,
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
        decision = self.store.decision_for(recommendation.id) if recommendation else None
        result = {
            "referral": referral.model_dump(mode="json"),
            "recommendation": recommendation.model_dump(mode="json") if recommendation else None,
            "rules_snapshot": snapshot,
            "decision": decision and {
                key: decision[key]
                for key in ("id", "decision", "changed_fields", "reason", "actor_role", "created_at")
            },
            "effective_triage": self._effective(recommendation, referral),
            "history": [
                {
                    "event_type": event["event_type"], "actor": event["actor"],
                    "autonomy": event["autonomy"], "metadata": event["metadata"],
                    "created_at": event["created_at"],
                }
                for event in self.store.events(practice_id=context.practice_id, referral_id=referral_id)
            ],
            "allowed_actions": self.allowed_actions(context, referral, recommendation),
        }
        for extend in self.detail_extensions:
            result.update(extend(context, referral_id))
        return result

    @staticmethod
    def _effective(recommendation: TriageRecommendation | None, referral: IntakeReferral) -> dict | None:
        """The triage the team is working from: the recommendation plus any human edits."""
        if recommendation is None:
            return None
        effective = {field: getattr(recommendation, field) for field in EDITABLE_TRIAGE_FIELDS}
        review = referral.review or {}
        if review.get("recommendation_id") == recommendation.id:
            effective.update(review.get("fields", {}))
        return effective

    def list(self, context: PracticeContext) -> list[dict]:
        items = []
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
                "decided": bool(recommendation and self.store.decision_for(recommendation.id)),
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
        undecided = recommendation is not None and self.store.decision_for(recommendation.id) is None
        if undecided:
            actions += ["approve", "edit", "reject"]
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
        items = [
            item.model_copy(update={
                "source": "sender_submitted",
                "recorded_by": context.actor,
                "recorded_at": now,
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
        rules = self.rules.operational(context.practice_id, referral.referral_type)
        recommendation, snapshot = triage_referral(
            referral, rules, self._documents_text(context.practice_id, referral_id),
            today=self._today, extractor=self._resolved_extractor(),
        )
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
        self._transition(
            context, row, target, events=events,
            recommendation={
                "id": recommendation.id, "referral_id": referral_id, "practice_id": context.practice_id,
                "payload": recommendation.model_dump(mode="json"), "generator": recommendation.generator,
                "model_id": recommendation.model_id, "rules_snapshot_id": recommendation.rules_snapshot_id,
                "rules_snapshot": snapshot, "created_at": recommendation.created_at,
            },
        )
        for hook in self.after_triage:
            hook(context, referral_id, recommendation)
        return self.detail(context, referral_id)

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
        )
        if not applied:
            raise PilotError(
                "stale_referral", "This referral changed while you were working. Refresh and try again"
            )

    def _current_undecided(self, context: PracticeContext, row: dict) -> TriageRecommendation:
        recommendation = self.recommendation(context.practice_id, row["current_recommendation_id"])
        if recommendation is None:
            raise PilotError("no_recommendation", "This referral has not been triaged yet")
        if self.store.decision_for(recommendation.id):
            raise PilotError("already_decided", "This recommendation has already been reviewed")
        return recommendation

    @staticmethod
    def _status_for_next_step(next_step: str) -> IntakeStatus:
        return S.NEEDS_INFORMATION if next_step == "request_information" else S.READY_FOR_REVIEW

    def _decide(
        self, context: PracticeContext, referral_id: str, kind: str,
        fields: dict[str, Any], reason: str | None,
    ) -> dict:
        row = self._row(context, referral_id)
        if IntakeStatus(row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        recommendation = self._current_undecided(context, row)
        changed = {
            field: {"from": getattr(recommendation, field), "to": value}
            for field, value in fields.items()
            if value is not None and value != getattr(recommendation, field)
        }
        if kind == "edited" and not changed:
            raise PilotError("no_changes", "Change at least one triage field, or approve it as is", 422)
        effective = {field: getattr(recommendation, field) for field in EDITABLE_TRIAGE_FIELDS}
        effective.update({field: change["to"] for field, change in changed.items()})
        if kind == "rejected":
            effective["requires_physician"] = True
        current = IntakeStatus(row["status"])
        if current == S.TRIAGED:
            target = (
                S.READY_FOR_REVIEW if kind == "rejected"
                else self._status_for_next_step(effective["next_step"])
            )
        else:
            target = current
        decision = {
            "id": new_id("dec"),
            "recommendation_id": recommendation.id,
            "decision": kind,
            "changed_fields": changed,
            "reason": (reason or "").strip() or None,
            "actor": context.actor,
            "actor_role": context.role,
            "created_at": now_iso(),
        }
        self._transition(
            context, row, target,
            changes={"review_json": json.dumps({
                "recommendation_id": recommendation.id, "decision_id": decision["id"],
                "decision": kind, "fields": {field: change["to"] for field, change in changed.items()}
                | ({"requires_physician": True} if kind == "rejected" else {}),
                "by": context.actor, "role": context.role, "at": decision["created_at"],
            })},
            decision=decision,
            events=[{
                "event_type": f"recommendation_{kind}", "actor": context.actor,
                "metadata": {
                    "recommendation_id": recommendation.id, "decision_id": decision["id"],
                    "changed_fields": sorted(changed), "has_reason": bool(decision["reason"]),
                    "role": context.role,
                },
            }],
        )
        for hook in self.after_decision:
            hook(context, referral_id)
        return self.detail(context, referral_id)

    def approve(self, context: PracticeContext, referral_id: str) -> dict:
        return self._decide(context, referral_id, "accepted", {}, None)

    def edit(self, context: PracticeContext, referral_id: str, update: TriageEditInput) -> dict:
        fields = update.model_dump(exclude={"reason"})
        return self._decide(context, referral_id, "edited", fields, update.reason)

    def reject(self, context: PracticeContext, referral_id: str, reason: str | None) -> dict:
        if not (reason or "").strip():
            raise PilotError("reason_required", "Say briefly why the triage is wrong", 422)
        return self._decide(context, referral_id, "rejected", {}, reason)

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
        self._transition(
            context, row, target,
            changes={"disposition_json": json.dumps(disposition)},
            events=[{
                "event_type": DISPOSITION_EVENT[update.decision], "actor": context.actor,
                "metadata": {
                    "from": current.value,
                    "hours_since_received": round((datetime.now(UTC) - received).total_seconds() / 3600, 1),
                    "escalated": bool(row["escalated_at"]),
                },
            }],
        )
        return self.detail(context, referral_id)
