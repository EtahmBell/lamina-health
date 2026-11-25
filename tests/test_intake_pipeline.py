"""Run 3: the intake pipeline -- adapters (upload, fax, email), signatures and replay protection,
extraction and field proposals, routing (create, attach, request reply, split, dismiss/restore),
patient identity (suggest, merge, unmerge), permissions and practice isolation, audit events.
Synthetic fixtures only (scripts/intake_fixtures.py); every model and vendor is a mock."""

from __future__ import annotations

import base64
import json
import time

import pytest

from backend.pilot import extraction as ex
from backend.pilot.inbound import sign
from scripts import intake_fixtures as fx
from tests.test_pilot_foundation import NPI_B, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h

FAX_SECRET = "synthetic-fax-webhook-secret-0123456789abcdef"
EMAIL_SECRET = "synthetic-email-webhook-secret-0123456789abcdef"
BASE = "/api/me/practice"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LAMINA_OPENAI_ENABLED", "false")
    monkeypatch.setenv("LAMINA_FAX_PROVIDER", "mock")
    monkeypatch.setenv("LAMINA_FAX_WEBHOOK_SECRET", FAX_SECRET)
    monkeypatch.setenv("LAMINA_EMAIL_PROVIDER", "mock")
    monkeypatch.setenv("LAMINA_EMAIL_WEBHOOK_SECRET", EMAIL_SECRET)
    from backend.pilot.public_api import limiter

    limiter.reset()


def _ready(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()
    pilot.add_staff()


def _upload(pilot: Pilot, user: str, name: str, *, item_id: str | None = None, content: bytes | None = None,
            content_type: str | None = None):
    data = content if content is not None else fx.FIXTURES[name]()
    kind = content_type or ("application/pdf" if name.endswith(".pdf") else "image/png")
    url = f"{BASE}/intake/items/{item_id}/files" if item_id else f"{BASE}/intake/items"
    return pilot.client.post(url, headers={**_h(user), "content-type": kind, "x-filename": name}, content=data)


def _fax(pilot: Pilot, name: str, *, to: str = "5550109000", sender: str = "(555) 010-0199", event: str | None = None,
         secret: str = FAX_SECRET, at: int | None = None):
    body = json.dumps({"event_id": event or f"fax-{name}-{time.time_ns()}", "to": to, "from": sender,
                       "document": {"filename": name, "content_type": "application/pdf",
                                    "data_base64": base64.b64encode(fx.FIXTURES[name]()).decode()}}).encode()
    signature = sign(secret, at or int(time.time()), body)
    return pilot.client.post("/api/public/inbound/fax/mock", content=body,
                             headers={"content-type": "application/json", "x-lamina-mock-signature": signature})


def _fax_address(pilot: Pilot) -> None:
    response = pilot.post(f"{BASE}/intake/addresses", "user-a", {"channel": "fax", "address": "(555) 010-9000"})
    assert response.status_code == 201, response.text


def _events(pilot: Pilot, kind: str) -> list[dict]:
    return pilot.store.events(event_type=kind)


# ---------------------------------------------------------------- upload -> extract -> verify -> triage


def test_upload_extract_create_referral_and_triage_with_proposals_never_verified(pilot: Pilot) -> None:
    _ready(pilot)
    created = _upload(pilot, "user-c", "old-result-referral.pdf")
    assert created.status_code == 201, created.text
    item = created.json()
    assert item["channel"] == "upload" and item["status"] == "extracted" and item["page_count"] == 1
    fields = item["extraction"]["fields"]
    assert fields["patient_name"]["value"] == "Avery Quartz-Synthetic" and fields["date_of_birth"]["value"] == "1959-05-30"
    assert fields["patient_name"]["page"] == 1 and len(fields["patient_name"]["bbox"]) == 4, "page and region"
    assert fields["referral_type"]["matched_type"] == "Diabetes management"
    assert item["suggestions"]["referral_type"] == "Diabetes management"
    assert {result["date"] for result in item["extraction"]["results"]} == {"2025-12-01", "2026-09-30"}
    # Staff confirm the (prefilled, editable) fields: a referral, its patient record, its documents, triage.
    detail = pilot.post(f"{BASE}/intake/items/{item['id']}/create-referral", "user-c", {"referral": {
        "sender": {"name": fields["referring_clinician"]["value"], "practice": fields["referring_practice"]["value"],
                   "contact": fields["contact"]["value"]},
        "patient": {"name": fields["patient_name"]["value"], "date_of_birth": fields["date_of_birth"]["value"]},
        "referral_type": "Diabetes management", "reason": fields["referral_question"]["value"]}}).json()
    referral = detail["referral"]
    assert referral["patient_id"] and referral["documents"][0]["page_count"] == 1
    requirements = {item["key"]: item for item in detail["recommendation"]["requirements"]}
    a1c = requirements["recent_a1c"]
    assert a1c["state"] == "proposed_from_document", "a proposal for a person to confirm -- never satisfied"
    assert a1c["window_status"] == "outside" and "outside the rule’s 180-day window" in a1c["detail"]
    assert all(item["state"] != "satisfied" for item in requirements.values())
    routed = pilot.get(f"{BASE}/intake/items/{item['id']}", "user-c").json()
    assert routed["status"] == "routed" and routed["routed_kind"] == "new_referral" and routed["routed_referral_id"] == referral["id"]
    assert pilot.get(f"{BASE}/intake/items", "user-c").json() == [], "the inbox is empty once routed"
    assert pilot.post(f"{BASE}/intake/items/{item['id']}/dismiss", "user-c", {"reason": "junk"}).status_code == 409
    # A person confirms the document value (Verify); only then can it count.
    record = pilot.post(f"{BASE}/referrals/{referral['id']}/items", "user-c", {
        "key": "renal_function", "value": "Creatinine 0.9 mg/dL", "observed_date": "2026-09-30",
        "document_id": referral["documents"][0]["id"], "page": 1})
    assert record.status_code == 200, record.text
    states = {item["key"]: item["state"] for item in record.json()["recommendation"]["requirements"]}
    assert states["renal_function"] == "satisfied"


def test_several_files_per_item_and_file_safety(pilot: Pilot) -> None:
    _ready(pilot)
    item = _upload(pilot, "user-c", "thyroid-referral.pdf").json()
    more = _upload(pilot, "user-c", "osteoporosis-referral-scan.png", item_id=item["id"])
    assert more.status_code == 201 and more.json()["document_count"] == 2 and more.json()["page_count"] == 3
    for content, kind, code in (
        (b"MZ\x90\x00 executable", "application/pdf", "document_rejected"),
        (b"\x7fELF binary", "image/png", "document_rejected"),
        (b"#!/bin/sh\necho hi", "text/plain", "document_rejected"),
        (b"PK\x03\x04zipfile", "application/pdf", "document_rejected"),
        (b"%PDF-1.4 fine", "application/x-msdownload", "document_rejected"),
        (b"not really a png", "image/png", "document_rejected"),
    ):
        refused = _upload(pilot, "user-c", "x.bin", content=content, content_type=kind)
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == code, (content, refused.text)
    too_big = _upload(pilot, "user-c", "big.pdf", content=b"%PDF-" + b"0" * (16 * 1024 * 1024))
    assert too_big.status_code == 413
    assert len(pilot.get(f"{BASE}/intake/items", "user-c").json()) == 1, "refused files never become items"


def test_extraction_failure_lands_in_the_inbox_for_review(pilot: Pilot) -> None:
    _ready(pilot)
    scanned = _upload(pilot, "user-c", "real-scan.png", content=b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).json()
    assert scanned["status"] == "needs_review" and scanned["extraction_problem"] is True
    assert [item["id"] for item in pilot.get(f"{BASE}/intake/items", "user-c").json()] == [scanned["id"]]


# --------------------------------------------------------------------------------- fax / email


def test_fax_webhook_signature_replay_and_unknown_address(pilot: Pilot) -> None:
    _ready(pilot)
    _fax_address(pilot)
    good = _fax(pilot, "thyroid-referral.pdf", event="evt-1")
    assert good.status_code == 200 and good.json() == {"received": True, "duplicate": False, "outcome": "accepted"}
    replay = _fax(pilot, "thyroid-referral.pdf", event="evt-1")
    assert replay.status_code == 200 and replay.json()["duplicate"] is True
    items = pilot.get(f"{BASE}/intake/items", "user-c").json()
    assert len(items) == 1 and items[0]["channel"] == "fax" and items[0]["from_address"] == "(555) 010-0199"
    assert _fax(pilot, "thyroid-referral.pdf", secret="x" * 40).status_code == 401, "wrong signature"
    assert _fax(pilot, "thyroid-referral.pdf", at=int(time.time()) - 3600).status_code == 401, "stale timestamp"
    unknown = _fax(pilot, "thyroid-referral.pdf", to="5550000000", event="evt-unknown")
    assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "unknown_address"
    receipts = pilot.store.fetch_all("SELECT provider_event_id, outcome FROM inbound_webhook_receipts ORDER BY received_at")
    assert {(row["provider_event_id"], row["outcome"]) for row in receipts} == {("evt-1", "accepted"), ("evt-unknown", "unroutable")}
    assert pilot.client.post("/api/public/inbound/fax/othervendor", content=b"{}").status_code == 404, "only the configured vendor"
    # Nothing in the audit trail carries document text.
    trail = json.dumps(pilot.store.events(), ensure_ascii=False)
    assert "Lumen-Synthetic" not in trail and "TI-RADS" not in trail


def test_email_body_and_attachments_become_documents(pilot: Pilot) -> None:
    _ready(pilot)
    address = pilot.post(f"{BASE}/intake/addresses", "user-a", {"channel": "email"}).json()[0]["address"]
    assert address.startswith("intake-") and address.endswith("@inbound.lamina.test")
    body = json.dumps({"event_id": "mail-1", "to": address.upper(), "from": "office@placeholder.test", "subject": "Referral",
                       "text": "Please see the attached referral for Robin Lumen-Synthetic.",
                       "attachments": [{"filename": "thyroid-referral.pdf", "content_type": "application/pdf",
                                        "data_base64": base64.b64encode(fx.FIXTURES["thyroid-referral.pdf"]()).decode()}]}).encode()
    response = pilot.client.post("/api/public/inbound/email/mock", content=body, headers={
        "x-lamina-mock-signature": sign(EMAIL_SECRET, int(time.time()), body)})
    assert response.status_code == 200, response.text
    item = pilot.get(f"{BASE}/intake/items", "user-c").json()[0]
    detail = pilot.get(f"{BASE}/intake/items/{item['id']}", "user-c").json()
    assert [doc["role"] for doc in detail["documents"]] == ["email_body", "file"]
    assert detail["subject"] == "Referral" and detail["page_count"] == 3


# ----------------------------------------------------------------------------------- routing


def _referral_with_open_request(pilot: Pilot) -> tuple[str, str]:
    rule = {"referral_type": "Thyroid nodule", "good_fit": ["thyroid nodule"], "outside_scope": [],
            "required": [{"key": "tsh", "label": "TSH result", "required": True, "freshness_days": 90}],
            "helpful": [], "urgent_signals": [], "modality": "either"}
    pilot.add_rule(rule=rule)
    rid = pilot.referral("user-c", sender={"name": "Dr. Casey Placeholder (SYNTHETIC)", "contact": "fax (555) 010-0199"},
                         patient={"name": "Robin Lumen-Synthetic", "date_of_birth": "1968-03-14"},
                         referral_type="Thyroid nodule", reason="Incidental thyroid nodule")["referral"]["id"]
    drafted = pilot.post(f"{BASE}/referrals/{rid}/request-information", "user-c", {}).json()
    request_id = drafted["information_requests"][0]["id"]
    sent = pilot.post(f"{BASE}/information-requests/{request_id}/send", "user-c", {"mode": "mark_sent"})
    assert sent.status_code == 200, sent.text
    return rid, request_id


def test_a_faxed_reply_is_suggested_for_its_request_then_goes_through_verify(pilot: Pilot) -> None:
    _ready(pilot)
    _fax_address(pilot)
    _rid, request_id = _referral_with_open_request(pilot)
    assert _fax(pilot, "info-reply-fax.pdf").status_code == 200
    item = pilot.get(f"{BASE}/intake/items", "user-c").json()[0]
    assert item["has_request_match"] is True
    detail = pilot.get(f"{BASE}/intake/items/{item['id']}", "user-c").json()
    match = detail["suggestions"]["requests"][0]
    assert match["request_id"] == request_id and "from the fax/phone the request went to" in match["reasons"]
    referral = pilot.post(f"{BASE}/intake/items/{item['id']}/reply", "user-c", {"request_id": request_id}).json()
    tsh = next(item for item in referral["recommendation"]["requirements"] if item["key"] == "tsh")
    assert tsh["state"] == "proposed_from_document" and tsh["window_status"] == "within", ("proposed; a person verifies", tsh)
    request = next(item for item in referral["information_requests"] if item["id"] == request_id)
    assert request["status"] == "partially_resolved"
    assert _events(pilot, "intake_request_matched")[0]["metadata"]["request_id"] == request_id
    assert pilot.get(f"{BASE}/intake/items/{item['id']}", "user-c").json()["routed_request_id"] == request_id


def test_split_a_fax_with_two_referrals_by_page(pilot: Pilot) -> None:
    _ready(pilot)
    item = _upload(pilot, "user-c", "multi-referral-fax.pdf").json()
    assert [found["page"] for found in item["extraction"]["patients_found"]] == [1, 3] and item["several_patients"] == 2
    for bad in ([[1, 2], [4, 4]], [[1, 3], [3, 4]], [[1, 4]], [[0, 1], [2, 4]]):
        refused = pilot.post(f"{BASE}/intake/items/{item['id']}/split", "user-c", {"ranges": bad})
        assert refused.status_code == 422, bad
    split = pilot.post(f"{BASE}/intake/items/{item['id']}/split", "user-c", {"ranges": [[1, 2], [3, 4]]}).json()
    assert split["status"] == "split" and [child["page_from"] for child in split["children"]] == [1, 3]
    names = {child["patient_name"] for child in split["children"]}
    assert names == {"Quinn Harbor-Synthetic", "Sasha Meridian-Synthetic"}, "each part re-extracted on its own pages"
    open_items = pilot.get(f"{BASE}/intake/items", "user-c").json()
    assert {entry["parent_item_id"] for entry in open_items} == {item["id"]} and len(open_items) == 2
    second = next(child for child in split["children"] if child["page_from"] == 3)
    attached = pilot.post(f"{BASE}/intake/items/{second['id']}/attach", "user-c",
                          {"referral_id": pilot.referral("user-c")["referral"]["id"]}).json()
    document = attached["referral"]["documents"][-1]
    assert document["filename"].endswith("(pages 3-4).pdf") and document["page_count"] == 2
    assert _events(pilot, "intake_split")[0]["metadata"]["ranges"] == [[1, 2], [3, 4]]


def test_dismiss_with_a_reason_and_restore(pilot: Pilot) -> None:
    _ready(pilot)
    item = _upload(pilot, "user-c", "junk-fax-scan.png").json()
    assert pilot.post(f"{BASE}/intake/items/{item['id']}/dismiss", "user-c", {"reason": "spam"}).status_code == 422
    assert pilot.post(f"{BASE}/intake/items/{item['id']}/dismiss", "user-c", {"reason": "other"}).status_code == 422
    dismissed = pilot.post(f"{BASE}/intake/items/{item['id']}/dismiss", "user-c", {"reason": "junk", "note": "Toner ad"}).json()
    assert dismissed["status"] == "dismissed" and dismissed["dismissed_reason"] == "junk"
    assert pilot.get(f"{BASE}/intake/items", "user-c").json() == []
    assert [entry["id"] for entry in pilot.get(f"{BASE}/intake/items?view=dismissed", "user-c").json()] == [item["id"]]
    restored = pilot.post(f"{BASE}/intake/items/{item['id']}/restore", "user-c").json()
    assert restored["status"] == "needs_review", "never silently dropped: it can come back"
    assert [e["event_type"] for e in pilot.store.events() if e["event_type"] in {"intake_dismissed", "intake_restored"}] == \
        ["intake_dismissed", "intake_restored"]


# ------------------------------------------------------------------------------ patient identity


def test_duplicate_patients_are_suggested_never_merged_and_merges_are_reversible(pilot: Pilot) -> None:
    _ready(pilot)
    first = pilot.referral("user-c", patient={"name": "Rivera-Synthetic, Morgan", "date_of_birth": "1980-04-12",
                                              "phone": "(555) 010-0456"})["referral"]
    item = _upload(pilot, "user-c", "duplicate-patient-b-scan.png").json()
    suggestion = item["suggestions"]["patients"][0]
    assert suggestion["patient"]["id"] == first["patient_id"] and suggestion["strength"] == "strong"
    assert {"same name", "same date of birth", "same phone"} <= set(suggestion["reasons"])
    # Not chosen: a NEW record (never matched automatically) -- now a possible duplicate.
    second = pilot.post(f"{BASE}/intake/items/{item['id']}/create-referral", "user-c", {"referral": {
        "sender": {"name": "Dr. Riley Sample"}, "patient": {"name": "MORGAN RIVERA-SYNTHETIC", "date_of_birth": "1980-04-12"},
        "referral_type": "Diabetes management", "reason": "Follow-up"}}).json()["referral"]
    assert second["patient_id"] != first["patient_id"]
    page = pilot.get(f"{BASE}/patients/{second['patient_id']}", "user-c").json()
    assert page["possible_duplicates"][0]["patient"]["id"] == first["patient_id"]
    merged = pilot.post(f"{BASE}/patients/{second['patient_id']}/merge", "user-c",
                        {"into_patient_id": first["patient_id"], "reason": "Same DOB and phone"})
    assert merged.status_code == 200, merged.text
    survivor = merged.json()
    assert {item["id"] for item in survivor["referrals"]} == {first["id"], second["id"]}
    merge_id = survivor["merges"][0]["id"]
    assert pilot.post(f"{BASE}/patients/{second['patient_id']}/merge", "user-c", {"into_patient_id": first["patient_id"]}).status_code == 409
    undone = pilot.post(f"{BASE}/patient-merges/{merge_id}/undo", "user-c", {"reason": "Different people"}).json()
    assert [item["id"] for item in undone["referrals"]] == [second["id"]] and undone["patient"]["merged_into_id"] is None
    assert pilot.post(f"{BASE}/patient-merges/{merge_id}/undo", "user-c", {}).status_code == 409
    rows = pilot.store.fetch_all("SELECT action, reverses_id FROM patient_merges ORDER BY created_at")
    assert [row["action"] for row in rows] == ["merge", "unmerge"] and rows[1]["reverses_id"] == merge_id
    assert [e["event_type"] for e in pilot.store.events() if e["event_type"].startswith("patient_")] == \
        ["patient_merged", "patient_unmerged"]
    # Choosing the suggested record links the referral to it (still a person's choice).
    again = _upload(pilot, "user-c", "duplicate-patient-a.pdf").json()
    linked = pilot.post(f"{BASE}/intake/items/{again['id']}/create-referral", "user-c", {"patient_id": first["patient_id"], "referral": {
        "sender": {"name": "Dr. Riley Sample"}, "patient": {"name": "Rivera-Synthetic, Morgan", "date_of_birth": "1980-04-12"},
        "referral_type": "Diabetes management", "reason": "Low bone density"}}).json()["referral"]
    assert linked["patient_id"] == first["patient_id"]


# ------------------------------------------------------------------------- permissions & isolation


def test_other_practices_and_anonymous_callers_see_nothing(pilot: Pilot) -> None:
    _ready(pilot)
    item = _upload(pilot, "user-c", "thyroid-referral.pdf").json()
    patient = pilot.referral("user-c")["referral"]["patient_id"]
    other_patient = pilot.referral("user-c")["referral"]["patient_id"]
    pilot.ready_physician("user-b", NPI_B)  # a second, separate practice
    assert pilot.get(f"{BASE}/intake/items", "user-b").json() == []
    for path in (f"{BASE}/intake/items/{item['id']}", f"{BASE}/intake/documents/{item['id']}", f"{BASE}/patients/{patient}"):
        assert pilot.get(path, "user-b").status_code == 404, path
    assert pilot.post(f"{BASE}/intake/items/{item['id']}/dismiss", "user-b", {"reason": "junk"}).status_code == 404
    assert pilot.post(f"{BASE}/patients/{patient}/merge", "user-b", {"into_patient_id": other_patient}).status_code == 404
    assert pilot.client.get(f"{BASE}/intake/items").status_code == 401
    # Staff and physicians of the practice can both see and act (physicians read-only in the UI by default).
    detail = pilot.get(f"{BASE}/intake/items/{item['id']}", "user-a").json()
    assert detail["can_act"] is True
    document = detail["documents"][0]
    preview = pilot.get(f"{BASE}/intake/documents/{document['id']}", "user-a")
    assert preview.status_code == 200 and preview.headers["cache-control"] == "no-store, private"
    assert "sandbox" in preview.headers["content-security-policy"]
    # Only an admin sets up the practice's fax/email intake.
    assert pilot.post(f"{BASE}/intake/addresses", "user-c", {"channel": "email"}).status_code == 403


def test_home_shows_intake_items_to_whoever_does_the_paperwork(pilot: Pilot) -> None:
    _ready(pilot)
    _upload(pilot, "user-c", "thyroid-referral.pdf")
    staff = [item for item in pilot.get(f"{BASE}/home", "user-c").json()["needs_you"] if item["kind"] == "intake_waiting"]
    assert staff and staff[0]["title"] == "1 received document waiting in Intake" and staff[0]["path"] == "/me/intake"
    physician = [item for item in pilot.get(f"{BASE}/home", "user-a").json()["needs_you"] if item["kind"] == "intake_waiting"]
    assert physician == [], "the practice has staff: the physician isn't asked to do the paperwork"


# ------------------------------------------------------------------------------- extraction units


def test_textract_blocks_map_to_pages_lines_and_regions(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeTextract:
        def __init__(self) -> None:
            self.calls = []

        def detect_document_text(self, **kwargs):
            self.calls.append(("detect", kwargs))
            return {"Blocks": [
                {"BlockType": "PAGE", "Page": 1},
                {"BlockType": "LINE", "Page": 1, "Text": "Patient: Robin Lumen-Synthetic",
                 "Geometry": {"BoundingBox": {"Left": 0.1, "Top": 0.2, "Width": 0.5, "Height": 0.03}}},
                {"BlockType": "LINE", "Page": 1, "Text": "DOB: 03/14/1968",
                 "Geometry": {"BoundingBox": {"Left": 0.1, "Top": 0.25, "Width": 0.3, "Height": 0.03}}},
            ]}

        def start_document_text_detection(self, **kwargs):
            self.calls.append(("start", kwargs))
            return {"JobId": "job-1"}

        def get_document_text_detection(self, **kwargs):
            self.calls.append(("get", kwargs))
            return {"JobStatus": "SUCCEEDED", "Blocks": [
                {"BlockType": "LINE", "Page": 2, "Text": "TSH 1.2 (2026-10-30)", "Geometry": {"BoundingBox": {}}}]}

    client = FakeTextract()
    textract = ex.TextractExtractor(client, approved=True)
    image = textract.extract(b"\x89PNG...", "image/png")
    assert image.status == "extracted" and image.pages[0].lines[0].bbox == [0.1, 0.2, 0.5, 0.03]
    fields = ex.propose_fields(image.pages, [])["fields"]
    assert fields["date_of_birth"]["value"] == "1968-03-14" and fields["date_of_birth"]["bbox"] == [0.1, 0.25, 0.3, 0.03]
    pdf = textract.extract(b"%PDF-", "application/pdf", location={"bucket": "b", "key": "k"})
    assert [call[0] for call in client.calls[1:]] == ["start", "get"] and len(pdf.pages) == 2 and pdf.pages[0].text == ""
    monkeypatch.setenv("LAMINA_PROFILE", "production")
    with pytest.raises(ex.ExtractionNotApprovedError):
        ex.guarded_extract(ex.LocalTextExtractor(), b"x", "text/plain")
    with pytest.raises(ex.ExtractionNotApprovedError):
        ex.guarded_extract(ex.TextractExtractor(client, approved=False), b"x", "image/png")
    assert ex.guarded_extract(textract, b"\x89PNG", "image/png").status == "extracted"
    monkeypatch.setenv("LAMINA_PROFILE", "demo")
    assert ex.TextractExtractor(client, approved=True).approved_for_patient_data is False, "never on the synthetic deployment"


def test_model_field_proposals_must_quote_their_page() -> None:
    pages = ex.LocalTextExtractor().extract(fx.FIXTURES["thyroid-referral.pdf"](), "application/pdf").pages

    class Model:
        def structured(self, *_args, **kwargs):
            assert kwargs["contains_patient_data"] is True
            return {"fields": [
                {"field": "patient_name", "value": "Robin Lumen-Synthetic", "page": 1, "quote": "Patient: Robin Lumen-Synthetic"},
                {"field": "date_of_birth", "value": "1968-03-14", "page": 1, "quote": "DOB: 1968-03-14"},
                {"field": "mrn", "value": "SYN-99999", "page": 1, "quote": "MRN: SYN-99999"},  # not on the page
                {"field": "contact", "value": "(555) 010-0199", "page": 2, "quote": "Fax: (555) 010-0199"},  # wrong page
            ], "results": [
                {"label": "TSH", "date": "2026-10-30", "page": 2, "quote": "TSH 1.2 mIU/L (2026-10-30)."},
                {"label": "Thyroid US", "date": "2026-01-01", "page": 2, "quote": "Neck ultrasound 2026-10-12: 1.8 cm TI-RADS 4 nodule, right lobe."},
            ]}

    proposals = ex.model_proposals(Model(), pages, ["Thyroid nodule"])
    assert set(proposals["fields"]) == {"patient_name", "date_of_birth"}, "unquoted or misplaced values are dropped"
    assert proposals["fields"]["patient_name"]["page"] == 1 and proposals["fields"]["patient_name"]["source"] == "model"
    assert [(item["label"], item["date"]) for item in proposals["results"]] == [("TSH", "2026-10-30"), ("Thyroid US", None)], \
        "a date the quote doesn't contain is not kept"
