# Pilot end-to-end tests (Playwright)

DEV ONLY. Synthetic data only. The harness drives the real pilot app (Vite) and the real pilot API
(the DEV launcher `scripts/dev_pilot_server.py`, fictional NPPES) against a dedicated Postgres
database, `lamina_e2e`, on the local dev container (run 2; dropped and re-migrated with Alembic at
every run). It never touches the walkthrough database, the database in `.env`, or
any production system. It uses the installed Google Chrome (`channel: 'chrome'`), so no browser
download is needed.

## What it covers

| Spec | Roles in one test |
|---|---|
| `01-setup` | second physician: setup stages A–E, confirm the representation, shadow mode |
| `02-missing-info` | staff + referring office (no account): request → sender reply → Home "Verify" lands on Verify |
| `03-staff-handoff` | staff + physician: "Ready for Dr. X", "Flag for Dr. X"; staff have no fit/priority/visit-type controls |
| `04-signoff` | physician + staff: correction + accept / redirect / decline as the sign-off; stored sign-off is physician-only |
| `05-attribution` | staff + physician: named actors everywhere; cause vs trigger in "Changed since you last looked" |
| `06-conflict` | staff + physician: correction-vs-newer-rule banner; "Keep my correction" and "Apply the rule", each recorded |
| `07-still-open` | physician + staff: "Ready for your decision" plus one "Still open" line |
| `08-teaching` | staff + physician: a staff suggestion is pending for the physician; staff can't confirm |
| `09-practice-statements` | admin physician, non-admin physician, staff: only the admin can confirm a practice-level statement |
| `10-staff-third-person` | staff: Your Agent and the dock about the physician, in the third person |
| `11-isolation` | physician, staff, second physician: two practices never see each other's referrals |
| `12-public-privacy` | referring office: nothing private on the public page or the sender page (UI and API) |
| `13-activation` | physician, second physician, staff: readiness review, activation, flags (resolved with a note), pause |
| `14-staff-invite` | admin + new staff account: invite by email → create own account → accept → set up TOTP → first sign-in → sign in again with a code; email-bound and revoked links; deactivation ends access |
| `15-physician-invite` | admin + new physician account: invite → accept → TOTP → confirm own NPI → operator approval → own agent (setup), not admin |

Specs run one at a time (one shared seeded database) in file order. Each scenario uses its own
seeded referral, so specs don't depend on each other.

## One-time setup

0. **Local Postgres.** Install Docker Desktop, put a local-only password in the gitignored `.env`,
   and start the container (loopback only, port 5433):

   ```
   LAMINA_DEV_PG_PASSWORD=<local password>
   LAMINA_TEST_DATABASE_URL=postgresql://lamina:<same password>@127.0.0.1:5433/lamina_dev
   ```

   `docker compose -f docker-compose.dev.yml up -d`. The harness derives the `lamina_e2e` URL from
   `LAMINA_TEST_DATABASE_URL` and refuses anything not on loopback. The backend tests use the same
   server (a fresh database per test, cloned from a migrated template).

1. **Declare the DEV Supabase project.** Create `frontend/e2e/.env.e2e` (gitignored):

   ```
   E2E_SUPABASE_DEV_URL=https://<your-dev-project-ref>.supabase.co
   E2E_CONFIRM_DEV_PROJECT=yes
   ```

   Every run refuses to start unless `frontend/.env` (`VITE_SUPABASE_URL`) and the API's
   `SUPABASE_JWT_ISSUER` both point at that project, the app and API run on loopback, and the
   database is the dedicated e2e one. Messages never print URLs, keys or tokens.

2. **Create three test accounts in the DEV Supabase project** (Supabase dashboard → Authentication
   → Add user, or the app's sign-up page): one each for the physician (practice admin), the
   second physician (not an admin) and staff. Use addresses you control; passwords stay with you
   (a password manager). The harness never stores or types a password.

3. **Sign in once per role** (opens Chrome; you sign in yourself):

   ```
   cd frontend
   npm run e2e:capture                 # all three roles in turn
   npm run e2e:capture -- staff        # or one role: physician | second_physician | staff
   ```

   Each signed-in session is saved to `frontend/e2e/.auth/<role>.json`, and the account's user id
   to `frontend/e2e/.auth/accounts.json` (both gitignored). Tracing and video are off for capture.
   Re-run capture for a role if the run says its session has expired (Supabase refresh tokens
   eventually lapse, for example after a sign-out elsewhere).

## Running

```
cd frontend
npm run e2e                 # the multi-role specs (about 2–4 minutes)
npm run e2e -- -g signoff   # one spec by title
npm run e2e:screens         # UI-review screenshots → ui-review/<date-time>/<viewport>/
npm run e2e:screens -- my-review   # → ui-review/my-review/<viewport>/
npm run e2e:typecheck       # TypeScript check of the harness
```

Each run starts the e2e API on 127.0.0.1:8011 and the app on 127.0.0.1:5183 (strict ports, never
reused), after **resetting and seeding** the e2e database (`python -m scripts.e2e_seed reset`).
A `sessions` step first opens each saved session, lets Supabase refresh it if needed, saves it
back, and fails with a clear message if a session expired.

## Seeded data (`scripts/e2e_seed.py`)

Deterministic, fictional, marked "E2E", written through the real pilot API in-process:

- **Practice A — Northfield Endocrinology (E2E):** Dr. Avery Testwell (fictional NPI, practice
  admin, agent in shadow) and staff "Front desk (E2E)"; rules for Thyroid nodule, Diabetes
  management, Adrenal nodule, Osteoporosis, Hyperparathyroidism; a pending practice-level
  learning; a published public page; one referral per scenario (request, ready, flag, sign-off,
  redirect, decline, change note, two correction conflicts, ready-with-open-request with a sender
  link).
- **Practice B — Riverside Nephrology (E2E):** Dr. Jordan Sampleton (the second physician), agent
  still initializing, two closed referrals.

The seed refuses to run unless `LAMINA_E2E=1`, pilot mode, fictional NPPES, and the e2e database
(`lamina_e2e` on loopback) are all set. Ids and the sender link land in `frontend/e2e/.state/seed.json` (gitignored).
Dev-only scenario switches used by specs: `python -m scripts.e2e_seed step
join-second-physician | return-second-physician | initializing-second-physician |
shadow-second-physician`, and read-only `inspect signoff|resolutions <referral id>`.
`join-second-physician` moves the SEEDED second physician between the practices directly in the
database (spec 15 covers the real invite → join flow with a new account). Other steps:
`approve-invited-physician` (the operator approves spec 15's physician through the internal API),
`new-unverified-referral` and `flag-auto-draft-three-times` (screens only), and read-only
`inspect account-events -` (event types only, for the audit assertions).

## New accounts in specs 14–15 (dev-only test sign-in)

Brand-new invitees can't use real DEV Supabase accounts without typing a password, so the e2e
API runs a **dev-only test identity provider** (`backend/dev_test_auth.py`) and the e2e dev
server (only) compiles in its client (`VITE_LAMINA_DEV_TEST_AUTH=1`). A browser context opts in
(`lamina.devTestAuth` in localStorage, loopback only); the three captured roles keep using real
DEV Supabase sessions. Invitee emails and passwords are generated per run in memory and never
printed; TOTP codes are computed from the setup key the page shows (RFC 6238), exactly as an
authenticator app would. The provider refuses to start unless every e2e/dev condition holds and
nothing looks like production; `tests/test_pilot_accounts.py` checks that.

**MFA for the captured accounts.** The three captured sessions were created before MFA was
required; on the DEV launcher only, those three user ids (from `.auth/accounts.json`) count as
MFA-verified (`LAMINA_E2E_MFA_EXEMPT_USER_IDS`, set by the harness). Everything else, including
every invitee in specs 14–15, sets up and passes real TOTP. Screenshots mask the invitation link,
the setup key and the QR code.

## Screenshots

`npm run e2e:screens` captures a fixed list at 1440×900, 1280×800 and 390×844 (real viewport
emulation; the phone size also emulates touch and a 2× display) for the physician, staff, second
physician and an unauthenticated office: Home (busy and nothing-needs-you), For you, Patients,
referral detail in each state, setup stages A–E, representation review, Your Agent
(initializing and shadow), a pending learning, the conflict banner, Network, the public page,
the sender page, and loading and error states. Output goes to `ui-review/` (gitignored).

## Safety

- Dev Supabase only, declared explicitly; refuses otherwise. No production systems.
- Credentials are never handled by the harness; sessions and account ids are local and
  gitignored; no token is printed. Playwright traces and videos are off (they would record
  request headers and typed input); failure screenshots stay in `frontend/test-results/`
  (gitignored).
- Synthetic data only; every name is fictional and marked "E2E".

## Intake pipeline specs (run 3)

`specs/16-intake.spec.ts`: upload → extract → create referral → triage → Verify; a faxed reply delivered
through the signed mock fax webhook → matched to its information request → Verify; a duplicate patient
suggested, merged on confirmation, then undone. The e2e API runs the `mock` fax/email vendors with
synthetic webhook secrets (`frontend/e2e/support/env.ts`) and the `local` extractor. The seed steps
`intake-scenarios` and `intake-inbox` write the synthetic fixtures (`scripts/intake_fixtures.py`) to
`data/e2e/intake-fixtures` (gitignored) and deliver them through the webhooks for the screens.
