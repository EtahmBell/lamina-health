"""Missing-information loop: draft → human approval → send (or mark sent) → sender
responds via a secure link → deterministic re-triage → resolved.

Nothing here contacts anyone without a human approval call. The model is not
involved at all: the request text is a deterministic template.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from .intake import IntakeService
from .messaging import EMAIL_PATTERN, MailNotConfiguredError, MailSender, public_app_url
from .models import (
    TERMINAL_STATUSES,
    IntakeStatus,
    SubmittedItem,
    TriageRecommendation,
    item_verified,
)
from .practice import PilotError, PracticeContext
from .store import PilotStore, hash_token, new_id, now_iso, redact_sender_links

OPEN_STATUSES = ("draft", "approved", "sent", "partially_resolved")
SENT_STATUSES = ("sent", "partially_resolved")
SENDER_LINK_DAYS = 30


def _initials(name: str) -> str:
    return "".join(part[0].upper() + "." for part in name.split() if part)[:6] or "the patient"


class SenderLinks:
    def __init__(self, store: PilotStore) -> None:
        self.store = store

    def issue(self, practice_id: str, referral_id: str, purpose: str) -> tuple[dict, str]:
        token = secrets.token_urlsafe(32)  # ~256 bits; only the hash is stored.
        now = datetime.now(UTC)
        link_id = new_id("lnk")
        self.store.execute([(
            ("INSERT INTO sender_links (id, practice_id, referral_id, token_hash, purpose, "
            "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
            (link_id, practice_id, referral_id, hash_token(token), purpose,
             now.isoformat(timespec="seconds"),
             (now + timedelta(days=SENDER_LINK_DAYS)).isoformat(timespec="seconds")),
        )])
        return self.store.fetch_one("SELECT * FROM sender_links WHERE id = ?", (link_id,)), token

    def resolve(self, token: str) -> dict | None:
        if not token or len(token) < 20 or len(token) > 200:
            return None
        link = self.store.fetch_one(
            "SELECT * FROM sender_links WHERE token_hash = ?", (hash_token(token),)
        )
        now = now_iso()
        if not link or link["revoked_at"] or link["expires_at"] <= now:
            return None
        self.store.execute([("UPDATE sender_links SET last_used_at = ? WHERE id = ?", (now, link["id"]))])
        return link

    @staticmethod
    def url(token: str) -> str:
        return f"{public_app_url()}/r/{token}"


class MissingInformationService:
    def __init__(self, store: PilotStore, intake: IntakeService, mailer: MailSender) -> None:
        self.store = store
        self.intake = intake
        self.mailer = mailer
        self.links = SenderLinks(store)

    # -------------------------------------------------------------- projection

    @staticmethod
    def view(row: dict) -> dict:
        return {
            "id": row["id"], "referral_id": row["referral_id"],
            "items": json.loads(row["items_json"]), "recipient": row["recipient"],
            "channel": row["channel"], "subject": row["subject"],
            # The stored text is a TEMPLATE: `{status_link}` marks where the secure link goes.
            # The link itself is rendered only at delivery time and never stored.
            "draft_message": redact_sender_links(row["draft_message"]), "status": row["status"],
            "created_by": row["created_by"], "approved_by": row["approved_by"],
            "approved_at": row["approved_at"], "sent_at": row["sent_at"], "sent_via": row["sent_via"],
            "resolved_at": row["resolved_at"], "cancelled_at": row["cancelled_at"],
            "evidence": json.loads(row["evidence_json"] or "[]"),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    def for_referral(self, practice_id: str, referral_id: str) -> list[dict]:
        return [self.view(row) for row in self.store.fetch_all(
            "SELECT * FROM missing_information_requests WHERE practice_id = ? AND referral_id = ? "
            "ORDER BY created_at, rowid", (practice_id, referral_id),
        )]

    def _row(self, context: PracticeContext, request_id: str) -> dict:
        row = self.store.fetch_one(
            "SELECT * FROM missing_information_requests WHERE id = ? AND practice_id = ?",
            (request_id, context.practice_id),
        )
        if not row:
            raise PilotError("request_not_found", "Information request not found", 404)
        return row

    # ------------------------------------------------------------------ drafts

    def _message(self, referral: Any, items: list[dict], note: str | None) -> tuple[str, str]:
        practice = self.store.practice(referral.practice_id) or {}
        practice_name = practice.get("name") or "our practice"
        patient = referral.patient
        identifier = patient.name + (f" (DOB {patient.date_of_birth})" if patient.date_of_birth else "")
        lines = "\n".join(f"- {item['label']}" for item in items)
        subject = f"Information needed for your referral to {practice_name}"
        body = (
            f"Hello {referral.sender.name},\n\n"
            f"Thank you for referring {identifier} to {practice_name} "
            f"({referral.referral_type}). To complete our intake review, please provide:\n\n"
            f"{lines}\n\n"
            + (f"{note.strip()}\n\n" if note and note.strip() else "")
            + "You can upload documents or reply securely here (no account needed):\n"
            "{status_link}\n\n"
            f"Thank you,\n{practice_name}"
        )
        return subject, body

    def create_draft(
        self, context: PracticeContext, referral_id: str, labels: list[str], note: str | None,
    ) -> dict:
        referral = self.intake.get(context, referral_id)
        if referral.status in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        existing = self.store.fetch_one(
            "SELECT id FROM missing_information_requests WHERE practice_id = ? AND referral_id = ? "
            "AND status = 'draft'", (context.practice_id, referral_id),
        )
        if existing:
            raise PilotError("draft_exists", "A draft request already exists for this referral — edit it instead")
        recommendation = self.intake.recommendation(context.practice_id, referral.current_recommendation_id)
        by_label = {item.label.casefold(): item.key for item in (recommendation.requirements if recommendation else [])}
        labels = [label.strip() for label in labels if label.strip()] or (
            recommendation.missing_items if recommendation else []
        )
        if not labels:
            raise PilotError("items_required", "Choose at least one item to request", 422)
        items = [{"label": label, "key": by_label.get(label.casefold())} for label in labels]
        subject, body = self._message(referral, items, note)
        contact = (referral.sender.contact or "").strip()
        channel = "email" if EMAIL_PATTERN.match(contact) else "manual"
        now = now_iso()
        request_id = new_id("mir")
        self.store.execute(
            [(
                ("INSERT INTO missing_information_requests (id, practice_id, referral_id, items_json, "
                "recipient, channel, subject, draft_message, status, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)"),
                (request_id, context.practice_id, referral_id, json.dumps(items), contact or None,
                 channel, subject, body, context.actor, now, now),
            )],
            [{
                "event_type": "missing_information_request_created", "actor": context.actor,
                "practice_id": context.practice_id, "referral_id": referral_id,
                "metadata": {"request_id": request_id, "items": labels, "channel": channel},
            }],
        )
        return self.view(self._row(context, request_id))

    def edit_draft(
        self, context: PracticeContext, request_id: str, *, message: str | None,
        recipient: str | None, subject: str | None,
    ) -> dict:
        row = self._row(context, request_id)
        if row["status"] != "draft":
            raise PilotError("request_not_draft", "Only a draft can be edited")
        new_message = (message or row["draft_message"]).strip()
        if "{status_link}" not in new_message:
            new_message += "\n\nUpload or reply securely here: {status_link}"
        new_recipient = (recipient if recipient is not None else row["recipient"] or "").strip() or None
        channel = "email" if new_recipient and EMAIL_PATTERN.match(new_recipient) else "manual"
        self.store.execute(
            [(
                ("UPDATE missing_information_requests SET draft_message = ?, recipient = ?, channel = ?, "
                "subject = ?, updated_at = ? WHERE id = ? AND status = 'draft'"),
                (new_message, new_recipient, channel, (subject or row["subject"]).strip(), now_iso(), request_id),
            )],
            [{"event_type": "missing_information_request_edited", "actor": context.actor,
              "practice_id": context.practice_id, "referral_id": row["referral_id"],
              "metadata": {"request_id": request_id}}],
        )
        return self.view(self._row(context, request_id))

    # ---------------------------------------------------------------- sending

    def approve_and_send(self, context: PracticeContext, request_id: str, mode: str) -> dict:
        """The ONLY path to an external message. `mode`: 'send' (adapter) or
        'mark_sent' (staff sent it themselves by fax/phone/email)."""
        row = self._row(context, request_id)
        if row["status"] != "draft":
            raise PilotError("request_not_draft", "This request has already been approved or closed")
        referral_row = self.store.referral_row(context.practice_id, row["referral_id"])
        if IntakeStatus(referral_row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        if mode == "send" and (row["channel"] != "email" or not row["recipient"]):
            raise PilotError(
                "email_recipient_required",
                "Add the referring office's email address, or send it yourself and mark it as sent", 422,
            )
        link, status_link, sent_via = self._deliver(context, row, mode)
        now = now_iso()
        # The template (with its `{status_link}` placeholder) stays as the stored message.
        # The token-bearing body existed only for delivery and is returned once below.
        changed = self.store.execute(
            [(
                ("UPDATE missing_information_requests SET status = 'sent', approved_by = ?, approved_at = ?, "
                "sent_at = ?, sent_via = ?, sender_link_id = ?, updated_at = ? "
                "WHERE id = ? AND status = 'draft'"),
                (context.actor, now, now, sent_via, link["id"], now, request_id),
            )],
            [{
                "event_type": "missing_information_request_sent", "actor": context.actor,
                "practice_id": context.practice_id, "referral_id": row["referral_id"],
                "metadata": {"request_id": request_id, "sent_via": sent_via, "role": context.role},
            }],
        )
        if not changed:
            raise PilotError("stale_request", "This request changed while you were working")
        if IntakeStatus(referral_row["status"]) in {IntakeStatus.TRIAGED, IntakeStatus.READY_FOR_REVIEW}:
            self.intake._transition(context, referral_row, IntakeStatus.NEEDS_INFORMATION)
        result = self.view(self._row(context, request_id))
        # Returned once so staff can paste it into a fax; only its hash is stored.
        result["status_link"] = status_link
        return result

    def _deliver(self, context: PracticeContext, row: dict, mode: str) -> tuple[dict, str, str]:
        """Issue a fresh link and hand the rendered message to the mail adapter (mode
        'send'), or leave delivery to the team (mode 'mark_sent'). Returns (link row,
        status link, sent_via). The rendered body is never persisted by this method."""
        link, token = self.links.issue(context.practice_id, row["referral_id"], "information_request")
        status_link = self.links.url(token)
        sent_via = "manual"
        if mode == "send":
            body = (row["draft_message"] or "").replace("{status_link}", status_link)
            try:
                receipt = self.mailer.send(
                    practice_id=context.practice_id, referral_id=row["referral_id"],
                    recipient=row["recipient"], subject=row["subject"], body=body,
                    approved_by=context.actor,
                )
            except MailNotConfiguredError as error:
                self.store.execute([("UPDATE sender_links SET revoked_at = ? WHERE id = ?", (now_iso(), link["id"]))])
                raise PilotError("mail_not_configured", str(error), 409) from error
            sent_via = receipt.adapter
        return link, status_link, sent_via

    def reissue_link(self, context: PracticeContext, request_id: str, mode: str) -> dict:
        """A new secure link for an open (sent) request: revokes the previous link, issues a
        new one, and delivers it the same way as the original send. The new link is returned
        once and never stored. Used when a link was lost, expired, or must be rotated."""
        row = self._row(context, request_id)
        if row["status"] not in SENT_STATUSES:
            raise PilotError("request_not_open", "Only a sent, open request can get a new secure link")
        referral_row = self.store.referral_row(context.practice_id, row["referral_id"])
        if IntakeStatus(referral_row["status"]) in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        if mode == "send" and (row["channel"] != "email" or not row["recipient"]):
            raise PilotError(
                "email_recipient_required",
                "Add the referring office's email address, or send the new link yourself", 422,
            )
        link, status_link, sent_via = self._deliver(context, row, mode)
        statements = [(
            ("UPDATE missing_information_requests SET sender_link_id = ?, sent_via = ?, updated_at = ? "
             "WHERE id = ? AND status IN ('sent', 'partially_resolved')"),
            (link["id"], sent_via, now_iso(), request_id),
        )]
        if row["sender_link_id"]:
            statements.append(("UPDATE sender_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                               (now_iso(), row["sender_link_id"])))
        changed = self.store.execute(statements, [{
            "event_type": "sender_link_reissued", "actor": context.actor,
            "practice_id": context.practice_id, "referral_id": row["referral_id"],
            "metadata": {"request_id": request_id, "revoked_link_id": row["sender_link_id"],
                         "new_link_id": link["id"], "sent_via": sent_via, "role": context.role},
        }])
        if not changed:
            self.store.execute([("UPDATE sender_links SET revoked_at = ? WHERE id = ?", (now_iso(), link["id"]))])
            raise PilotError("stale_request", "This request changed while you were working")
        result = self.view(self._row(context, request_id))
        result["status_link"] = status_link
        return result

    def cancel(self, context: PracticeContext, request_id: str) -> dict:
        row = self._row(context, request_id)
        if row["status"] not in OPEN_STATUSES:
            raise PilotError("request_closed", "This request is already closed")
        statements = [(
            ("UPDATE missing_information_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? "
            "WHERE id = ? AND status = ?"), (now_iso(), now_iso(), request_id, row["status"]),
        )]
        if row["sender_link_id"]:
            statements.append(("UPDATE sender_links SET revoked_at = ? WHERE id = ?", (now_iso(), row["sender_link_id"])))
        self.store.execute(statements, [{
            "event_type": "missing_information_request_cancelled", "actor": context.actor,
            "practice_id": context.practice_id, "referral_id": row["referral_id"],
            "metadata": {"request_id": request_id},
        }])
        return self.view(self._row(context, request_id))

    def mark_resolved(self, context: PracticeContext, request_id: str) -> dict:
        """Human closes a request whose items can't be auto-checked (free-text items)."""
        row = self._row(context, request_id)
        if row["status"] not in SENT_STATUSES:
            raise PilotError("request_not_open", "Only a sent request can be marked resolved")
        self._resolve(row, context.actor, basis="human")
        return self.view(self._row(context, request_id))

    def _resolve(self, row: dict, actor: str, basis: str) -> None:
        self.store.execute(
            [(
                ("UPDATE missing_information_requests SET status = 'resolved', resolved_at = ?, updated_at = ? "
                "WHERE id = ? AND status IN ('sent', 'partially_resolved')"), (now_iso(), now_iso(), row["id"]),
            )],
            [{
                "event_type": "missing_information_resolved", "actor": actor,
                "autonomy": "automatic" if basis == "requirements" else "human",
                "practice_id": row["practice_id"], "referral_id": row["referral_id"],
                "metadata": {"request_id": row["id"], "basis": basis,
                             "hours_open": round((datetime.now(UTC) - datetime.fromisoformat(row["sent_at"])).total_seconds() / 3600, 1)
                             if row["sent_at"] else None},
            }],
        )

    # ------------------------------------------------------------ reconcile

    def add_evidence(self, practice_id: str, referral_id: str, evidence: dict) -> None:
        for row in self.store.fetch_all(
            "SELECT * FROM missing_information_requests WHERE practice_id = ? AND referral_id = ? "
            "AND status IN ('sent', 'partially_resolved')", (practice_id, referral_id),
        ):
            items = json.loads(row["evidence_json"] or "[]") + [evidence]
            self.store.execute([(
                ("UPDATE missing_information_requests SET evidence_json = ?, status = 'partially_resolved', "
                "updated_at = ? WHERE id = ? AND status IN ('sent', 'partially_resolved')"),
                (json.dumps(items), now_iso(), row["id"]),
            )])

    def reconcile(self, practice_id: str, referral_id: str, recommendation: TriageRecommendation | None) -> None:
        """After each deterministic re-triage: a request is resolved only when every
        keyed item it asked for is `satisfied` (never merely proposed)."""
        if recommendation is None:
            return
        state = {item.key: item.state for item in recommendation.requirements}
        for row in self.store.fetch_all(
            "SELECT * FROM missing_information_requests WHERE practice_id = ? AND referral_id = ? "
            "AND status IN ('sent', 'partially_resolved')", (practice_id, referral_id),
        ):
            items = json.loads(row["items_json"])
            keyed = [item for item in items if item.get("key")]
            if keyed and len(keyed) == len(items) and all(state.get(item["key"]) == "satisfied" for item in keyed):
                self._resolve(row, "agent:triage", basis="requirements")
            elif any(state.get(item.get("key")) == "satisfied" for item in keyed) and row["status"] == "sent":
                self.store.execute([(
                    ("UPDATE missing_information_requests SET status = 'partially_resolved', updated_at = ? "
                    "WHERE id = ? AND status = 'sent'"), (now_iso(), row["id"]),
                )])

    def open_requests(self, practice_id: str) -> list[dict]:
        return [self.view(row) for row in self.store.fetch_all(
            "SELECT * FROM missing_information_requests WHERE practice_id = ? AND status IN "
            "('draft', 'approved', 'sent', 'partially_resolved') ORDER BY created_at", (practice_id,),
        )]


# ----------------------------------------------------------------- sender side

PUBLIC_STATUS = {
    "received": "Received", "triaged": "Under review", "needs_information": "Information requested",
    "ready_for_review": "Under review", "accepted": "Accepted", "redirected": "Closed — redirected",
    "declined": "Closed",
}


class SenderService:
    """What an unauthenticated sender may see and do with a valid link. Never
    exposes rules, triage, internal notes, decisions, or other referrals."""

    def __init__(self, store: PilotStore, intake: IntakeService, missing: MissingInformationService) -> None:
        self.store = store
        self.intake = intake
        self.missing = missing

    def _context(self, link: dict) -> tuple[PracticeContext, dict]:
        practice = self.store.practice(link["practice_id"])
        if not practice or practice["status"] != "active":
            raise PilotError("link_unavailable", "This link is no longer available", 404)
        context = PracticeContext(
            user_id="public-sender", practice=practice, member={}, role="sender",
            owner_scope_id=None, actor_label=f"sender:{link['id']}",
        )
        return context, practice

    def _link(self, token: str) -> dict:
        link = self.missing.links.resolve(token)
        if not link:
            raise PilotError("link_unavailable", "This link is invalid or has expired. Contact the practice for a new one", 404)
        return link

    def view(self, token: str) -> dict:
        link = self._link(token)
        context, practice = self._context(link)
        referral = self.intake.get(context, link["referral_id"])
        requests = [
            request for request in self.missing.for_referral(context.practice_id, referral.id)
            if request["status"] in SENT_STATUSES
        ]
        requested = []
        for request in requests:
            for item in request["items"]:
                if item not in requested:
                    requested.append(item)
        recommendation = self.intake.recommendation(context.practice_id, referral.current_recommendation_id)
        satisfied = {item.key for item in (recommendation.requirements if recommendation else []) if item.state == "satisfied"}
        # Something the office supplied that the practice has not verified yet: "received",
        # never "accepted as complete".
        supplied = {item.key for item in referral.submitted_items if item.value.strip()}
        verified = {item.key for item in referral.submitted_items if item_verified(item)}
        uploads = [
            {"filename": document.filename, "uploaded_at": document.uploaded_at}
            for document in referral.documents if document.uploaded_by.startswith("sender:")
        ]
        return {
            "practice": {"name": practice["name"], "phone": practice.get("phone"), "contact_email": practice.get("contact_email")},
            "referral": {
                "patient_initials": _initials(referral.patient.name),
                "referral_type": referral.referral_type,
                "received_at": referral.received_at,
                "status": PUBLIC_STATUS[referral.status.value],
                "closed": referral.status in TERMINAL_STATUSES,
            },
            "requested_items": [
                {"label": item["label"], "key": item.get("key"),
                 "received": bool(item.get("key")) and (item["key"] in satisfied or item["key"] in supplied),
                 "state": ("verified" if item.get("key") and item["key"] in satisfied and item["key"] in verified
                           else "received" if item.get("key") and (item["key"] in supplied or item["key"] in satisfied)
                           else "requested")}
                for item in requested
            ],
            "your_uploads": uploads,
            "can_respond": referral.status not in TERMINAL_STATUSES,
        }

    def upload(self, token: str, *, content: bytes, content_type: str, filename: str | None) -> dict:
        link = self._link(token)
        context, _ = self._context(link)
        detail = self.intake.add_document(
            context, link["referral_id"], content=content, content_type=content_type, filename=filename,
            retriage=False,
        )
        document = detail["referral"]["documents"][-1]
        self.store.append_event(
            "sender_document_received", actor=context.actor, autonomy="human",
            practice_id=context.practice_id, referral_id=link["referral_id"],
            metadata={"document_id": document["id"], "link_purpose": link["purpose"]},
        )
        self.missing.add_evidence(context.practice_id, link["referral_id"], {"type": "document", "id": document["id"]})
        self.intake.run_triage(context, link["referral_id"])
        return self.view(token)

    def respond(self, token: str, message: str | None, items: list[dict]) -> dict:
        link = self._link(token)
        context, _ = self._context(link)
        referral = self.intake.get(context, link["referral_id"])
        if referral.status in TERMINAL_STATUSES:
            raise PilotError("referral_closed", "This referral is closed")
        allowed = {
            item.get("key") for request in self.missing.for_referral(context.practice_id, referral.id)
            if request["status"] in SENT_STATUSES for item in request["items"] if item.get("key")
        }
        clean_items = []
        for item in items:
            if item.get("key") not in allowed or not str(item.get("value", "")).strip():
                continue
            clean_items.append(SubmittedItem(
                key=item["key"], value=str(item["value"]).strip()[:1000],
                observed_date=item.get("observed_date") or None, source="sender_submitted",
                recorded_by=context.actor, recorded_at=now_iso(),
            ))
        text = (message or "").strip()[:4000] or None
        if not clean_items and not text:
            raise PilotError("empty_response", "Add a value for a requested item or a short message", 422)
        response_id = new_id("rsp")
        self.store.execute(
            [(
                ("INSERT INTO sender_responses (id, practice_id, referral_id, sender_link_id, message, items_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)"),
                (response_id, context.practice_id, referral.id, link["id"], text,
                 json.dumps([item.model_dump(mode="json") for item in clean_items]), now_iso()),
            )],
            [{
                "event_type": "sender_response_received", "actor": context.actor,
                "practice_id": context.practice_id, "referral_id": referral.id,
                "metadata": {"response_id": response_id, "item_keys": [item.key for item in clean_items],
                             "has_message": bool(text)},
            }],
        )
        if clean_items:
            self.intake.merge_items(context, referral.id, clean_items)
        self.missing.add_evidence(context.practice_id, referral.id, {"type": "response", "id": response_id})
        self.intake.run_triage(context, referral.id)
        return self.view(token)

    def responses(self, practice_id: str, referral_id: str) -> list[dict]:
        return [
            {"id": row["id"], "message": row["message"], "items": json.loads(row["items_json"]), "created_at": row["created_at"]}
            for row in self.store.fetch_all(
                "SELECT * FROM sender_responses WHERE practice_id = ? AND referral_id = ? ORDER BY created_at",
                (practice_id, referral_id),
            )
        ]
