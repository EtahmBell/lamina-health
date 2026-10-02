# Public deployment audit

## Anonymous Lucy demo isolation

Mutable Lucy demo state is isolated by an unpredictable, server-issued workspace
ID in an `HttpOnly` cookie. The cookie contains no user or physician identity.
The backend validates it against `demo_workspaces`; a missing, expired, or unknown
value receives a fresh workspace. Immutable synthetic/FHIR source records are read
directly and are never copied per visitor.

The following are scoped by `workspace_id`: patient activity, consultation records,
Jordan reset, network members, My Agent learning/preferences, consultation history,
and the derived network projection. Consultation record lookup includes the
workspace boundary, so another visitor cannot retrieve a record by guessing its
numeric ID.

Provider claims and `provider_agent_state` are intentionally global. They represent
authenticated physician identity ownership and activation, not Lucy visitor state.
Losing a demo cookie therefore creates a clean Lucy workspace without altering
claims or activated agents.

## Cookie, CORS, and CSRF configuration

The frontend sends `credentials: include`. `LAMINA_CORS_ORIGINS` must contain exact
frontend origins; `*` is rejected at startup and credentialed CORS is enabled.
Same-origin deployment is preferred. For a genuinely cross-site frontend/API pair,
use HTTPS with `LAMINA_DEMO_COOKIE_SECURE=true` and
`LAMINA_DEMO_COOKIE_SAMESITE=none`; otherwise keep the default `lax`. Set a cookie
domain only when the deployment topology requires it.

Cookie-authenticated mutation endpoints validate the browser `Origin` header
against the same explicit origin list. SameSite is the first CSRF boundary and the
origin check is defense in depth. Bearer-authenticated claim endpoints continue to
derive identity exclusively from the validated Supabase token.

## Persistence, expiry, and concurrency

`LAMINA_WORKFLOW_DATABASE` must point to a persistent volume. Ephemeral container
storage will lose demo workspaces, claims, and provider-agent state on restart.
Anonymous workspaces use a sliding TTL (default seven days). Schedule:

```powershell
.\.venv\Scripts\python.exe scripts\cleanup-demo-workspaces.py
```

SQLite uses atomic transactions, a five-second busy timeout, and `BEGIN IMMEDIATE`
for workspace creation and claim ownership races. This is suitable for a small,
single-instance demonstration. It is not a multi-instance/high-write deployment
database: do not mount one SQLite file concurrently from multiple application
replicas. Move workflow and identity state to a transactional server database
before scaling horizontally.

## Authentication integration checklist

- In Supabase Authentication, enable email/password, set the Site URL to the exact
  frontend origin, and add only the intended local/staging/production redirect URLs.
  This UI currently uses password sign-in/sign-up and does not add OAuth providers.
- Set `VITE_SUPABASE_URL` to the project URL and `VITE_SUPABASE_ANON_KEY` to the
  public anon/publishable key. Never expose a service-role key in Vite.
- Set backend `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`,
  `SUPABASE_JWT_AUDIENCE=authenticated`, and optionally
  `SUPABASE_JWKS_CACHE_SECONDS`. The frontend origin must also be present in
  `LAMINA_CORS_ORIGINS`.
- Verify sign-in, sign-up, refresh, sign-out, and an expired-session return to sign-in.
- Confirm `return` accepts only local absolute paths and cannot navigate off-origin.
- Confirm real NPPES profiles cannot use demo verification.
- Confirm activation is offered only to the verified claim owner.
- Confirm claim conflicts remain generic and disclose no claimant identity.
- Confirm “Add to my network” remains separate from “Claim this identity.”
- Keep `LAMINA_DEMO_VERIFICATION_ENABLED=false` in public production.

Once real credentials are available, use this deterministic staging smoke:

1. Sign up and confirm FastAPI accepts the Supabase access token.
2. Claim a controlled synthetic provider, submit verification, use the explicitly
   enabled synthetic demo-verification route, and activate the agent.
3. Restart the backend on the same persistent database and confirm the agent is
   still active.
4. Sign out and back in and confirm the provider claim remains owned.
5. Claim a real NPPES profile and submit verification. Confirm it remains pending,
   exposes no self-verification path, and cannot activate.

Do not run the synthetic shortcut against real NPPES identities, and disable it
again before public production.

Automated tests cover two independent cookie jars, cross-workspace record denial,
scoped reset/network/preferences/activity, global claim state, and rejected foreign
origins. Before calling a deployment public-ready, repeat the Lucy workflow in two
independent browser contexts against the deployed frontend and API.
