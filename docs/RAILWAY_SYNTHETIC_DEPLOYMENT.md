# Railway: the hosted synthetic deployment

Railway auto-deploys this repository. It hosts the **synthetic demo/sandbox only — never patient
data**. The frontend is a separate Vite build (it carries a `vercel.json` SPA rewrite) that calls
this API through `VITE_API_BASE_URL`.

## How Railway builds and starts the app today (from the repository)

* **No Railway config in the repository**: there is no `railway.json`/`railway.toml`, `Procfile`,
  `Dockerfile` or `nixpacks.toml`. Railway's builder detects a Python project from `pyproject.toml`
  + `uv.lock` and installs with the lockfile (`uv sync --locked`-style). That is why a stale `uv.lock`
  failed the build. It installs the base dependencies only — not the `dev` extra (pytest, ruff, moto).
  The Anthropic SDK is a base dependency (run 4), so the demo can use the `anthropic` provider.
* **Start command**: the dashboard's `python -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT`,
  now also pinned in `railway.json` (run 3/4).
* The repository's `.env` is gitignored, so nothing from it reaches Railway; every setting comes from
  Railway's variables.

## What it runs with today (from the code's defaults, unless Railway's variables say otherwise)

| Setting | Variable | Default when unset | So today, unless set on Railway |
|---|---|---|---|
| Profile | `LAMINA_PROFILE` | `dev` | **dev** — none of the hosted-deployment checks run |
| Product mode | `LAMINA_PRODUCT_MODE` | `demo` | the synthetic demo (Lucy/Chen/Iain personas) |
| Database | `LAMINA_WORKFLOW_DATABASE` | `data/workflow.sqlite` inside the container | **SQLite on the container's ephemeral disk**: demo workspaces, claims and agent state are lost on every redeploy/restart unless this points at a mounted volume. `LAMINA_DATABASE_URL` is ignored in demo mode. |
| Documents | `LAMINA_DOCUMENT_STORAGE` | `local` | local disk (only pilot mode stores documents) |
| Model | `LAMINA_MODEL_PROVIDER` | `openai` if `LAMINA_OPENAI_ENABLED=true`, else `disabled` | whatever `LAMINA_OPENAI_ENABLED` says |
| Patient-data approval | `LAMINA_MODEL_PATIENT_DATA_APPROVED` | false | nothing stops it being set (dev profile) |
| e2e test sign-in | `LAMINA_E2E_TEST_AUTH` | off | refuses to install on Railway anyway (`RAILWAY_*` markers) |

Paste Railway's variable *names* (not values) and the first lines of a deploy log if you want this
table confirmed; the log line to look for is uvicorn's start line and any `Refusing to start` message.

## The synthetic profile: `LAMINA_PROFILE=demo`

`backend/profiles.py: demo_problems()`; `create_app` refuses to start with any problem.

* Refuses: `LAMINA_MODEL_PATIENT_DATA_APPROVED` (any truthy value), `LAMINA_E2E`,
  `LAMINA_E2E_TEST_AUTH`, `LAMINA_E2E_MFA_EXEMPT_USER_IDS`, `LAMINA_DEV_FAKE_NPPES`, `LAMINA_DEBUG`,
  `DEBUG`, `PYTHONDEVMODE`, a real mail adapter (`LAMINA_MAIL_ADAPTER` other than `dev`), an unset
  `LAMINA_MODEL_PROVIDER`, `anthropic` without `ANTHROPIC_API_KEY`, non-numeric model limits, missing or
  non-https `LAMINA_CORS_ORIGINS`, and a `.env` file in the image.
* The approval flag is also **ignored** at runtime in this profile: `patient_data_approved()` and
  every provider's `approved_for_patient_data` are false, even if the flag slipped through.
* Never reads `.env` (like production).
* `/health` adds `"deployment": "synthetic"`, and the frontend then shows a sticky
  **"Synthetic demo · no PHI — never enter real patient information"** strip on every page, at every
  width, in demo and pilot mode (`frontend/src/SyntheticDeploymentBanner.tsx`). Local dev and e2e
  never report it, so they never show the strip.
* Refused (run 3): `LAMINA_DEMO_VERIFICATION_ENABLED`. The synthetic demo doesn't need it: the personas and
  Consult Network never verify a claim. It only shortcuts the signed-in "claim a synthetic physician →
  verify → activate" path, which on a public site would let anyone self-verify; with it off that path
  stops at "verification pending" and the UI says demo verification is unavailable.
* **`anthropic` is allowed here (run 4)** — synthetic data only. It has no BAA, so it is never approved for
  patient data (hard-coded, and this profile ignores the approval flag anyway). Production still refuses it
  at startup and `guarded_call` refuses it in production at call time.
* **Model-spend protection (run 4, `backend/demo_model_budget.py`)**, for every provider in this profile:
  * per session (the demo workspace cookie, or the bearer token, hashed) and per client IP (hashed):
    `LAMINA_DEMO_MODEL_PER_SESSION_LIMIT` (default 20) and `LAMINA_DEMO_MODEL_PER_IP_LIMIT` (default 40) calls per
    `LAMINA_DEMO_MODEL_WINDOW_SECONDS` (default 600);
  * a daily cap for the whole deployment, `LAMINA_DEMO_MODEL_DAILY_CAP` (default 300; `0` turns model calls
    off), counted per UTC day in a small SQLite file next to `LAMINA_WORKFLOW_DATABASE` (on the volume, so a
    restart doesn't reset it; override with `LAMINA_DEMO_MODEL_USAGE_DB`);
  * when a limit is hit the call never reaches the provider; the feature falls back to its non-AI behaviour,
    the response carries `X-Lamina-AI-Limited: session|ip|daily_cap`, and the synthetic banner adds
    "AI answers are paused … You're seeing the standard, non-AI responses."
  * The windows are in-process (one replica, pinned in `railway.json`). Behind Railway's proxy set
    `LAMINA_TRUST_PROXY=true`, or every visitor shares the proxy's IP and the per-IP limit.
* The production profile is unchanged and still refuses everything it refused, including
  `LAMINA_MODEL_PROVIDER=anthropic`.

## SQLite or Railway Postgres?

**Stay on SQLite, on a Railway volume, for the synthetic demo.** Reasons:

1. The demo's store is SQLite-only by design: `WorkflowStore` uses Postgres only in pilot mode, and
   the demo tables (`demo_workspaces`, `consultations`, …) are not in the Alembic migrations. Moving
   the demo to Postgres would mean porting its schema and tests — new work with no safety benefit for
   synthetic data.
2. The demo is a single instance with low write volume, which SQLite handles (atomic transactions,
   busy timeout, `BEGIN IMMEDIATE`; see docs/PUBLIC_DEPLOYMENT_AUDIT.md).
3. Today's real problem is persistence, not the engine: SQLite on the ephemeral disk loses state on
   every deploy. A volume fixes that.

Keep the service at **one replica** (never mount one SQLite file from several). Move to Railway
Postgres only if you start running **pilot mode** on Railway with synthetic data (pilot is
Postgres-first: `LAMINA_DATABASE_URL` + `alembic upgrade head`) or need more than one replica.

## Railway setup steps

1. Add a **volume** to the API service, mounted at `/data`.
2. Set the variables below; remove the ones under "remove".
3. `railway.json` pins the start command — exactly the dashboard's
   `python -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT` — the `/health` health check, one
   replica and restart-on-failure. **Config in the repository overrides the dashboard on the next
   deploy**; keep the two in step. The builder is left to the dashboard (not pinned).
4. Redeploy. Check that `/health` returns `"deployment": "synthetic"` and the strip shows on the site.
   A `Refusing to start the synthetic demo deployment` log line names each problem (never a value).

### API service variables (placeholders only)

| Variable | Value | Note |
|---|---|---|
| `LAMINA_PROFILE` | `demo` | **new** |
| `LAMINA_PRODUCT_MODE` | `demo` | explicit |
| `LAMINA_MODEL_PROVIDER` | `anthropic`, `openai` or `disabled` | required by the profile |
| `ANTHROPIC_API_KEY` | `<ANTHROPIC_API_KEY>` | secret; only if the provider is `anthropic` |
| `LAMINA_ANTHROPIC_MODEL` | `<ANTHROPIC_MODEL_ID>` | optional (default `claude-opus-5-5`) |
| `LAMINA_ANTHROPIC_EFFORT` | `<EFFORT>` | optional (default `low`) |
| `OPENAI_API_KEY` | `<OPENAI_API_KEY>` | secret; only if the provider is `openai` |
| `LAMINA_OPENAI_MODEL` | `<OPENAI_MODEL_ID>` | only if the provider is `openai` |
| `LAMINA_DEMO_MODEL_DAILY_CAP` | `<CALLS_PER_DAY>` | **run 4**; default 300, `0` = no model calls |
| `LAMINA_DEMO_MODEL_PER_SESSION_LIMIT` | `<CALLS>` | optional (default 20 per window) |
| `LAMINA_DEMO_MODEL_PER_IP_LIMIT` | `<CALLS>` | optional (default 40 per window) |
| `LAMINA_DEMO_MODEL_WINDOW_SECONDS` | `<SECONDS>` | optional (default 600) |
| `LAMINA_DEMO_MODEL_USAGE_DB` | `/data/<USAGE_SQLITE_FILE>` | optional (default: next to the workflow database) |
| `LAMINA_CORS_ORIGINS` | `https://<FRONTEND_ORIGIN>` | exact https origin(s), comma-separated |
| `LAMINA_WORKFLOW_DATABASE` | `/data/workflow.sqlite` | on the volume |
| `LAMINA_DEMO_COOKIE_SECURE` | `true` | the frontend and API are on different sites |
| `LAMINA_DEMO_COOKIE_SAMESITE` | `none` | same reason (docs/PUBLIC_DEPLOYMENT_AUDIT.md) |
| `LAMINA_TRUST_PROXY` | `true` | **set it** (run 4): the per-IP model limit reads the client IP behind Railway's proxy |
| `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE` | `<SUPABASE_PROJECT_URL>/auth/v1`, `…/.well-known/jwks.json`, `authenticated` | only if the demo's sign-in is used |
| `LAMINA_NPPES_DATABASE` | `/data/<NPPES_SQLITE_FILE>` | only if the NPPES directory file is provided |

Remove (or never set) on this service: `LAMINA_MODEL_PATIENT_DATA_APPROVED`, `LAMINA_E2E`,
`LAMINA_E2E_TEST_AUTH`, `LAMINA_E2E_MFA_EXEMPT_USER_IDS`, `LAMINA_DEV_FAKE_NPPES`, `LAMINA_DEBUG`,
`DEBUG`, `PYTHONDEVMODE`, `LAMINA_DEMO_VERIFICATION_ENABLED`, `LAMINA_OPENAI_ENABLED` /
`LAMINA_RESPONSES_ENABLED` (superseded by `LAMINA_MODEL_PROVIDER`), `LAMINA_DATABASE_URL` (unused in
demo mode). Leave `LAMINA_MAIL_ADAPTER` unset.

### Frontend build variables

`VITE_API_BASE_URL=https://<RAILWAY_API_DOMAIN>`, `VITE_LAMINA_PRODUCT_MODE=demo`,
`VITE_SUPABASE_URL=<SUPABASE_PROJECT_URL>`, `VITE_SUPABASE_ANON_KEY=<SUPABASE_ANON_KEY>` (public anon key
only — never a service-role key). Never set `VITE_LAMINA_DEV_TEST_AUTH`.
