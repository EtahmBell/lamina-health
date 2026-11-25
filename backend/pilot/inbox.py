"""The intake pipeline (run 3): one shared path for every channel.

    document received -> stored (DocumentStorage) -> text extracted (TextExtractor) -> fields proposed
    -> suggestions (patient match, referral type, an open information request it may answer)
    -> a person routes it: create a referral | attach to an existing referral | reply to a request
       | split by page | dismiss with a reason (restorable) -> normal triage and Verify.

Channels: manual upload (staff; several files per item), fax and email (vendor webhooks,
backend/pilot/inbound.py), and public referral submissions (recorded as already-routed items).
Nothing is silently dropped: every received document is an item until a person routes or
dismisses it, extraction failures land as `needs_review`, and a webhook for an unknown address is
recorded as `unroutable` and refused so the vendor retries/alerts.

Extracted fields are proposals with page and region; nothing is verified automatically. Results
in a document stay document evidence: triage proposes it and a person confirms (received vs
verified). Audit events: intake_document_received, intake_extracted, intake_patient_matched,
intake_routed, intake_request_matched, intake_split, intake_dismissed, intake_restored (ids,
counts and types only -- never document contents).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from .documents import (
    DocumentRejectedError,
    DocumentStorage,
    safe_filename,
    sha256_hex,
    validate_document,
)
from .extraction import (
    Extraction,
    ExtractionNotApprovedError,
    TextExtractor,
    extractor_from_environment,
    guarded_extract,
    llm_intake_extraction_enabled,
    merge_proposals,
    model_proposals,
    propose_fields,
)
from .models import IntakeReferralInput
from .patients import PatientService, digits, name_tokens
from .practice import PilotError, PracticeContext
from .store import PilotStore, new_id, now_iso

logger = logging.getLogger(__name__)
MAX_FILES_PER_ITEM = 20
MAX_ITEM_BYTES = 50 * 1024 * 1024
DISMISS_REASONS = ("junk", "not_a_referral", "duplicate", "wrong_practice", "other")
OPEN_STATUSES = ("received", "extracted", "needs_review")
# Executables and archives are refused whatever type they claim (on top of the magic-byte check).
_EXECUTABLE = (b"MZ", b"\x7fELF", b"#!", b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa", b"PK\x03\x04",
               b"Rar!", b"7z\xbc\xaf")


@dataclass
class ReceivedFile:
    filename: str | None
    content_type: str
    content: bytes
    role: str = "file"  # file | email_body


def check_file(file: ReceivedFile) -> str:
    """The canonical suffix, or a PilotError: type allow-list, size, magic bytes, no executables."""
    if file.content[:4].startswith(_EXECUTABLE) or file.content.lstrip()[:2] == b"#!":
        raise PilotError("document_rejected", "Executable and archive files are never accepted", 422)
    try:
        return validate_document(file.content, file.content_type)
    except DocumentRejectedError as error:
        raise PilotError("document_rejected", str(error), 422) from error


def storage_location(storage: DocumentStorage, storage_key: str) -> dict | None:
    bucket = getattr(storage, "bucket", None)
    object_key = getattr(storage, "_object_key", None)
    return {"bucket": bucket, "key": object_key(storage_key)} if bucket and object_key else None


class IntakeInboxService:
    def __init__(self, store: PilotStore, intake: Any, missing: Any, extractor: TextExtractor | None = None,
                 model_client: Any = None) -> None:
        self.store = store
        self.intake = intake
        self.missing = missing
        self.patients = PatientService(store)
        self._extractor = extractor
        self._model_client = model_client

    @property
    def extractor(self) -> TextExtractor:
        if self._extractor is None:
            self._extractor = extractor_from_environment()
        return self._extractor

    @property
    def storage(self) -> DocumentStorage:
        return self.intake.storage

    # ---------------------------------------------------------------------- receive

    def receive(self, practice_id: str, *, channel: str, actor: str, files: list[ReceivedFile],
                provider: str | None = None, provider_message_id: str | None = None, from_address: str | None = None,
                to_address: str | None = None, subject: str | None = None, receipt: tuple | None = None) -> str:
        """Store, extract and propose -- then the item waits in the inbox for a person. `receipt`
        (webhooks): (receipt id, channel, provider key, event id), recorded in the SAME transaction
        as the item, so a replayed event fails on the unique key and creates nothing."""
        if not files:
            raise PilotError("no_documents", "Nothing was received", 422)
        if len(files) > MAX_FILES_PER_ITEM:
            raise PilotError("too_many_files", f"At most {MAX_FILES_PER_ITEM} files at a time", 422)
        if sum(len(file.content) for file in files) > MAX_ITEM_BYTES:
            raise PilotError("item_too_large", "At most 50 MB at a time", 413)
        suffixes = [check_file(file) for file in files]  # every file checked before anything is stored
        item_id, now = new_id("itm"), now_iso()
        statements = [(
            ("INSERT INTO intake_items (id, practice_id, channel, status, provider, provider_message_id, from_address, "
            "to_address, subject, received_at, received_by, updated_at) VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?)"),
            (item_id, practice_id, channel, provider, provider_message_id, (from_address or "")[:200] or None,
             (to_address or "")[:200] or None, (subject or "")[:300] or None, now, actor, now))]
        if receipt:
            statements.append((
                ("INSERT INTO inbound_webhook_receipts (id, channel, provider, provider_event_id, practice_id, outcome, item_id, "
                "received_at) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)"), (*receipt, practice_id, item_id, now)))
        self.store.execute(statements)
        for file, suffix in zip(files, suffixes, strict=True):
            self._store_document(practice_id, item_id, file, suffix, actor, channel)
        self._propose(practice_id, item_id, actor)
        return item_id

    def _store_document(self, practice_id: str, item_id: str, file: ReceivedFile, suffix: str, actor: str, channel: str) -> None:
        storage_key = self.storage.put(practice_id, file.content, suffix)
        media = file.content_type.split(";")[0].strip().casefold()
        try:
            extraction = guarded_extract(self.extractor, file.content, media,
                                         location=storage_location(self.storage, storage_key))
        except ExtractionNotApprovedError:
            extraction = Extraction("failed", [], self.extractor.name)
        document_id = new_id("idoc")
        filename = safe_filename(file.filename or ("email-body.txt" if file.role == "email_body" else None))
        self.store.execute([(
            ("INSERT INTO intake_documents (id, practice_id, item_id, role, filename, content_type, size_bytes, sha256, "
            "storage_key, extraction_status, extractor, pages_json, page_count, page_offset, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"),
            (document_id, practice_id, item_id, file.role, filename, media, len(file.content), sha256_hex(file.content),
             storage_key, extraction.status, extraction.engine, json.dumps(extraction.to_json()) if extraction.pages else None,
             len(extraction.pages) or None, now_iso()))],
            events=[
                {"event_type": "intake_document_received", "actor": actor, "autonomy": "human" if actor.startswith("user:") else "automatic",
                 "practice_id": practice_id, "metadata": {"item_id": item_id, "document_id": document_id, "channel": channel,
                                                          "content_type": media, "size_bytes": len(file.content), "role": file.role}},
                {"event_type": "intake_extracted", "actor": f"system:extraction:{extraction.engine}", "autonomy": "automatic",
                 "practice_id": practice_id, "metadata": {"item_id": item_id, "document_id": document_id,
                                                          "status": extraction.status, "pages": len(extraction.pages)}},
            ])

    def add_files(self, context: PracticeContext, item_id: str, files: list[ReceivedFile]) -> dict:
        item = self._item(context, item_id)
        self._require_open(item)
        existing = self.store.fetch_all("SELECT size_bytes FROM intake_documents WHERE item_id = ?", (item_id,))
        if len(existing) + len(files) > MAX_FILES_PER_ITEM:
            raise PilotError("too_many_files", f"At most {MAX_FILES_PER_ITEM} files per item", 422)
        if sum(row["size_bytes"] for row in existing) + sum(len(file.content) for file in files) > MAX_ITEM_BYTES:
            raise PilotError("item_too_large", "At most 50 MB per item", 413)
        suffixes = [check_file(file) for file in files]
        for file, suffix in zip(files, suffixes, strict=True):
            self._store_document(context.practice_id, item_id, file, suffix, context.actor, item["channel"])
        self._propose(context.practice_id, item_id, context.actor)
        return self.detail(context, item_id)

    # ------------------------------------------------------------- proposals & suggestions

    def _known_types(self, practice_id: str) -> list[str]:
        return sorted({row["referral_type"] for row in self.store.fetch_all(
            "SELECT DISTINCT referral_type FROM physician_referral_preferences WHERE practice_id = ? AND scope = 'practice' "
            "AND operational_status IN ('confirmed', 'inferred_active')", (practice_id,))})

    def _pages(self, item_id: str) -> list:
        pages = []
        for row in self.store.fetch_all("SELECT pages_json FROM intake_documents WHERE item_id = ? ORDER BY rowid", (item_id,)):
            pages += Extraction.pages_from_json(row["pages_json"])
        return pages

    def _model(self) -> Any:
        if not llm_intake_extraction_enabled():
            return None
        if self._model_client is None:
            from backend.professional_services import ResponsesApiClient

            self._model_client = ResponsesApiClient()
        return self._model_client if getattr(self._model_client, "available", False) else None

    def _propose(self, practice_id: str, item_id: str, actor: str) -> None:
        pages = self._pages(item_id)
        known = self._known_types(practice_id)
        proposals = propose_fields(pages, known)
        client = self._model()
        if client is not None and pages:
            try:
                proposals = merge_proposals(proposals, model_proposals(client, pages, known))
            except Exception as error:  # noqa: BLE001 -- the model is optional; rule proposals stand
                logger.warning("intake model field proposals failed (%s); rule proposals kept", type(error).__name__)
        statuses = {row["extraction_status"] for row in self.store.fetch_all(
            "SELECT extraction_status FROM intake_documents WHERE item_id = ?", (item_id,))}
        status = "extracted" if statuses <= {"extracted"} else "needs_review"
        suggestions = self._suggest(practice_id, item_id, proposals)
        self.store.execute([(
            ("UPDATE intake_items SET extraction_json = ?, suggestions_json = ?, status = ?, updated_at = ? "
            "WHERE id = ? AND practice_id = ? AND status IN ('received', 'extracted', 'needs_review')"),
            (json.dumps(proposals), json.dumps(suggestions), status, now_iso(), item_id, practice_id))])

    def _suggest(self, practice_id: str, item_id: str, proposals: dict) -> dict:
        fields = proposals.get("fields", {})
        value = lambda name: (fields.get(name) or {}).get("value")
        item = self.store.fetch_one("SELECT from_address, subject FROM intake_items WHERE id = ?", (item_id,)) or {}
        patients = self.patients.candidates(practice_id, name=value("patient_name"), date_of_birth=value("date_of_birth"),
                                            phone=value("patient_phone"), mrn=value("mrn")) if value("patient_name") else []
        referral_type = (fields.get("referral_type") or {}).get("matched_type")
        return {"patients": patients, "referral_type": referral_type,
                "requests": self._request_matches(practice_id, value("patient_name"), value("date_of_birth"),
                                                  value("contact") or item.get("from_address"), item.get("subject")),
                "referrals": self._referral_matches(practice_id, value("patient_name"), value("date_of_birth"))}

    def _request_matches(self, practice_id: str, name: str | None, dob: str | None, contact: str | None,
                         subject: str | None) -> list[dict]:
        """Open information requests this document may answer, with why. Staff confirm."""
        found = []
        sender_digits = digits(contact)
        sender_email = (contact or "").strip().casefold() if "@" in (contact or "") else None
        tokens = set(name_tokens(name or ""))
        for row in self.store.fetch_all(
                "SELECT r.id, r.referral_id, r.recipient, r.subject, r.items_json, r.sent_at, i.patient_json, i.sender_json "
                "FROM missing_information_requests r JOIN intake_referrals i ON i.id = r.referral_id "
                "WHERE r.practice_id = ? AND r.status IN ('sent', 'partially_resolved')", (practice_id,)):
            patient = json.loads(row["patient_json"])
            sender = json.loads(row["sender_json"])
            reasons = []
            if tokens and tokens == set(name_tokens(patient.get("name") or "")):
                reasons.append("same patient name")
            if dob and patient.get("date_of_birth") == dob:
                reasons.append("same date of birth")
            on_file = [row.get("recipient"), sender.get("contact")]
            if sender_digits and any(digits(value) == sender_digits for value in on_file):
                reasons.append("from the fax/phone the request went to")
            if sender_email and any((value or "").strip().casefold() == sender_email for value in on_file):
                reasons.append("from the email the request went to")
            if subject and row["id"][-6:].casefold() in subject.casefold():
                reasons.append("subject names the request")
            patient_match = "same patient name" in reasons and ("same date of birth" in reasons or not dob)
            if patient_match or ("from the fax/phone the request went to" in reasons and len(reasons) > 1) \
                    or "subject names the request" in reasons:
                found.append({"request_id": row["id"], "referral_id": row["referral_id"], "patient_name": patient.get("name"),
                              "items": [item.get("label") for item in json.loads(row["items_json"])],
                              "sent_at": row["sent_at"], "reasons": reasons})
        return found[:5]

    def _referral_matches(self, practice_id: str, name: str | None, dob: str | None) -> list[dict]:
        if not name:
            return []
        tokens = set(name_tokens(name))
        found = []
        for row in self.store.fetch_all(
                "SELECT id, referral_type, status, patient_json, received_at FROM intake_referrals WHERE practice_id = ? "
                "AND status NOT IN ('accepted', 'redirected', 'declined') ORDER BY received_at DESC LIMIT 200", (practice_id,)):
            patient = json.loads(row["patient_json"])
            if tokens == set(name_tokens(patient.get("name") or "")) and (not dob or patient.get("date_of_birth") == dob):
                found.append({"referral_id": row["id"], "referral_type": row["referral_type"], "status": row["status"],
                              "patient_name": patient.get("name"), "received_at": row["received_at"]})
        return found[:5]

    # -------------------------------------------------------------------------- views

    def _item(self, context: PracticeContext, item_id: str) -> dict:
        row = self.store.fetch_one("SELECT * FROM intake_items WHERE id = ? AND practice_id = ?", (item_id, context.practice_id))
        if not row:
            raise PilotError("intake_item_not_found", "Intake item not found", 404)
        return row

    @staticmethod
    def _require_open(item: dict) -> None:
        if item["status"] not in OPEN_STATUSES:
            raise PilotError("intake_item_closed", "This item was already routed, split or dismissed", 409)

    def _summary(self, row: dict, documents: list[dict]) -> dict:
        proposals = json.loads(row["extraction_json"] or "{}")
        fields = proposals.get("fields", {})
        suggestions = json.loads(row["suggestions_json"] or "{}")
        return {
            "id": row["id"], "channel": row["channel"], "status": row["status"], "received_at": row["received_at"],
            "from_address": row["from_address"], "subject": row["subject"], "provider": row["provider"],
            "parent_item_id": row["parent_item_id"], "page_from": row["page_from"], "page_to": row["page_to"],
            "document_count": len(documents), "page_count": sum(doc["page_count"] or 0 for doc in documents),
            "patient_name": (fields.get("patient_name") or {}).get("value"),
            "referral_type": suggestions.get("referral_type") or (fields.get("referral_type") or {}).get("value"),
            "has_request_match": bool(suggestions.get("requests")),
            "has_patient_match": bool(suggestions.get("patients")),
            "several_patients": len(proposals.get("patients_found") or []),
            "routed_kind": row["routed_kind"], "routed_referral_id": row["routed_referral_id"],
            "routed_request_id": row["routed_request_id"], "dismissed_reason": row["dismissed_reason"],
            "dismissed_note": row["dismissed_note"], "handled_by": row["handled_by"], "handled_at": row["handled_at"],
            "extraction_problem": any(doc["extraction_status"] != "extracted" for doc in documents),
        }

    def list(self, context: PracticeContext, view: str = "open") -> list[dict]:
        where = {"open": "status IN ('received', 'extracted', 'needs_review')", "routed": "status IN ('routed', 'split')",
                 "dismissed": "status = 'dismissed'", "all": "1 = 1"}.get(view)
        if where is None:
            raise PilotError("invalid_view", "Choose open, routed, dismissed or all", 422)
        rows = self.store.fetch_all(f"SELECT * FROM intake_items WHERE practice_id = ? AND {where} ORDER BY received_at DESC LIMIT 200",
                                    (context.practice_id,))
        documents: dict[str, list[dict]] = {}
        if rows:
            ids = [row["id"] for row in rows]
            for doc in self.store.fetch_all(
                    f"SELECT item_id, page_count, extraction_status FROM intake_documents WHERE practice_id = ? AND item_id IN "
                    f"({','.join('?' * len(ids))})", (context.practice_id, *ids)):
                documents.setdefault(doc["item_id"], []).append(doc)
        return [self._summary(row, documents.get(row["id"], [])) for row in rows]

    def open_count(self, practice_id: str) -> int:
        row = self.store.fetch_one("SELECT COUNT(*) AS n FROM intake_items WHERE practice_id = ? AND status IN "
                                   "('received', 'extracted', 'needs_review')", (practice_id,))
        return int((row or {}).get("n") or 0)

    def detail(self, context: PracticeContext, item_id: str) -> dict:
        row = self._item(context, item_id)
        docs = self.store.fetch_all("SELECT * FROM intake_documents WHERE item_id = ? AND practice_id = ? ORDER BY rowid",
                                    (item_id, context.practice_id))
        summary = self._summary(row, docs)
        offset = 0
        documents = []
        for doc in docs:
            pages = json.loads(doc["pages_json"] or "[]")
            documents.append({"id": doc["id"], "filename": doc["filename"], "content_type": doc["content_type"],
                              "size_bytes": doc["size_bytes"], "role": doc["role"], "extraction_status": doc["extraction_status"],
                              "extractor": doc["extractor"], "page_count": doc["page_count"], "first_page": offset + 1,
                              "source_page_offset": doc["page_offset"], "pages": pages})
            offset += doc["page_count"] or 0
        children = [self._summary(child, []) for child in self.store.fetch_all(
            "SELECT * FROM intake_items WHERE parent_item_id = ? AND practice_id = ? ORDER BY page_from", (item_id, context.practice_id))]
        return {**summary, "documents": documents, "extraction": json.loads(row["extraction_json"] or "{}"),
                "suggestions": json.loads(row["suggestions_json"] or "{}"), "children": children,
                "dismiss_reasons": list(DISMISS_REASONS), "can_act": context.role in {"physician", "staff"}}

    def document_content(self, context: PracticeContext, document_id: str) -> tuple[dict, bytes]:
        row = self.store.fetch_one("SELECT * FROM intake_documents WHERE id = ? AND practice_id = ?", (document_id, context.practice_id))
        if not row:
            raise PilotError("document_not_found", "Document not found", 404)
        self.store.append_event("intake_document_viewed", actor=context.actor, practice_id=context.practice_id,
                                metadata={"document_id": document_id, "item_id": row["item_id"]})
        return row, self.storage.get(row["storage_key"])

    # ------------------------------------------------------------------------ routing

    def _attach_documents(self, context: PracticeContext, item: dict, referral_id: str) -> list[str]:
        """Copy the item's documents onto the referral (their extracted pages included), so triage
        reads them as documents -- proposals a person confirms, never verified values."""
        attached = []
        for doc in self.store.fetch_all("SELECT * FROM intake_documents WHERE item_id = ? AND practice_id = ? ORDER BY rowid",
                                        (item["id"], context.practice_id)):
            content = self.storage.get(doc["storage_key"])
            suffix = check_file(ReceivedFile(doc["filename"], doc["content_type"], content))
            storage_key = self.storage.put(context.practice_id, content, suffix)
            pages = [page["text"] for page in json.loads(doc["pages_json"] or "[]")]
            referral_document_id = new_id("doc")
            filename = doc["filename"]
            if item["page_from"]:
                filename = f"{filename.rsplit('.', 1)[0]} (pages {item['page_from']}-{item['page_to']}).{filename.rsplit('.', 1)[-1]}"
            self.store.insert_document({
                "id": referral_document_id, "practice_id": context.practice_id, "referral_id": referral_id,
                "filename": filename[:120], "content_type": doc["content_type"], "size_bytes": doc["size_bytes"],
                "sha256": doc["sha256"], "storage_key": storage_key, "uploaded_by": context.actor, "uploaded_at": now_iso(),
                "extraction_status": doc["extraction_status"] if pages else ("empty" if doc["extraction_status"] == "extracted" else doc["extraction_status"]),
                "extracted_pages_json": json.dumps(pages) if pages else None, "page_count": len(pages) or None,
            }, context.actor)
            self.store.execute([("UPDATE intake_documents SET referral_document_id = ? WHERE id = ?", (referral_document_id, doc["id"]))])
            attached.append(referral_document_id)
        return attached

    def _close(self, context: PracticeContext, item: dict, *, status: str, kind: str | None = None, referral_id: str | None = None,
               request_id: str | None = None, patient_id: str | None = None, reason: str | None = None, note: str | None = None,
               event: str, metadata: dict) -> None:
        now = now_iso()
        if not self.store.execute([(
                ("UPDATE intake_items SET status = ?, routed_kind = ?, routed_referral_id = ?, routed_request_id = ?, "
                "patient_id = COALESCE(?, patient_id), dismissed_reason = ?, dismissed_note = ?, handled_by = ?, handled_at = ?, "
                "updated_at = ? WHERE id = ? AND practice_id = ? AND status IN ('received', 'extracted', 'needs_review')"),
                (status, kind, referral_id, request_id, patient_id, reason, note, context.actor, now, now, item["id"], context.practice_id))],
                events=[{"event_type": event, "actor": context.actor, "practice_id": context.practice_id, "referral_id": referral_id,
                         "metadata": {"item_id": item["id"], "channel": item["channel"], "role": context.role, **metadata}}]):
            raise PilotError("intake_item_closed", "This item was already routed, split or dismissed", 409)

    def create_referral(self, context: PracticeContext, item_id: str, referral: IntakeReferralInput,
                        patient_id: str | None) -> dict:
        """Staff confirmed (and corrected) the proposed fields; the referral is created and triaged
        with the item's documents. A chosen patient record is linked; otherwise a new one."""
        item = self._item(context, item_id)
        self._require_open(item)
        if patient_id:
            self.patients.resolve(context.practice_id, patient_id)  # 404 for another practice's record
        source = "upload"
        detail = self.intake.create(context, referral.model_copy(update={"source": source}), source=source, patient_id=patient_id)
        referral_id = detail["referral"]["id"]
        self._attach_documents(context, item, referral_id)
        linked = self.store.fetch_one("SELECT patient_id FROM intake_referrals WHERE id = ?", (referral_id,))["patient_id"]
        self._close(context, item, status="routed", kind="new_referral", referral_id=referral_id, patient_id=linked,
                    event="intake_routed", metadata={"kind": "new_referral", "patient_chosen": bool(patient_id)})
        if patient_id:
            self.store.append_event("intake_patient_matched", actor=context.actor, practice_id=context.practice_id,
                                    referral_id=referral_id, metadata={"item_id": item_id, "patient_id": linked})
        self.intake.run_triage(context, referral_id)
        return self.intake.detail(context, referral_id)

    def attach(self, context: PracticeContext, item_id: str, referral_id: str) -> dict:
        item = self._item(context, item_id)
        self._require_open(item)
        referral = self.intake.get(context, referral_id)  # 404 across practices
        if referral.status in {"accepted", "redirected", "declined"}:
            raise PilotError("referral_closed", "This referral is closed")
        self._attach_documents(context, item, referral_id)
        self._close(context, item, status="routed", kind="attached", referral_id=referral_id, patient_id=referral.patient_id,
                    event="intake_routed", metadata={"kind": "attached"})
        self.intake.run_triage(context, referral_id)
        return self.intake.detail(context, referral_id)

    def reply_to_request(self, context: PracticeContext, item_id: str, request_id: str) -> dict:
        """A person confirmed this answers an open information request: its documents join the
        referral as the reply (the same path as a sender upload), then Verify as usual."""
        item = self._item(context, item_id)
        self._require_open(item)
        request = self.store.fetch_one("SELECT * FROM missing_information_requests WHERE id = ? AND practice_id = ?",
                                       (request_id, context.practice_id))
        if not request:
            raise PilotError("request_not_found", "Information request not found", 404)
        if request["status"] not in {"sent", "partially_resolved"}:
            raise PilotError("request_not_open", "That request is not waiting for a reply", 409)
        referral = self.intake.get(context, request["referral_id"])
        attached = self._attach_documents(context, item, request["referral_id"])
        for document_id in attached:
            self.missing.add_evidence(context.practice_id, request["referral_id"], {"type": "document", "id": document_id,
                                                                                  "channel": item["channel"]})
        self._close(context, item, status="routed", kind="request_reply", referral_id=request["referral_id"],
                    request_id=request_id, patient_id=referral.patient_id, event="intake_request_matched",
                    metadata={"request_id": request_id, "documents": len(attached)})
        self.intake.run_triage(context, request["referral_id"])
        return self.intake.detail(context, request["referral_id"])

    def split(self, context: PracticeContext, item_id: str, ranges: list[tuple[int, int]]) -> dict:
        """One fax carrying several referrals: each page range becomes its own item (re-extracted
        proposals and suggestions). Every page must be in exactly one range -- nothing is dropped."""
        item = self._item(context, item_id)
        self._require_open(item)
        docs = self.store.fetch_all("SELECT * FROM intake_documents WHERE item_id = ? AND practice_id = ? ORDER BY rowid",
                                    (item_id, context.practice_id))
        if len(docs) != 1 or not docs[0]["page_count"]:
            raise PilotError("cannot_split", "Split works on one multi-page document with readable pages", 422)
        doc = docs[0]
        total = doc["page_count"]
        ordered = sorted(ranges)
        covered = [page for start, end in ordered for page in range(start, end + 1)]
        if len(ordered) < 2 or any(start > end or start < 1 or end > total for start, end in ordered) \
                or covered != list(range(1, total + 1)):
            raise PilotError("invalid_split", f"Give at least two page ranges that cover pages 1-{total} once each", 422)
        pages = json.loads(doc["pages_json"])
        now = now_iso()
        children = []
        for start, end in ordered:
            child_id = new_id("itm")
            children.append(child_id)
            self.store.execute([
                (("INSERT INTO intake_items (id, practice_id, channel, status, provider, provider_message_id, from_address, to_address, "
                 "subject, received_at, received_by, parent_item_id, page_from, page_to, updated_at) "
                 "VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
                 (child_id, context.practice_id, item["channel"], item["provider"], item["provider_message_id"], item["from_address"],
                  item["to_address"], item["subject"], item["received_at"], item["received_by"], item_id, start, end, now)),
                (("INSERT INTO intake_documents (id, practice_id, item_id, role, filename, content_type, size_bytes, sha256, storage_key, "
                 "extraction_status, extractor, pages_json, page_count, page_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
                 (new_id("idoc"), context.practice_id, child_id, doc["role"], doc["filename"], doc["content_type"], doc["size_bytes"],
                  doc["sha256"], doc["storage_key"], doc["extraction_status"], doc["extractor"], json.dumps(pages[start - 1:end]),
                  end - start + 1, start - 1, now)),
            ])
            self._propose(context.practice_id, child_id, context.actor)
        self._close(context, item, status="split", event="intake_split",
                    metadata={"ranges": [[start, end] for start, end in ordered], "children": children})
        return self.detail(context, item_id)

    def dismiss(self, context: PracticeContext, item_id: str, reason: str, note: str | None) -> dict:
        if reason not in DISMISS_REASONS:
            raise PilotError("invalid_reason", "Choose a reason: " + ", ".join(DISMISS_REASONS), 422)
        if reason == "other" and not (note or "").strip():
            raise PilotError("note_required", "Say why it is being dismissed", 422)
        item = self._item(context, item_id)
        self._require_open(item)
        self._close(context, item, status="dismissed", reason=reason, note=(note or "").strip()[:500] or None,
                    event="intake_dismissed", metadata={"reason": reason})
        return self.detail(context, item_id)

    def restore(self, context: PracticeContext, item_id: str) -> dict:
        """A dismissed item is never gone: it can come back to the inbox."""
        item = self._item(context, item_id)
        if item["status"] != "dismissed":
            raise PilotError("not_dismissed", "Only a dismissed item can be restored", 409)
        self.store.execute([(
            ("UPDATE intake_items SET status = 'needs_review', dismissed_reason = NULL, dismissed_note = NULL, handled_by = NULL, "
            "handled_at = NULL, updated_at = ? WHERE id = ? AND practice_id = ? AND status = 'dismissed'"),
            (now_iso(), item_id, context.practice_id))],
            events=[{"event_type": "intake_restored", "actor": context.actor, "practice_id": context.practice_id,
                     "metadata": {"item_id": item_id, "previous_reason": item["dismissed_reason"], "role": context.role}}])
        return self.detail(context, item_id)

    # ------------------------------------------------------------------- inbound

    def inbound_address(self, channel: str, address: str) -> dict | None:
        return self.store.fetch_one("SELECT * FROM practice_inbound_addresses WHERE channel = ? AND address = ? AND active = 1",
                                    (channel, address.strip().casefold()))

    def addresses(self, context: PracticeContext) -> list[dict]:
        return [{"id": row["id"], "channel": row["channel"], "address": row["address"], "provider": row["provider"],
                 "created_at": row["created_at"]} for row in self.store.fetch_all(
            "SELECT * FROM practice_inbound_addresses WHERE practice_id = ? AND active = 1 ORDER BY created_at", (context.practice_id,))]

    def add_address(self, context: PracticeContext, channel: str, address: str | None, provider: str) -> list[dict]:
        """An admin registers the practice's dedicated fax number or gets an intake email address."""
        context.require_admin("set up the practice's fax or email intake")
        if channel == "email":
            slug = "".join(ch for ch in (context.practice.get("name") or "practice").casefold() if ch.isalnum())[:20] or "practice"
            address = f"intake-{slug}-{new_id('x')[-6:]}@inbound.lamina.test"
        else:
            number = digits(address)
            if not number:
                raise PilotError("invalid_fax_number", "Enter the practice's fax number", 422)
            address = number
        try:
            self.store.execute([(
                ("INSERT INTO practice_inbound_addresses (id, practice_id, channel, address, provider, active, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, 1, ?, ?)"), (new_id("inb"), context.practice_id, channel, address.casefold(), provider,
                                                    context.actor, now_iso()))],
                events=[{"event_type": "intake_address_added", "actor": context.actor, "practice_id": context.practice_id,
                         "metadata": {"channel": channel, "provider": provider}}])
        except Exception as error:
            raise PilotError("address_taken", "That address is already registered", 409) from error
        return self.addresses(context)

    def receive_inbound(self, message: Any) -> dict:
        """A verified vendor event. Replays return the original outcome; unknown addresses are
        recorded and refused (the vendor retries / alerts) -- never silently dropped."""
        from .inbound import WebhookRejected

        previous = self.store.fetch_one("SELECT * FROM inbound_webhook_receipts WHERE provider = ? AND provider_event_id = ?",
                                        (f"{message.channel}:{message.provider}", message.event_id))
        if previous:
            return {"duplicate": True, "outcome": previous["outcome"]}
        lookup = digits(message.to_address) if message.channel == "fax" else message.to_address.strip().casefold()
        address = self.inbound_address(message.channel, lookup or "")
        receipt_id = new_id("whr")
        if not address:
            self.store.execute([(
                ("INSERT INTO inbound_webhook_receipts (id, channel, provider, provider_event_id, practice_id, outcome, item_id, received_at) "
                "VALUES (?, ?, ?, ?, NULL, 'unroutable', NULL, ?)"),
                (receipt_id, message.channel, f"{message.channel}:{message.provider}", message.event_id, now_iso()))])
            raise WebhookRejected(404, "unknown_address", "No practice receives at that address")
        files = [ReceivedFile(attachment.filename, attachment.content_type, attachment.content) for attachment in message.attachments]
        if message.channel == "email" and (message.body_text or "").strip():
            files.insert(0, ReceivedFile("email-body.txt", "text/plain", message.body_text.encode("utf-8")[:1_000_000], role="email_body"))
        try:
            self.receive(address["practice_id"], channel=message.channel, actor=f"inbound:{message.channel}:{message.provider}",
                         files=files, provider=message.provider, provider_message_id=message.event_id,
                         from_address=message.from_address, to_address=message.to_address, subject=message.subject,
                         receipt=(receipt_id, message.channel, f"{message.channel}:{message.provider}", message.event_id))
        except PilotError as error:
            raise WebhookRejected(error.status_code or 422, error.code, error.message) from error
        except Exception:
            if self.store.fetch_one("SELECT id FROM inbound_webhook_receipts WHERE provider = ? AND provider_event_id = ?",
                                    (f"{message.channel}:{message.provider}", message.event_id)):
                return {"duplicate": True, "outcome": "accepted"}
            raise
        return {"duplicate": False, "outcome": "accepted"}
