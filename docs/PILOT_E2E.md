# Pilot end-to-end tests (Playwright)

DEV ONLY. Synthetic data only. The harness drives the real pilot app (Vite) and the real pilot API
(the DEV launcher `scripts/dev_pilot_server.py`, fictional NPPES) against a dedicated database,
`data/e2e/pilot-e2e.sqlite`. It never touches the walkthrough database, the database in `.env`, or
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

Specs run one at a time (one shared seeded database) in file order. Each scenario uses its own
seeded referral, so specs don't depend on each other.

## One-time setup

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
path are all set. Ids and the sender link land in `frontend/e2e/.state/seed.json` (gitignored).
Dev-only scenario switches used by specs: `python -m scripts.e2e_seed step
join-second-physician | return-second-physician | initializing-second-physician |
shadow-second-physician`, and read-only `inspect signoff|resolutions <referral id>`.
Joining a practice as a second physician isn't a product flow yet, so that step arranges it
directly in the database.

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
