# Pilot agent layer (Steps 5–12)

Builds on `PILOT_FOUNDATION.md`. Principle: the model proposes; the backend controls state;
humans approve consequential actions.

## Step 5 — Missing-information loop (`backend/pilot/missing_info.py`)

```text
triage flags missing item → "Request information" creates a DRAFT MissingInformationRequest
→ staff/physician edits + approves ("Approve & email" via MailSender, or "I'll fax/send it")
→ a fresh unguessable sender link (/r/<token>, 30 days, hash stored) is embedded in the message
→ sender opens link: limited status, requested items, upload, short response — no account
→ deterministic re-triage; uploads stay "proposed" until staff confirm; sender-entered values for
  requested keys count as sender-submitted evidence (same as the original referral)
→ request becomes partially_resolved / resolved; referral → ready_for_review when requirements pass
```

Statuses: `draft → sent → partially_resolved → resolved`, or `cancelled` (revokes the link).
`approved` is reserved for a future two-step approve-then-send. Mail adapters: `dev` (local
`outbound_messages` outbox) and `disabled`; a real provider implements `MailSender`.
Events: `missing_information_request_created|edited|sent|cancelled`, `sender_document_received`,
`sender_response_received`, `missing_information_resolved`, `referral_became_ready`.

## Step 6 — Home (`backend/pilot/home.py`, `GET /api/me/practice/home`)

Server-computed from real pilot state: **Needs you** (ready for decision, triage uncertainty/approval,
document evidence to confirm, proposed learnings, ≤1 proactive question/day), **Prepared** (draft
requests), **Waiting** (referring office, physician), **While you were away** (events since the
previous `home_viewed`, default 24 h, max 7 days). Staff see "waiting on physician" instead of
physician decisions.

## Step 7 — Teaching (`backend/pilot/teaching.py`)

`POST /teach` → interpretation (optional model, schema-validated AND grounded: every phrase must come
from the instruction; else deterministic patterns) → proposal row in `physician_referral_preferences`
(`operational_status='inferred'`, `source='explicit_instruction'`, raw text, confidence, interpreter).
Ambiguous referral type → one clarification question (`/clarify`). Unstructured → kept as a note;
cannot be confirmed. Confirm merges into the type's current rule as a new version (or confirms in
place); Edit confirms an edited rule; Reject retires it.

## Step 8 — Correction learning (`backend/pilot/learning.py`)

Patterns (≥2 distinct referrals, same referral type): modality edited to the same value; the same
extra item requested (not flagged by triage). Each pattern → one proposal + one `learning_questions`
row (signature-deduped). At most one question surfaces per 24 h. Answers: Yes / Edit / Depends (kept
inactive with the note) / Ignore. Events: `learning_proposed`, `learning_question_shown`,
`learning_confirmed|edited|rejected`, `learning_question_answered`.

## Steps 9–10 — Publication + public agent

`/me/public`: choose which rules are published, edit intro/locations/hours/insurance/how-to-refer,
preview exactly what is public, Publish (new immutable version) / Unpublish. Snapshots exclude rule
ids, urgency signals, notes, confidence, unpublished rules, and all referral data.
`/p/{slug}` reads only the current published snapshot (and only while the practice is approved).
The public agent answers six intents from the snapshot (scope/fit, required info, modality, locations,
insurance, how to refer); clinical/injection/unrelated questions get a fixed refusal. Question text is
never stored. Events: `public_page_viewed`, `public_agent_question`, `public_agent_out_of_scope`,
`public_agent_referral_started`, `public_referral_submitted`.

## Step 11 — Public referral submission

`POST /api/public/p/{slug}/referrals` (no account; honeypot; 5/hour/client) creates an
`IntakeReferral(source='public_form')`, runs triage, and returns a sender link shown once. The same
`/r/<token>` page serves status, uploads, and later information requests.

## Step 12 — Metrics (`backend/pilot/metrics.py`)

`GET /api/me/practice/metrics` (physician) and `GET /api/internal/pilot-metrics` (admin allow-list):
usage, referral quality, agent trust (acceptance rate, common correction fields), learning, public
pull (views, questions, public referrals, unique/returning referring clinicians via pseudonymous
hashes), operations (median hours received→triaged, received→ready, waiting on external info), plus
a 7-day summary sentence. No "time saved" metric.

## New tables (additive, created on startup)

`sender_links`, `missing_information_requests`, `sender_responses`, `outbound_messages` (immutable),
`learning_questions`, `public_profiles`, `public_profile_snapshots` (immutable).

## Dev / usability trials with fictional physicians

```bash
LAMINA_DEV_FAKE_NPPES=true LAMINA_PRODUCT_MODE=pilot LAMINA_WORKFLOW_DATABASE=data/pilot-dev.sqlite \
  python -m scripts.dev_pilot_server        # NPIs 1234567893 (Avery Testwell), 1234567802
```

## Step 13 — Browser hardening (verification record)

Fixes: pilot migrations run at app startup; `set_publishable` refuses another practice's rule;
teaching splits "X and Y" into separate requirements; sender replies show practice labels, not keys;
publishing saves on-screen edits first; Supabase sign-up confirmation returns to the same origin
(`confirmationRedirectUrl`); grammatical weekly summary.

Verified (local, synthetic/test data only): physician browser flow end to end; staff authorization
API matrix (58/58 checks); cross-practice isolation; secure document upload.

Not verified in a browser: the remaining manual staff UI checks (that staff never *see* physician-only
controls on every screen, the staff invitation sign-up → email confirmation → `/me/join` redirect
round trip, and staff document upload through the UI). These are covered at the API layer only.
Email-confirmation redirects also depend on the Supabase project's Redirect URLs allow-list.
