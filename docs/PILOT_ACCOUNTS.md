# Pilot accounts and access (go-live prep, run 1)

Who can get into the pilot, how, and how access ends. Pilot mode only; the demo is unchanged.
Synthetic data in every test.

## The path in

```text
Invitation (by email)                         Request (invite-only, reviewed)
  admin → staff / physician                     sign up → confirm NPI → Lamina approves
  operator → physician (new practice)                          │
        │                                                      ▼
        ▼                                                set up the practice
  accept (with the invited email) → two-step sign-in (TOTP) → first sign-in
        │
        ├─ staff: the workspace opens (the practice's approval gate still applies)
        └─ physician: confirm your OWN NPI → join as a physician (not admin) →
                      Lamina approves the new identity → your own agent, from setup
```

* **No open self-service practice.** A new practice needs an **operator invitation** (bound to an
  email and an NPI; confirming that NPI approves the request) or an **operator-approved request**
  (the existing manual pilot approval). `POST /api/me/practice` refuses (`pilot_access_pending`)
  until the physician's identity is approved. The pilot landing page offers "Sign in" and
  "Request pilot access"; sign-up is framed as a request.
* **Invitations** (`POST /api/me/practice/invitations`, admin only): `{role: staff|physician,
  email, label?}`. Single use, bound to the email (the accepting account's email must match),
  expire after **7 days**, revocable until accepted. The token is returned once to the admin and
  stored only as a hash; it is never logged, stored in events, or shown again ("Done — hide the
  link" takes it off the screen). Invitations created before this run have no email and can't
  be accepted any more.
* **Second physician.** Accepting a physician invitation records the acceptance only. The
  physician confirms their own NPI identity (NPPES lookup, self-attested); then they join as a
  physician, **non-admin**, with their own owner scope: their own agent, representation layer
  and lifecycle (starting at setup, even when the practice already has rules). The Lamina pilot
  approval still applies to the new identity.
* **Staff can never claim a physician identity.** An account that is or was a staff member, or
  holds an accepted staff invitation, is refused by every onboarding route (`staff_account`) and
  can't accept a physician invitation. A confirmed physician can't join as staff.

## Two-step sign-in (MFA)

* Every pilot route requires a session that passed TOTP: the Supabase access token must say
  `aal2`. Only these accept an `aal1` session: `GET /status` (returns `next_step: "mfa"` and
  nothing about the practice), invitation preview/accept, the lost-authenticator request, and
  "sign out everywhere". Onboarding and operator routes need MFA too (pilot mode only).
* First sign-in: "Set up two-step sign-in" (QR code or setup key, then a 6-digit code). Every
  later sign-in: "Enter your code".
* **Recovery an admin can't abuse.** Only the member can ask for a reset ("Lost your
  authenticator?", from their own password session); only a **Lamina operator** can complete it
  (`/api/internal/pilot-access/mfa-recovery/{id}/complete`, with a note on how identity was
  checked out of band; never for themselves). A practice admin can neither ask nor approve, and
  never sees codes. Completing a reset signs out every session and makes any earlier second
  factor stop counting. **Operator step:** remove the member's old factor in the Supabase
  dashboard (Authentication → Users → MFA factors); Lamina doesn't hold a service key.
* Audit: `mfa_enrolled` (first MFA session), `mfa_recovery_requested`, `mfa_reset`,
  `mfa_recovery_declined`, `mfa_reenrolled`.

## Membership and sessions

* **Deactivate** (`POST /members/{id}/deactivate`, admin only; `DELETE /members/{id}` does the
  same): any role, never yourself, never the last admin. Access ends at once (the membership is
  no longer active, and every session issued before is refused). Their history keeps their name
  (attribution reads former members too). The account sees "Your access to X has ended" and
  can't start a practice or claim an identity on its own; a new invitation is the way back.
* **Sign out everywhere** (Profile → Sign-in & security): `POST /sessions/revoke-all` makes the
  server refuse every session issued up to now, then Supabase revokes refresh tokens (global
  sign-out).
* **Idle timeout**: 30 minutes without activity in any Lamina tab signs out this device, with a
  warning 2 minutes before ("Stay signed in"). Configure Supabase's own session limits as well
  (inactivity timeout / time-box) on the production project.

## Events (append-only `pilot_events`; ids only — never tokens, links or email addresses)

`staff_invited`, `physician_invited`, `staff_invitation_revoked`, `physician_invitation_revoked`,
`staff_joined`, `physician_invitation_accepted`, `physician_joined`, `practice_admin_granted`,
`practice_admin_revoked`, `member_deactivated` (replaces `staff_removed`), `signed_out_everywhere`,
`mfa_enrolled`, `mfa_reenrolled`, `mfa_recovery_requested`, `mfa_reset`, `mfa_recovery_declined`,
`pilot_access_invited`, `pilot_access_invitation_accepted`, `pilot_access_invitation_revoked`,
`pilot_access_approved_by_invitation`.

## Schema (additive)

* `practice_invitations` rebuilt once (SQLite can't widen a CHECK): role `staff | physician`, plus
  `email`, `member_id`, `revoked_by`. Existing rows are kept.
* `pilot_account_security(user_id, sessions_revoked_at, mfa_reset_at, mfa_enrolled_at)`.
* `pilot_access_invitations` (operator invitations to set up a new practice: email + NPI).
* `mfa_recovery_requests` (one open request per account).
* `agent_item_flags.resolution_note` (Step 18 follow-up).

## Supabase project settings (production)

* Authentication → Multi-Factor: **TOTP enabled**.
* Sign-ups stay enabled (invitees create their own accounts); Lamina enforces invite-only.
* Confirm email on; Redirect URLs allow-list includes `/me/join` on the app origin.
* Session settings: consider an inactivity timeout and time-box in addition to the app's.

## Dev-only test sign-in (e2e)

`backend/dev_test_auth.py` + `frontend/src/devTestAuth.ts` stand in for Supabase sign-up, sign-in
and TOTP so Playwright can create brand-new invitees. Installed only by the DEV launcher when
`LAMINA_E2E=1`, `LAMINA_E2E_TEST_AUTH=1`, pilot mode, fictional NPPES and the e2e database are
all set and no production marker is present; it refuses otherwise. `backend.main` never imports
it, a production verifier never accepts its tokens (HS256, its own issuer), and the frontend
code is compiled in only when `VITE_LAMINA_DEV_TEST_AUTH=1`; `npm run build` fails if a bundle
contains it. The three captured DEV Supabase e2e accounts count as MFA-verified on the DEV
launcher only (they were captured before MFA was required). Tests:
`tests/test_pilot_accounts.py` (refused in production, outside the harness; tokens rejected by
the real verifier) and `frontend/test/pilotAccess.test.mjs`.
