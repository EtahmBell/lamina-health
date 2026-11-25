-- Run 3: the intake pipeline and basic patient identity. Converted from the SQLite schema in
-- backend/pilot/store.py (_SCHEMA_V9) by scripts/pg_schema_from_sqlite.py, then reviewed.

CREATE TABLE patients (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  date_of_birth TEXT,
  phone_digits TEXT,
  mrn TEXT,
  merged_into_id TEXT REFERENCES patients(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE patient_merges (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  action TEXT NOT NULL CHECK(action IN ('merge', 'unmerge')),
  survivor_id TEXT NOT NULL REFERENCES patients(id),
  merged_id TEXT NOT NULL REFERENCES patients(id),
  referral_ids_json TEXT NOT NULL,
  reverses_id TEXT REFERENCES patient_merges(id),
  reason TEXT,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE practice_inbound_addresses (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  channel TEXT NOT NULL CHECK(channel IN ('fax', 'email')),
  address TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE intake_items (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  channel TEXT NOT NULL CHECK(channel IN ('upload', 'fax', 'email', 'public_form')),
  status TEXT NOT NULL CHECK(status IN ('received', 'extracted', 'needs_review', 'routed', 'split', 'dismissed')),
  provider TEXT,
  provider_message_id TEXT,
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  received_at TEXT NOT NULL,
  received_by TEXT NOT NULL,
  parent_item_id TEXT REFERENCES intake_items(id),
  page_from BIGINT,
  page_to BIGINT,
  extraction_json TEXT,
  suggestions_json TEXT,
  routed_kind TEXT CHECK(routed_kind IN ('new_referral', 'attached', 'request_reply')),
  routed_referral_id TEXT REFERENCES intake_referrals(id),
  routed_request_id TEXT REFERENCES missing_information_requests(id),
  patient_id TEXT REFERENCES patients(id),
  dismissed_reason TEXT,
  dismissed_note TEXT,
  handled_by TEXT,
  handled_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE intake_documents (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  item_id TEXT NOT NULL REFERENCES intake_items(id),
  role TEXT NOT NULL CHECK(role IN ('file', 'email_body')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  extraction_status TEXT NOT NULL,
  extractor TEXT,
  pages_json TEXT,
  page_count BIGINT,
  page_offset BIGINT NOT NULL DEFAULT 0,
  referral_document_id TEXT REFERENCES referral_documents(id),
  created_at TEXT NOT NULL
);
CREATE TABLE inbound_webhook_receipts (
  _rowid BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK(channel IN ('fax', 'email')),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  practice_id TEXT REFERENCES practices(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'unroutable')),
  item_id TEXT REFERENCES intake_items(id),
  received_at TEXT NOT NULL,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX patients_practice_dob ON patients(practice_id, date_of_birth);
CREATE INDEX patients_practice_name ON patients(practice_id, name_key);
CREATE INDEX intake_items_practice_status ON intake_items(practice_id, status, received_at);
CREATE INDEX intake_documents_item ON intake_documents(practice_id, item_id);
ALTER TABLE intake_referrals ADD COLUMN patient_id TEXT REFERENCES patients(id);
CREATE INDEX intake_referrals_patient ON intake_referrals(practice_id, patient_id);
