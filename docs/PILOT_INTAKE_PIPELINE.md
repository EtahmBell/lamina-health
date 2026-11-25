# Intake pipeline (run 3)

One shared pipeline, several adapters:

```
document received ─► stored (DocumentStorage: local dev/e2e, S3 + KMS production)
                  ─► text extracted (TextExtractor: local dev/e2e, Amazon Textract production)
                  ─► fields PROPOSED (page + region) and suggestions (patient match, referral type,
                     an open information request it may answer, existing referrals)
                  ─► a person routes it in the staff Intake inbox:
                       create a referral │ attach to a referral │ attach as a request reply
                       split by page │ dismiss with a reason (restorable)
                  ─► normal triage ─► Verify (a person confirms each document value)
```

Code: `backend/pilot/inbox.py` (pipeline + routing), `inbound.py` (fax/email adapters),
`extraction.py` (extractors + field proposals), `patients.py` (identity), routes in `api.py`
(`/api/me/practice/intake/*`, `/patients/*`, `/patient-merges/*`) and `public_api.py`
(`/api/public/inbound/{fax|email}/{vendor}` — the only unauthenticated additions). UI:
`frontend/src/PilotIntake.tsx` (Intake inbox, patient record).

## Adapters

| Channel | Interface | Mock | How a real vendor plugs in |
|---|---|---|---|
| Manual upload | `POST /intake/items` (raw body, one file per request; more files join the item via `/files`) | — | — |
| Fax | `InboundProvider.verify_and_parse(headers, body, now)` → `InboundMessage` | `MockFaxProvider` | one class (its signature scheme + payload mapping) registered in `inbound.PROVIDERS["fax"]`; `LAMINA_FAX_PROVIDER=<name>`, `LAMINA_FAX_WEBHOOK_SECRET` |
| Email | same interface; body text becomes its own source document, attachments become documents | `MockEmailProvider` | same, `LAMINA_EMAIL_PROVIDER`, `LAMINA_EMAIL_WEBHOOK_SECRET` |
| Public referral page | already structured: creates the referral (and its patient record) directly; sender uploads through the status link use the same storage and extraction | — | — |

A practice's dedicated fax number / intake email address is registered by an admin
(`practice_inbound_addresses`); an event for any other address is recorded as `unroutable` and
refused (404) so the vendor retries or alerts — never silently dropped.

## Extraction and proposals

* `local` (dev/e2e): plain text; PDFs drawn with text operators; synthetic "scans" carrying their
  text in a `lamina-synthetic-ocr` metadata chunk. **No OCR** — a real scan is `unsupported` and the
  item lands as `needs_review`.
* `textract` (production): DetectDocumentText for images/single pages; the asynchronous API on the
  stored S3 object for multi-page PDF/TIFF. Mocked in tests.
* Extraction is a **patient-data call**: production requires `LAMINA_EXTRACTION_PROVIDER=textract`
  and `LAMINA_EXTRACTION_PATIENT_DATA_APPROVED=true` (refused at startup and at call time
  otherwise); the demo profile is never approved.
* Proposals: patient name, DOB, MRN, patient phone, referring clinician and practice, contact/fax,
  referral question, referral type (matched to the practice's types), attached results with dates —
  each with page and bounding box. Several distinct `Patient:` names flag "this looks like N
  referrals — split by page". Optional model mapper behind `LAMINA_PILOT_LLM_INTAKE_EXTRACTION_ENABLED`
  (default off; a patient-data call; every value must be quoted from its cited page or it is dropped).
* **Nothing is verified by being proposed.** Staff check the prefilled form; results stay documents —
  triage proposes them (rule-based search, now negation-aware, plus the optional model) with their
  date against the rule's window, and a person confirms.

## Patient identity

A patient record per practice; every referral links to one (`intake_referrals.patient_id`). New
referrals get a NEW record unless staff choose a suggested one. Suggestions: same MRN, or same name
+ DOB → *likely*; same DOB + shared name part, same phone + shared name part → *possible*. Never
auto-merged. A merge moves the merged record's referrals to the survivor and is recorded in the
append-only `patient_merges` with exactly which referrals moved; undo moves them back (only those
still on the survivor). Events `patient_merged` / `patient_unmerged`.

## Safety

* Files: PDF, TIFF, PNG, JPEG (and plain text); magic bytes must match the type; executables and
  archives refused whatever type they claim; 15 MB per file, 20 files / 50 MB per item.
* Webhooks: HMAC-SHA256 over "timestamp.body" (constant-time compare), ±5 minutes, vendor event id
  recorded once in the same transaction as the item (`inbound_webhook_receipts`, unique, append-only),
  40 MB body cap, rate limited per client; only the configured vendor's URL exists.
* Rate limits: uploads 120 per 10 minutes per user; webhooks 300 per minute per client.
* Logs and events never contain document contents (ids, types, sizes, counts only; tested).
* Audit events: `intake_document_received`, `intake_extracted`, `intake_routed`,
  `intake_request_matched`, `intake_patient_matched`, `intake_split`, `intake_dismissed`,
  `intake_restored`, `intake_document_viewed`, `intake_address_added`, `patient_merged`,
  `patient_unmerged`.
* Physicians see Intake read-only until they choose "Act on this item"; staff and physicians may
  act (the backend allows both; isolation is per practice).

## Schema (Alembic `0003_intake_pipeline`)

New tables `patients`, `patient_merges` (append-only), `practice_inbound_addresses`, `intake_items`,
`intake_documents`, `inbound_webhook_receipts` (append-only); `intake_referrals.patient_id`. Triggers
and `lamina_app` privileges as in 0001/0002. The SQLite dev store creates the same tables
(`_SCHEMA_V9`); the drift test checks every column across all migration files.

## Vendor fit (to confirm — nothing was contracted or configured)

Candidates that fit the interface (signed inbound webhooks + document payload or fetch URL); each
must be confirmed to sign a BAA for this use before any PHI:

* **Fax**: HIPAA-oriented cloud fax services with inbound webhooks (for example Documo mFax,
  SRFax, Sinch/Phaxio, Concord, eFax Corporate). Their signature schemes differ (HMAC header vs.
  basic auth + IP allow-list); the adapter class absorbs that.
* **Email**: Amazon SES inbound (HIPAA-eligible under the AWS BAA; stores to S3 and notifies via
  SNS — the adapter would fetch the raw MIME from S3 rather than receive it in the webhook body), or
  a HIPAA email provider such as Paubox. General-purpose inbound-email services often do not sign a
  BAA — check before choosing.
