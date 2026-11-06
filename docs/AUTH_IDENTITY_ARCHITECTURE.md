# Authentication and provider identity foundation

## Boundaries

Supabase authenticates Lamina users. FastAPI independently validates Supabase
access tokens and derives `auth_user_id` only from the verified JWT `sub` claim.
NPPES and the controlled synthetic roster remain canonical provider identity
sources. Lamina's workflow SQLite database stores claims and agent state; no
NPPES rows or workflow data are migrated to Supabase.

The existing Lucy PCP workspace remains a separate unauthenticated synthetic
demo. Claiming another provider does not rebind that workspace.

## Persistent schema

`provider_claims` stores `id`, `auth_user_id`, `npi`, `status`, `claimed_at`,
`verification_submitted_at`, `verified_at`, `updated_at`, and
`verification_method`. A partial unique index permits only one claim in
`claimed`, `verification_pending`, or `verified` state for an NPI.

`provider_agent_state` stores one row per activated/configured NPI: `npi`,
`status` (`inactive`, `active`, or `disabled`), `practice_confirmed`,
`preferences_json`, `activated_at`, `disabled_at`, and `updated_at`.
Preferences stay separate from claim ownership, and activation stays separate
from verification.

`physician_owner_scopes` binds one active provider claim to an opaque private
engagement scope. It stores the claim/user/NPI relationship, a safe NPPES
identity snapshot, independent storage and physician keys, explicit
`publication_status`, and a separate `clinical_access` bit. The NPI is identity
metadata, not an authorization key. A partial unique index permits one selected
scope per account. Since the pilot pass a database trigger also permits only one
active claim per account, so new accounts hold exactly one owner scope; older
multi-claim accounts keep explicit selection among their own claim IDs.

Scope creation is additive and idempotent. A claim creates one scope; a legacy
active claim is lazily backfilled when its owner first opens the sandbox. The
first scope is selected by default. No demo workspace row or cookie participates
in this resolution.

## Canonical lifecycle

`backend/provider_network/lifecycle.py` is the only claim/activation projection:

1. persisted disabled agent → `disabled`
2. persisted active agent → `active`
3. verified claim → `verified`
4. verification submitted → `verification_pending`
5. initial claim → `claimed`
6. resolvable provider with no active claim → `reserved`

Rejected or revoked claims no longer occupy the active-claim uniqueness slot and
project as reserved unless a persisted activation state takes precedence.

## Authorization and verification

Protected endpoints accept `Authorization: Bearer <access token>`. They never
accept an auth user ID, email, or demo identity header. Missing and invalid
tokens return 401. Operations on another user's claim return a non-disclosing
404. A competing active NPI claim returns 409 without claimant details.

Real NPPES identities can progress only to `verification_pending` until a real
credential verification integration exists. The demo verifier requires
`LAMINA_DEMO_VERIFICATION_ENABLED=true`, accepts only controlled synthetic NPIs,
and records `verification_method=synthetic_demo`.

Claim, verification, publication, and clinical access are independent. A real
claim is private by default. Verification does not publish it, and publication
would not grant clinical access. Pass 8A exposes no publication mutation and
keeps clinical access unavailable. The legacy activation endpoint rejects real
private scopes; synthetic demo verification/activation remains unchanged.

## API surface

Public or optionally authenticated:

- `GET /api/providers/search`
- `GET /api/providers/{npi}`
- `GET /api/providers/{npi}/claim-state`

Authenticated owner operations:

- `POST /api/providers/{npi}/claim` (controlled synthetic NPIs only; real NPIs
  return 409 and must use physician onboarding)
- `GET /api/me/provider-claims`
- `POST /api/provider-claims/{claim_id}/submit-verification`
- `POST /api/provider-claims/{claim_id}/verify-demo`
- `PUT /api/providers/{npi}/preferences`
- `POST /api/provider-claims/{claim_id}/activate-agent`
- `POST /api/provider-claims/{claim_id}/disable-agent`
- `GET /api/me/physician/status`
- `PUT /api/me/physician/selection/{owned_claim_id}`
- `/api/me/physician/profile`, `/interests`, `/profile/enrichment`
- `/api/me/physician/training`, `/practice-representation`, `/agent-overview`
- `/api/me/physician/agent-test-cases`, `/agent-chat`
- `/api/me/physician/posts` (private drafts only)

Every `/api/me/physician` route derives the account from the verified bearer
token and then resolves an owned selected claim. It never accepts a user ID,
NPI, anonymous workspace ID, or Lucy/Iain persona as authority. Missing auth is
401. Every private route resolves its scope through the single
`require_pilot_scope` dependency (`backend/api/physician_sandbox.py`), which
returns 403 with `{code, message}` (`physician_identity_required`,
`pilot_approval_pending`, or `pilot_access_disabled`) unless the selected scope's
identity was confirmed and its pilot access is `approved`. Only `/status` and
`/selection/{claim_id}` are reachable before approval. An unowned
selector/resource is a non-disclosing 404.

## Data boundary

The physician sandbox contains professional profile overlays, confirmed
interests, review-first public enrichment candidates, initialization/training,
confirmed practice representation, private agent chat against generic synthetic
scenarios, and private post drafts. Shared engagement repository methods are
addressed with the opaque owner keys, preserving the established session and
review state machines without copying their tables.

It has no patient list, patient cases, EHR connector, consultation context,
referral execution, network roster mutation, routing-pool eligibility, or PHI.
Its capability projection keeps all of those permissions false. Owner-scope
rows and engagement rows persist across logout, browser refresh, and a new
signed-in browser session; logout merely removes the bearer credential.

Public responses expose lifecycle, claimability, synthetic provenance, and
active state. Owner-only fields are populated only when the validated token owns
the active claim. Claimant user IDs and verification metadata are not exposed on
public status surfaces.

## Pilot physician onboarding

### Canonical relationship

```
authenticated Supabase user (verified JWT `sub`)
  -> provider_claims         one active claim per NPI (partial unique index)
                             one active claim per account (trigger)
                             identity_confirmed_at = the physician's own assertion
  -> physician_owner_scopes  opaque storage_scope_id / physician_id (never the NPI)
                             nppes_snapshot_json = what the physician confirmed
                             pilot_access_status = Lamina's manual pilot gate
  -> /api/me/physician/*     private workspace, admitted by require_pilot_scope
```

No parallel account table exists. Pre-confirmation state lives in
`physician_identity_selections` (one row per account), which reserves nothing.

### Three distinct concepts

| Step | Meaning | Recorded as |
| --- | --- | --- |
| NPPES lookup | Identity discovery: a public, active, individual (NPI-1) record exists | selection row + `nppes_snapshot_json` |
| "Is this you?" | User assertion, not proof | `provider_claims.identity_confirmed_at`, `verification_method='nppes_match_self_attested'`, claim status `verification_pending` |
| Pilot approval | Manual Lamina gate | `pilot_access_status/decided_at/decided_by/note` |

None of these is credentialing or licensure verification. The claim stays
`verification_pending` after approval: Lamina has not independently verified
credentials.

### Onboarding states

`GET /api/me/onboarding/status` is the only projection, derived from the
database on every call: `account_created` → `identity_selected` →
`pilot_approval_pending` → `active`, plus `disabled` and `rejected`. A legacy
claim that was never confirmed projects as `identity_selected` and can only be
confirmed for the same NPI (its storage keys are preserved).

### Endpoints

- `GET /api/me/onboarding/status`
- `POST /api/me/onboarding/npi/lookup` `{npi}`. Validates format, check digit,
  and synthetic NPIs before any network call. Per-account throttle. Persists a
  server-side selection. Creates no claim or scope.
- `DELETE /api/me/onboarding/selection`: "Not me". Only before confirmation.
- `POST /api/me/onboarding/identity/confirm` `{npi}`. The NPI must match the
  server-held selection (max age `LAMINA_NPPES_SELECTION_MAX_AGE_SECONDS`).
  Identity data comes only from that stored snapshot; NPPES is not re-queried.
  One `BEGIN IMMEDIATE` transaction creates the claim and owner scope,
  idempotently. A conflict returns 409 `npi_already_claimed` without claimant
  details and never reassigns.
- Internal: `GET /api/internal/pilot-physicians?status=pending` and
  `POST /api/internal/pilot-physicians/{owner_scope_id}/{approve|reject|disable}`.
  Only Supabase user IDs listed in `LAMINA_PILOT_ADMIN_USER_IDS` can reach them;
  everyone else gets 404, and an empty list disables the API. Decisions on
  your own account return 403. Rejection releases the NPI and blocks the account
  from re-onboarding. Disable keeps the NPI claimed but closes the workspace.
- CLI equivalent (no HTTP surface):
  `python -m scripts.pilot_physicians list|approve|reject|disable`, recorded as
  `cli:<operator>`.

Every transition is appended to `physician_onboarding_events`.

### Database-enforced invariants

- `provider_claims_active_npi`: one active claim per NPI.
- `provider_claims_one_active_per_account_{insert,update}`.
- `provider_claims_identity_immutable`: a claim's NPI and owner cannot change.
- `physician_owner_scopes_match_claim`: a scope's user and NPI must equal its
  claim's.
- `physician_owner_scopes_identity_immutable`: NPI, owner, claim, and opaque
  keys cannot change.
- `physician_owner_scopes_insert_not_approved`: scopes are born `pending`.
- `physician_owner_scopes_approval_requires_confirmation`: `approved` requires
  an active claim with `identity_confirmed_at`.

The migration (`WorkflowStore._migrate_pilot_onboarding`) is additive and
idempotent. Existing scopes default to `pilot_access_status='pending'`, so they
fail closed until a physician confirms and Lamina approves.

### NPPES identity resolution

`backend/provider_network/identity.py` normalizes raw NPPES API records into
`NppesIdentity` (names, credential, all taxonomies with primary first, practice
locations excluding mailing addresses, no license numbers). It rejects
organization and inactive records, and maps timeout, outage, malformed JSON, a
record for the wrong NPI, an `Errors` payload, and HTTP 429 to explicit errors.
Every failure is closed. Only successes are cached, for 10 minutes.

### Frontend

`/me/onboarding` (`Onboarding.tsx`) renders only the backend status.
`OwnerShell` checks onboarding status before fetching or rendering any
owner-scoped content and redirects non-active accounts to onboarding. The
backend enforces the same gate independently. Real NPPES identities on
`/claim/provider/{npi}` link into onboarding rather than the legacy claim
call.

See `PUBLIC_DEPLOYMENT_AUDIT.md` before exposing the shared Lucy demo publicly.
