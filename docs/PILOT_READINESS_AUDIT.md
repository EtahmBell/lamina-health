# Pilot readiness audit — specialist practice (2026-11-13)

Scope: the authenticated pilot (`LAMINA_PRODUCT_MODE=pilot`) as it exists in the repository today,
traced through the code and exercised in a real browser against a local pilot stack. Synthetic and
fictional data only (fictional NPPES physician "Avery Testwell", NPI 1234567893; patients "Test
Patient Alpha/Gamma/Delta"). No real PHI, no database migration, no commits.

**Bottom line.** Lamina today is a well-built *intake-triage workbench*: a practice can sign up,
teach referral rules, enter or receive a referral, get an inspectable deterministic triage, run a
human-approved missing-information loop with the referring office, and record an
accept/redirect/decline decision. It is **not yet connected to anything a practice already uses**:
no fax, email, EHR or FHIR intake, no patient record beyond what is typed per referral, no
scheduling, and no outbound notifications other than a dev-only outbox. The workflow ends at the
physician's decision. It is not deployable with real patients until the infrastructure items in
§7 are done.

---

## 1. Capability inventory

Legend: **BT** = fully implemented and exercised in the browser in this audit · **I** =
implemented, covered by API/unit tests but not browser-tested here · **P** = partial · **S** =
stubbed / dev-only · **N** = not implemented.

### Onboarding, practice, permissions

| Capability | State | Where / notes |
|---|---|---|
| Supabase sign-in, JWT verified in FastAPI | BT (existing session) | `backend/auth.py`. New-account sign-up + email confirmation was not re-run (needs a real inbox). |
| NPI lookup (NPPES) → "Is this you?" self-attestation | BT | `backend/physician_onboarding.py`; fictional NPPES via `scripts/dev_pilot_server.py`. |
| Practice setup prefilled from NPPES | BT | `backend/pilot/practice.py: create_practice`. |
| Manual pilot approval gate | BT | CLI `python -m scripts.pilot_physicians approve …` or admin API. **Operator step, no UI, no notification.** |
| Staff invitation link (single use, 14 days, hashed) | I | `practice.invite/accept_invitation`. Link must be copied and shared by hand; no email. |
| Staff role (intake + triage; no rules/decisions) | I | API matrix tested; the staff **UI** was not browser-tested (needs a second Supabase account). |
| Second physician in a practice | N | Invitations are `role: "staff"` only; one practice per account. |
| MFA, session policy, invite-only sign-up | N | Not enforced in code; Supabase project settings only. |

### Agent initialization and rules

| Capability | State | Notes |
|---|---|---|
| Rules editor (type, fit, outside-scope, required/helpful + freshness, urgency signals, modality, note) | I | `backend/pilot/rules.py`, Rules tab. Versioned, immutable rows. |
| Plain-language teaching → inactive proposal → confirm/edit/reject | BT | `backend/pilot/teaching.py`. Confirmed proposals merge into one versioned rule per type. |
| Correction learning (≥2 repeated edits → one question/day) | I | `backend/pilot/learning.py`. |
| Publication of selected rules to a public page | BT | `backend/pilot/publication.py`. |

**Representation.** Everything lives in `physician_referral_preferences` (`scope='practice'`): one
rule per *referral type string*, with `good_fit[]`, `outside_scope[]` (stored as `redirect`),
`required[]`/`helpful[]` items (`key`, `label`, `freshness_days`), `urgent_signals[]`, `modality`,
free-text `note`. Exceptions and preferences beyond these fields can only be a note, and triage
ignores notes.

**Minimum for useful triage.** For every referral type the practice receives: (a) a rule whose type
string staff will type identically, (b) **good-fit phrases**, (c) the required items, and ideally
(d) urgency signals and modality. Without (b), every referral is "Possible fit" and always flagged
"needs physician judgment" (observed). Teaching never prompts for fit criteria.

**Default with no rules.** Referrals are still recorded and triaged: fit `unknown`, readiness
`unknown`, `requires_physician=true`, next step "physician review". Home shows "I'm not sure about
X's referral". Nothing is auto-requested.

### Referral intake — every real entry point

| Channel | State | Entry → endpoint → storage → triage |
|---|---|---|
| Manual staff entry | BT | `/me/referrals/new` → `POST /api/me/practice/referrals` → `intake_referrals` (`source=manual`) → deterministic triage runs immediately. Validation: Pydantic (`IntakeReferralInput`), received date not in future. |
| Manual entry with a file | BT (txt) | Same, then `POST …/referrals/{id}/documents` (raw body, magic-byte check, 15 MB) → `referral_documents` + private disk file → re-triage. `source=upload`. |
| Public referral page | BT | `/p/{slug}/refer` → `POST /api/public/p/{slug}/referrals` (honeypot, 5/h/IP, in-process) → `source=public_form` → triage → one-time sender link. **No structured fields for the practice's required items**, so practically every public referral lands "missing information". |
| Sender status/upload/response link | BT | `/r/{token}` → `GET/POST /api/public/r/{token}…` → `sender_responses`, documents, merged submitted items → re-triage. |
| Agent-prepared referral draft | I | Agent card prefills the manual form; nothing saved until submitted. |
| PDF / image text extraction, OCR | N | Stored as `extraction_status='unsupported'`; only UTF-8 plain text is read. Real faxes are PDF/TIFF. |
| Optional LLM evidence extraction | S | Off by default (`LAMINA_PILOT_LLM_EXTRACTION_ENABLED`); proposals only. |
| Fax, email inbox, EHR referral queue, Direct, HL7, FHIR, Medplum | N | No inbound integration of any kind in `backend/pilot/`. Medplum/FHIR exists **only in demo mode** and pilot code is forbidden from importing it. |

**A referral sent to the practice's normal fax number or EHR queue today:** Lamina never sees it.
Staff must read the fax or EHR item and re-type it into New referral, optionally attaching the PDF
(stored, not read). Re-keying is the single biggest adoption cost.

### Patient and clinical data

* **No canonical patient record.** The patient is a JSON blob on each referral (`patient_json`: name,
  DOB, sex, phone, insurance, free-text `external_id`). The UI says so honestly ("not a full patient
  record").
* **No matching or deduplication.** Two referrals for the same person are two unrelated rows. The
  agent is explicitly told not to assume they are one patient.
* **Clinical history** = the referral's reason, clinical context, structured submitted items, and
  documents. Nothing longitudinal.
* **External identifiers:** one free-text MRN field, no system/assigner, not used for lookup.
* **Storage:** a single SQLite file (`LAMINA_WORKFLOW_DATABASE`) shared with onboarding/claims;
  documents on local disk (`LAMINA_PILOT_DOCUMENT_DIR`). Lamina owns all of it. No EHR is the source
  of truth for anything.
* **Longitudinal history from the EHR** needs: a patient identity model (internal patient id +
  `identifiers[]` with system), a matching step (MRN exact / demographics probabilistic with human
  confirmation), a SMART-on-FHIR or vendor API connection per EHR (or Medplum as the intermediary
  store), consent/minimum-necessary scoping, and a bounded read interface like the demo's
  `ClinicalDataSource`, rebuilt for pilot.

### Referral processing — traced lifecycle

```
received ─triage→ triaged ─┬─ approve/edit (next_step=request_information) → needs_information
                           ├─ approve/edit/reject/escalate → ready_for_review
                           └─ physician accept/redirect/decline (allowed from any non-received state)
needs_information ─ request draft → human approve (email adapter or "I'll fax it") → sender link
   └ sender replies / uploads → re-triage → staff confirm document evidence → re-triage
     → all required satisfied → ready_for_review (automatic, deterministic)
ready_for_review ─ physician → accepted | redirected (free-text target) | declined   ◀── WORKFLOW ENDS
```

Where it **ends**: at the disposition row. After "Accepted" there is no scheduling task, no
acceptance letter, no patient outreach, no closure message. The referrer sees "Accepted" or
"Closed — redirected" only if they reopen their link, and redirect does not show them *where*.
Manual-entry referrals have no sender link at all unless an information request is sent (the
generated status token is hashed and discarded).

### Scheduling and coordination

None in pilot. No appointment status, slots, visit types, calendars, cancellations, waitlist,
scheduling permissions, patient outreach or sync. The agent correctly refuses ("Scheduling and
calendars aren't connected to Lamina yet"). (`scheduling_coordination` exists only in the synthetic
demo store.)

**Minimum staff-managed handoff** (no autonomy): on Accept, create a *scheduling task* with
`state` (to_schedule → contacted → scheduled → completed / no_show / cancelled), visit type +
modality (from triage), target window from priority, assignee, notes, and a manual "scheduled for
<date> at <location>" entry. Add a "To schedule" worklist, a Home section, and an agent read tool.
Optionally add a human-approved acceptance notice to the referrer via the existing approve-and-send
path. Sync with the practice's scheduling system can come later.

### Agent architecture

`backend/pilot/assistant.py`. Plan (deterministic regex planner; optional model planner) → tools →
grounded reply + cards. **Read tools:** practice context, list referrals, referral detail, triage
explanation, practice rules, pending work, referral timeline. **Prepare tools:** propose preference
(physician-only, inactive), preview information request, preview physician flag, prefill referral
draft. A card only acts on a human click through an existing endpoint. It cannot send, decide,
schedule, contact anyone, or change an active rule. History is per user, purged after 30 days.

Missing tools for day-to-day use: edit/approve-and-send an *existing* draft from chat; record a
value a staff member reads aloud ("TSH 2.1 on 10/20"); "what happens next / what's left" workflow
explanation; real narrative summaries (today "summarize" = last 8 log events, in UTC); worklist
filters (by sender, age, priority); scheduling-task tools once those exist; a morning digest.

---

## 2. End-to-end scenarios (browser, synthetic)

Environment: `scripts/dev_pilot_server.py` (fictional NPPES, dev mail outbox, model off) on a
**fresh empty scratch database** + Vite in pilot mode; existing Supabase session for the fictional
physician. Staff UI was not exercised (no second account).

**Scenario 1 — new specialist → teach → manual referral: PASSED.**
NPI → "Is this you?" → practice prefilled → *approval wait (operator CLI)* → empty workspace →
taught "For thyroid nodule referrals I always need a thyroid ultrasound and a recent TSH within 90
days" → confirm → taught outside-scope → confirm (merged into rule v2) → New referral (type matched
the rule, so the "information included" fields appeared; TSH entered, ultrasound left blank) →
triage: *Possible fit · Missing Thyroid ultrasound · needs physician judgment* → agent answered
"What's missing?" correctly and refused scheduling → agent card created a draft → approved to the dev
outbox → sender replied on `/r/…` → auto re-triage → `ready_for_review` → Accept → referrer page
shows "Accepted". Manual interventions: operator approval; nothing actually emailed.

**Scenario 2 — outside referrer via public page: PASSED.**
Published profile (rule opt-in) → public Q&A answered from the snapshot → public referral
submitted (no structured required-item fields) → one-time link shown → practice drafted a request
→ approved → referrer opened the **original submission link**, saw the request, sent a partial
reply (TSH + message) → "received ✓" on TSH → uploaded a plain-text ultrasound → Home showed
"Confirm what Test Patient Gamma's documents show" + "waiting on the referring office · partial
response".

**Scenario 3 — incomplete referral → document confirmation → escalate → physician: PASSED**
(performed with the physician account; the same endpoints are staff-permitted and covered by API
tests). Confirm-from-document showed the page-1 quote and required a human-entered date → request
auto-resolved → ready for review → flagged with a note → agent summary → Redirect (target + reason
required) → referrer sees "Closed — redirected" (no destination).

A separate fax/manual path (Delta): "Approve — I'll fax/send it" → link shown once for pasting into
a fax → "Waiting on the referring office". Passed.

**Agent status accuracy.** Correct on missing items, status, requests and documents. Bugs found and
fixed are listed in §4. Remaining gaps: cannot explain what happens after a decision, does not show
redirect destination, "summary" is a log tail in UTC, link-card subtitles freeze the status at the
time of the reply.

---

## 3. Findings not fixed (product/security), by severity

1. **Secure-link token stored in plaintext.** `approve_and_send` writes the message body *with the
   full `/r/<token>` URL* back into `missing_information_requests.draft_message` and
   `outbound_messages.body`, and the referral page re-displays it. The code and docs say only the
   hash is stored. Anyone with DB or staff UI access can reuse the link. Fix: store the template,
   render the link only in the send call / one-time response.
2. **Requirement and referral-type matching is lexical and brittle.** "Thyroid nodules" ≠ "Thyroid
   nodule" → no rule → unknown. "pregnant" ≠ "pregnancy", so "Graves hyperthyroidism, pregnant" is
   *not* flagged outside scope. Teaching embedded the type words in the scope phrase. Rule types
   should be a controlled list (pick, not type), and phrase matching needs stemming/synonyms or
   model-assisted proposals.
3. **Teaching mis-attributes freshness.** "a thyroid ultrasound and a recent TSH within 90 days" set
   90 days on *both* items. It is visible before confirming, but easy to miss.
4. **Sender-entered values satisfy requirements directly** (`sender_submitted`), so a free-text
   claim like "US done" makes a referral "Complete per your rule" without a document. Consider
   requiring staff confirmation per rule.
5. **Each re-triage creates a new undecided recommendation**, so "Approve triage" reappears after
   every sender reply/upload. This produces review fatigue and noisy acceptance metrics.
6. **No delivery to the referrer of decisions** (accept/decline/redirect target) and no
   confirmation email for public submissions. The one-time link is the only way back.
7. **Accepted referrals are listed under "Previous care"** (demo-parity label enforced by
   `pilotDemoParity.test.mjs`). Accepted means care is about to start; recommend "Decided
   referrals" or a dedicated "To schedule" section once scheduling tasks exist.
8. Approval wait is a dead end: a physician can't add rules or invite staff until an operator runs
   a CLI, and nobody is notified either way.
9. Public slug truncated mid-word (`…-metabolism-practic`); dates shown as raw ISO in a few places;
   first-ever Home says "While you were away nothing new needed handling".

---

## 4. UX fixes made in this pass (narrow, demo design unchanged)

| # | Problem observed in the browser | Fix |
|---|---|---|
| 1 | **Agent card could create a duplicate request.** After a request was answered and resolved, the old "Create draft" card became live again; one click would re-open a request for already-received items and push a ready referral back to *needs information*. | Card state is `resolved` when none of the items it offered are still missing on current triage (`assistant.py: _card_state`). |
| 2 | "Where does X's referral stand now, and what happens after I accept it?" was refused as an action request. | Questions opening with where/when/has/have/does/should/will are not treated as commands (`_QUESTION_OPENERS`). Imperatives ("Accept X", "Can you accept X?") still get the human-only reply. |
| 3 | The referral-scoped agent dock on patient B showed the earlier conversation about patient A under B's header. | API now returns `context_referral_id` per message; the referral dock shows only turns asked from that referral (`turnsForReferral`). Home keeps the full history. |
| 4 | Empty practice Home: "I've prepared what I can. The rest needs you." + "Nothing needs you right now." above a "Needs you" item. | When the only need is adding rules: "I need your referral criteria before I can triage." with a one-line explanation (staff variant included). |
| 5 | Next-step heading still said "Request missing information" after a request was drafted or sent, and "Request information" stayed visible (it can only fail with `draft_exists`). | Heading becomes "Review and send the information request" / "Waiting on the referring office"; button hidden while a draft exists. Display only. |
| 6 | "… · routine priority · Not specified" didn't say what is unspecified. | "Modality not specified" in the summary and recommendation list. |
| 7 | Dev adapter displayed "sent … via dev_outbox" and "Sent — waiting on the referring office", although nothing was delivered. | "approved … — saved to Lamina's local test outbox, not delivered to anyone"; manual path reads "marked sent … — sent by your team by fax/email". |
| 8 | Every pilot page, including the public practice and sender pages that outside offices see, was titled "Lamina — Consult Network" (demo product name). | Pilot sets `document.title = 'Lamina'`. |

All eight were re-verified in the browser after the change. #4 was verified on a second empty
database.

---

## 5. Current-state architecture

```
Browser (Vite/React, PilotApp)                     Unauthenticated
 /me/* workspace ── Bearer JWT ──┐                  /p/{slug}, /p/{slug}/refer, /r/{token}
 Supabase JS (auth only)         │                         │
                                 ▼                         ▼
FastAPI (single process, LAMINA_PRODUCT_MODE=pilot)
 ├─ auth.py: JWKS verify → user.id (sub)
 ├─ api/physician_onboarding: NPPES lookup, claim, internal approval
 ├─ pilot/api.py  require_practice → PracticeContext (role from DB)
 │    intake.py (status machine, optimistic transitions) ─ triage.py (deterministic)
 │    missing_info.py (drafts, approve_and_send → MailSender[dev|disabled], sender links)
 │    rules.py / teaching.py / learning.py (one rule store, versions)
 │    home.py, assistant.py (read/prepare tools), metrics.py, publication.py
 └─ pilot/public_api.py (snapshot-only profile & Q&A, public submit, sender view/upload/respond;
                         in-process rate limits)
Storage: one SQLite file (claims, owner scopes, practices, referrals, documents meta,
         recommendations*, decisions*, pilot_events*, requests, outbox*, agent_messages)   *append-only
         + local disk for documents.   External calls: NPPES (public), optional OpenAI (off).
Not connected: fax, email in/out (real), EHR/FHIR/Medplum, scheduling, SMS, notifications.
```

---

## 6. Clinician-facing walkthrough — what Lamina does today

*For a specialist considering the pilot. Plain language, current behavior only.*

1. **Join.** Sign in, enter your NPI, confirm the public NPPES record is you, and check the practice
   details we prefill. The Lamina team then approves your pilot account by hand. Until then you'll
   see a waiting screen.
2. **Teach your agent.** Tell it, in a sentence, what you need for each kind of referral you take
   ("For thyroid nodule referrals I need an ultrasound and a TSH from the last 90 days"). It shows
   what it understood. Nothing changes until you confirm. Add what you *do* and *don't* see so it
   can judge fit, plus any urgent signals.
3. **Referrals come in two ways.** Your staff type in referrals that arrive by fax or through your
   EHR, attaching the PDF if they like (Lamina stores it but doesn't read PDFs yet). Or you publish a
   referral page and outside offices submit there. Lamina does **not** watch your fax line, inbox
   or EHR.
4. **Lamina triages, deterministically.** For each referral it shows the fit against your rules,
   what's present or missing (with dates), the suggested priority and visit type, and whether you
   need to look. Every statement cites the rule version or document page it came from. It never
   diagnoses or recommends treatment.
5. **Missing information.** Lamina drafts the request to the referring office. Your team edits and
   approves it, then faxes it themselves (or emails, once a compliant email provider is connected).
   The office gets a private link to reply or upload without an account. When the answers arrive,
   Lamina re-checks and tells you when the referral is complete.
6. **You decide.** Accept, redirect (with where and why), or decline. Staff can prepare and flag
   referrals but can't make that decision.
7. **What happens next is still yours.** Lamina records the decision. It does not schedule, notify
   the patient, or send an acceptance letter yet. The referring office sees the status only on its
   link.
8. **Ask your agent.** "What needs me today?", "Why did you flag this?", "What's missing for Gamma?",
   "Prepare a request." It answers from your practice's data and prepares drafts. It never sends or
   decides anything on its own.
9. **Not yet:** real patient data (the deployment isn't approved for PHI), fax/EHR intake, reading
   PDFs, patient history from your EHR, scheduling, and connecting with colleagues.

---

## 7. Deployment readiness — implemented vs required

| Area | Technically implemented | Needed before real patients |
|---|---|---|
| Database | SQLite file, append-only triggers, optimistic transitions | Managed Postgres (or encrypted single-writer volume) under BAA; migrations tool; connection pooling; tested restore. |
| Backups / DR | None | Automated encrypted backups (DB + documents), PITR, quarterly restore drill, RPO/RTO agreed with the practice. |
| Documents | Private local disk, random keys, authenticated `no-store` download | Encrypted object storage under BAA (`DocumentStorage` impl), access logging, retention/lifecycle, malware scan, PDF/TIFF text extraction + OCR. |
| Medplum/FHIR | Demo only (`backend/fhir`, `ClinicalDataSource`) | Choose: (a) Medplum as Lamina's clinical store + bots for intake, (b) SMART-on-FHIR read access into the practice EHR, (c) both. Pilot-side bounded interface; BAA with Medplum (hosted) or self-host. |
| External intake | Manual, public form, sender link | eFax provider with API + BAA (inbound PDF → draft referral for staff confirmation); referral inbox (Direct/secure email); EHR referral queue later. |
| Patient identity | Per-referral JSON | Patient entity, identifiers with system, matching + human merge, link referral episodes to patient. |
| Outbound messaging | `MailSender` protocol; dev outbox; manual fax | BAA email (or PHI-free link-only template); eFax send; delivery status; acceptance/decline notices behind human approval. |
| Scheduling | None | Staff scheduling task (§1), later EHR/PM calendar sync. |
| Auth & permissions | Supabase JWT, server-derived roles, practice isolation, manual approval | MFA enforced, invite-only sign-up, session limits, more than one physician per practice, admin UI for approval, audit of role changes, account deprovisioning. |
| PHI safeguards | Model off by default, no question text stored, events hold ids not text | BAAs (host, DB, storage, Supabase, mail/fax, logs, any model); request-body logging off; HIPAA risk assessment; fix plaintext sender token (§3.1); shared rate-limit store/WAF for public routes. |
| Auditability | `pilot_events` append-only, `document_viewed` | Read-access audit for referral detail views, export for the practice, tamper-evidence/off-box copy. |
| Retention | Chat purged at 30 days; nothing else deletes | Retention + deletion policy per practice agreement; legal hold; practice off-boarding export/delete. |
| Monitoring | stdout logs | Error tracking without payloads, uptime + 5xx alerts, queue/age alerts (e.g. referrals untriaged > 1 day), on-call. |
| Testing | 651 backend + 1096 frontend tests; manual browser runs | Staff UI browser pass, sign-up/email-confirm round trip, multi-user concurrency, load on public routes, security review/pen test, a clinician-run usability session on realistic (synthetic) faxes. |

Supabase authentication is one piece. Without BAAs, encrypted durable storage, backups and audit,
the deployment is **not** production-ready for PHI, as `docs/PILOT_PHI_READINESS.md` also states.

---

## 8. Prioritized roadmap to a real four-week specialty-practice pilot

Principle: meet the practice where referrals already arrive (fax/EHR), make the agent useful
without other physicians joining, and keep humans approving every external action.

### Must have before real practice deployment
1. **Hosting + data under BAA**: managed Postgres (or encrypted volume, single worker), encrypted
   document bucket, backups with a tested restore, request-body logging off, alerts.
2. **Security fixes**: stop persisting sender tokens in message bodies (§3.1); MFA; invite-only
   sign-up; admin approval UI with notification; staff UI browser-verified.
3. **Fax intake (inbound)** through a BAA eFax provider → *draft referral* with the PDF attached for
   staff to complete (human confirms; nothing auto-accepted). This removes the "Lamina never sees
   it" gap for the main channel.
4. **PDF/TIFF text extraction + OCR** (deterministic first; model extraction only under BAA, still
   proposal-only), so document evidence works on real faxes.
5. **Controlled referral types** (staff pick from the practice's types; unknown → "new type"
   prompt) and a **rule-setup checklist** that asks for fit, scope, required items and urgency for
   each type, so triage is useful on day one.
6. **Outbound by fax/BAA email for information requests**, with delivery status.
7. **Staff scheduling handoff (manual)**: on Accept create a "To schedule" task with state, window,
   visit type, assignee and a manual "scheduled for" entry, plus a worklist and Home section.
   Without this, accepted referrals fall out of Lamina.
8. **Practice agreement + HIPAA risk assessment + retention policy**.

### High-value pilot enhancements
- Referrer notifications behind human approval: receipt confirmation for public submissions,
  accept/decline/redirect notice including the redirect destination.
- One undecided recommendation at a time (re-triage updates in place or auto-carries the prior
  approval when only completeness changed) to stop "Approve triage" re-appearing.
- Optional staff confirmation of sender-entered values per rule (§3.4).
- Agent: approve-and-send an existing draft from chat (click-to-confirm), record a dictated value,
  "what's left / what happens next", narrative summaries in local time, live link-card status.
- Matching robustness: stemming/synonyms for fit/scope phrases, teaching that asks for fit criteria
  and attaches freshness only to the item it qualifies.
- Weekly practice digest (from `pilot_events`) by email under BAA.
- Patient entity + MRN-based linking of episodes (no EHR yet), to show "other referrals for this
  patient".

### Can wait until after initial usage
- SMART-on-FHIR / Medplum longitudinal history; EHR referral-queue integration; scheduling sync.
- Model-assisted planning and extraction (after BAA/ZDR).
- Multiple physicians per practice and multi-site.
- Physician network, specialist-to-specialist coordination, PCP accounts.

---

## 9. Change log for this pass (uncommitted)

**Files modified**
- `backend/pilot/assistant.py`: resolved state for answered request cards; `_QUESTION_OPENERS`;
  `context_referral_id` in message view.
- `frontend/src/Pilot.tsx`: empty-practice Home status/briefing; next-step heading with open
  request; hide "Request information" while a draft exists; "Modality not specified";
  `sentViaText` (dev outbox / manual wording); referral dock history scoping; pilot document title.
- `frontend/src/pilotState.ts`: `turnsForReferral` helper.
- `frontend/src/pilotApi.ts`: `context_referral_id` on `AgentMessage`.
- `tests/test_pilot_assistant.py`: planner cases (status question vs imperative);
  `test_answered_request_card_never_offers_a_second_request`.
- `frontend/test/pilotWorkflowAudit.test.mjs` (new): 5 tests for the UX fixes.
- `docs/PILOT_READINESS_AUDIT.md` (this report).

**Checks run**
- `pytest` (offline, `LAMINA_OPENAI_ENABLED=false`): **651 passed** (baseline 650 + 1 new).
- `npm test`: **1096 passed, 0 failed** (baseline 1091 + 5 new).
- `tsc --noEmit` clean; `npm run build` succeeded.
- `ruff check backend tests scripts`: 31 findings, **all pre-existing** (identical count to the
  baseline before changes; none in touched files).

**Not tested:** staff role in the browser; new-account sign-up + email confirmation; invitation
acceptance round trip; LLM paths (disabled); real email/fax (not implemented); concurrent
multi-user edits in the browser.
