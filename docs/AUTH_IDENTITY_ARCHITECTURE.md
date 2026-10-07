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
scope per account; accounts with multiple owned claims explicitly select among
their own claim IDs.

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

- `POST /api/providers/{npi}/claim`
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
401, no active selection is a safe 409 (except the status projection), and an
unowned selector/resource is a non-disclosing 404.

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

## UX handoff

The frontend now has reusable `authClient.ts`, `AuthProvider`, `useAuth`, and one
bearer-aware API request layer. It intentionally has no polished sign-in,
sign-up, claim, or onboarding pages. A later UX pass can use the provider
profile's `claimed_by_me`, `my_claim_id`, and `my_claim_status` fields without
changing the backend identity model.

See `PUBLIC_DEPLOYMENT_AUDIT.md` before exposing the shared Lucy demo publicly.
