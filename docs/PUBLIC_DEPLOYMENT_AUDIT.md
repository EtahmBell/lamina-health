# Public deployment shared-state audit

The current synthetic Lucy workspace is one global SQLite workspace. Browser
visitors are not isolated from one another. This is intentionally documented
rather than hidden with browser `localStorage`.

## Shared mutable state

- `patient_activity`: opening or starting Jordan or Maria changes global recency.
- `consultations`: completed consults and their derived history/network edges are global.
- `network_members`: add/remove operations change the one shared physician roster.
- `agent_preferences`: My Agent learning confirmations, edits, and rejections are global.
- Jordan reset deletes every visitor's Jordan consultation history and activity state.

Provider claims are separately keyed by authenticated Supabase user, and active
NPI uniqueness is enforced globally. That is appropriate for identity ownership;
it does not isolate the synthetic Lucy workspace.

## Unsafe public-demo endpoints

The following write or expose shared visitor state and must not be opened to
uncoordinated public traffic as-is:

- `GET /api/patients/{patient_id}` (records a global open event)
- `POST /api/patients/{patient_id}/consultations`
- `PUT /api/workspace/agent/learnings/{key}`
- `POST /api/workspace/demo/reset/jordan`
- `POST /api/workspace/network/members`
- `DELETE /api/workspace/network/members/{npi}`
- shared-state reads under `/api/workspace/activity`, `/api/workspace/consultations`,
  and `/api/workspace/network`

## Smallest correct deployment isolation

Before public deployment, issue each visitor an opaque, server-managed demo
workspace ID (preferably in a signed, HttpOnly, SameSite cookie) and add that ID
to the workflow tables and every corresponding query. Seed each workspace from
an immutable Lucy demo baseline and make Jordan reset scoped to that workspace.
Apply bounded expiry/cleanup for abandoned demo workspaces. Do not use
`localStorage` as the authority: it cannot prevent cross-visitor database writes
or make backend authorization correct.

This pass does not perform that tenancy migration because it is independent of
authenticated provider ownership and would materially expand the requested
foundation work.
