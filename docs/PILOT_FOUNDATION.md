# Pilot foundation (specialist practice)

The authenticated, practice-scoped foundation the 4-week specialist pilot builds on.
Demo mode is unchanged; see `AGENTS.md` for the mode rules.

## Revised pilot plan (foundation first)

```text
sign in (Supabase)
  → confirm professional profile (NPPES search by name or NPI → "This is me" → self-attested claim)
  → practice setup (prefilled from NPPES, confirmed/edited by the physician)
  → practice membership (physician owner; staff via single-use invitation links)
  → manual Lamina pilot approval (unchanged policy; staff inherit it)
  → specialist workspace (/me/*): referrals, triage review, rules, practice
```

Built in this pass: Steps 0, 0.5, 0.75, 1, 1.5, 1.75, 2, 3, 4. Not built: public practice page/agent,
public referral form, external missing-information send loop, calendar/email/waitlist, scheduling
actions, PCP accounts, specialist-to-specialist UX, agent-to-agent coordination.

## Modules

| Area | Backend | Frontend |
|---|---|---|
| Mode switch | `backend/pilot/mode.py`, `backend/main.py: create_app` | `src/productMode.ts`, `App.tsx` early return |
| Onboarding (existing, extended) | `backend/physician_onboarding.py` (+ name search), `api/physician_onboarding.py` (+ `/npi/search`, claim event) | `Onboarding.tsx` (+ name search, new copy) |
| Practice + membership + access guard | `backend/pilot/practice.py` | `Pilot.tsx` gate, setup, join, practice page |
| Persistence | `backend/pilot/store.py` (pilot tables + append-only triggers) | — |
| Canonical rule store | `backend/workflow.py: _migrate_operational_rules`, `backend/pilot/rules.py` | `Pilot.tsx` rules page |
| Intake + status machine + actions | `backend/pilot/intake.py` | referral list / new / detail |
| Documents | `backend/pilot/documents.py` | upload + authenticated open |
| Triage | `backend/pilot/triage.py` | review card |
| HTTP | `backend/pilot/api.py` (`/api/me/practice/*`) | `src/pilotApi.ts`, `src/pilotState.ts` |

## Data model (new tables)

- `practices` — id, name, specialty, website, address, phone, contact_email, status, created_by_user_id.
- `practice_members` — practice_id, user_id, physician_owner_scope_id (required for physicians), role
  (`physician`/`staff`), status. One active practice per account (pilot simplification).
- `practice_invitations` — hashed single-use token, role `staff`, 14-day expiry, accepted/revoked.
- `intake_referrals` — practice_id, source (`manual`/`upload`/`public_form`), status, sender JSON
  (name, practice, contact, optional NPI, optional Lamina physician id), patient JSON (as submitted),
  referral_type (free string), reason, clinical context, sender priority, submitted items,
  `received_at` (when the practice got it) vs `entered_at`, hashed sender status token,
  current recommendation, review/escalation/information-request/disposition JSON.
- `referral_documents` — private storage key, sha256, content type, extraction status/pages.
- `triage_recommendations` — full recommendation JSON, generator, model id, rules snapshot id + JSON
  (append-only).
- `recommendation_decisions` — accepted/edited/rejected, changed fields (from→to), reason, actor,
  role; one per recommendation (append-only).
- `pilot_events` — event_type, practice_id, owner_scope_id, referral_id, actor, autonomy
  (`automatic`/`human`), metadata, timestamp (append-only).

`physician_referral_preferences` (existing) gains: `referral_type`, `scope`, `practice_id`,
`confidence`, `operational_status` (`inferred`/`inferred_active`/`confirmed`/`superseded`/`rejected`),
`physician_confirmed`, `provenance_json`, `publishable`, `version`. Legacy rows are backfilled from
`status`, and triggers keep the new columns in sync for non-practice rows, so demo code is untouched.
Practice-rule content is immutable per row (trigger).

## Intake status machine

```text
received → triaged → needs_information ⇄ ready_for_review → accepted | redirected | declined
            └──────────────→ ready_for_review / accepted / redirected / declined
```

- Triage (deterministic) moves `received → triaged`, and `needs_information → ready_for_review`
  only when every required item is satisfied by human-provided evidence.
- Approve/Edit/Reject create a `RecommendationDecision`; from `triaged`, the effective next step
  decides `needs_information` vs `ready_for_review` (Reject → `ready_for_review` + physician flag).
- Request information prepares a draft (never sent) → `needs_information`.
- Escalate flags for physician review (and moves `triaged → ready_for_review`).
- Accept/Redirect/Decline are physician-only; redirect/decline require a reason.
- Terminal states have no outgoing transitions. Every change is an optimistic, single-transaction
  update; concurrent conflicting actions get `409 stale_referral`.

## Triage order of operations

1. Operational practice rules for the referral type (confirmed / inferred-active) from the canonical store.
2. Deterministic requirement checks against structured items (presence + freshness).
3. Deterministic document search → `proposed_from_document` with page + quote (never satisfied).
4. Optional LLM evidence proposals (flagged off by default) — quote must be verbatim on the cited
   page or it is dropped; still only a proposal.
5. Pydantic validation; unknown → missing / requires physician.

Fit: outside-scope phrase match → `outside_scope`; fit phrase match → `strong`; rule but no match →
`possible`; no rule → `unknown`. Matching uses the referral reason + clinical context only; numbers
must match exactly ("type 1" ≠ "type 2"). Priority: rule urgency signal → urgent; else sender's
priority (an urgent sender flag is never downgraded); else routine.

## Pilot events emitted

`physician_signed_in` / `staff_signed_in` (≤1 per 30 min), `physician_claimed_profile`,
`practice_created`, `practice_updated`, `staff_invited`, `staff_joined`, `staff_invitation_revoked`,
`staff_removed`, `referral_received`, `referral_triaged`, `recommendation_generated`,
`missing_information_detected`, `recommendation_accepted|edited|rejected`, `information_requested`,
`referral_escalated`, `referral_item_recorded`, `document_uploaded`, `document_viewed`,
`referral_ready`, `referral_status_changed`, `referral_accepted|redirected|declined`,
`learning_proposed|confirmed|corrected|retired`.

Query: `GET /api/me/practice/events?event_type=…&referral_id=…` (physician only), or SQL on
`pilot_events`.

## Migrations

All schema changes are additive and run automatically on startup (`WorkflowStore.__init__` and
`PilotStore.__init__`, `CREATE … IF NOT EXISTS` / guarded `ALTER TABLE ADD COLUMN`). Re-running is
idempotent. Existing rows are never rewritten except the one-time backfill of the new rule-store
columns from `status`. Back up `data/workflow.sqlite` before first start on an existing database.

## Run pilot mode locally

Prerequisites: a Supabase project (email/password auth) and the repo installed per README.

1. Repository `.env` (backend):
   ```text
   LAMINA_PRODUCT_MODE=pilot
   SUPABASE_JWT_ISSUER=https://<project>.supabase.co/auth/v1
   SUPABASE_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json
   SUPABASE_JWT_AUDIENCE=authenticated
   LAMINA_PILOT_ADMIN_USER_IDS=<your Supabase user id>
   LAMINA_OPENAI_ENABLED=false
   LAMINA_PILOT_LLM_EXTRACTION_ENABLED=false
   # Optional: keep pilot data apart from your demo database
   LAMINA_WORKFLOW_DATABASE=data/pilot-workflow.sqlite
   ```
2. `frontend/.env`:
   ```text
   VITE_LAMINA_PRODUCT_MODE=pilot
   VITE_API_BASE_URL=http://127.0.0.1:8000
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```
3. Start: `uvicorn backend.main:app --reload` (repo root) and `npm run dev` (frontend/). Check
   `http://127.0.0.1:8000/health` returns `"product_mode": "pilot"`.
4. Open `http://127.0.0.1:5173/me`, create an account, confirm your NPPES profile, set up the practice.
5. Approve the physician (as an allow-listed admin, or locally):
   `python -m scripts.pilot_physicians list` then
   `python -m scripts.pilot_physicians approve <owner-scope-id> --operator <your-name>`.
6. Add a referral rule (Referral rules), then enter a referral (Referrals → New referral).
7. Invite staff from Practice → share the one-time link (`/me/join?invite=…`).

Private pilot invitations: approval stays manual. A simpler invite-only path (e.g. pre-approving
specific NPIs or emails) is possible later but is **not** implemented, to avoid silently changing
the approval policy.

## Known follow-ups

- PDF/image text extraction and OCR (documents are stored; only plain text is read today).
- External information-request send loop (approval-gated) and sender status page (token reserved).
- Natural-language teaching → proposed rules (`inferred` / `inferred_active`) and repeated-correction
  questions, on the same canonical store.
- Public practice representation + public referral agent + public referral form.
- Pilot metrics endpoint/weekly summary over `pilot_events`.
