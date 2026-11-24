"""Accounts and access for the pilot (go-live prep, run 1).

* Sessions. Every pilot request runs on a verified Supabase session. Sessions issued before an
  account's `sessions_revoked_at` are refused: "sign out everywhere", deactivation and an MFA
  reset all set it. (Supabase revokes refresh tokens on a global sign-out; this closes the gap
  for access tokens that haven't expired yet.)
* MFA. Every pilot user must pass a second factor (TOTP via Supabase): the access token must say
  `aal2`. A factor verified before an operator MFA reset no longer counts. Lamina records the
  first time it sees an account pass MFA (`mfa_enrolled`), and again after a reset.
* Recovery. Only the member can ask for a lost-authenticator reset, from their own signed-in
  (password) session; only a Lamina operator can complete it, never for themselves. A practice
  admin can neither ask for nor approve a reset, so an admin can't take over a member's account.
* New practices are invite-only: an operator invitation (bound to an email and an NPI) or an
  operator-approved request (the existing pilot approval of a confirmed physician identity).

Nothing here logs or returns tokens, invitation links or credentials, except the one response
that hands a newly created invitation token to the person who created it.
"""

from __future__ import annotations

import re
from datetime import datetime

from backend.auth import AuthenticatedUser

from .practice import PilotError
from .store import INVITATION_TTL_DAYS, PilotStore, now_iso

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: str | None) -> str | None:
    text = (value or "").strip().casefold()
    return text or None


def valid_email(value: str | None) -> str:
    email = normalize_email(value)
    if not email or not EMAIL_PATTERN.match(email) or len(email) > 254:
        raise PilotError("invalid_email", "Enter a valid email address", 422)
    return email


def _epoch(iso: str | None) -> float | None:
    return datetime.fromisoformat(iso).timestamp() if iso else None


class AccountService:
    def __init__(self, store: PilotStore) -> None:
        self.store = store

    # ---------------------------------------------------------------- sessions

    def check_session(self, user: AuthenticatedUser) -> None:
        revoked = _epoch(self.store.account_security(user.id)["sessions_revoked_at"])
        if revoked is not None and (user.issued_at is None or user.issued_at < int(revoked)):
            raise PilotError("session_revoked", "This session has been signed out. Sign in again", 401)

    def mfa_verified(self, user: AuthenticatedUser) -> bool:
        if user.aal != "aal2":
            return False
        reset = _epoch(self.store.account_security(user.id)["mfa_reset_at"])
        return reset is None or (user.issued_at is not None and user.issued_at >= int(reset))

    def require_mfa(self, user: AuthenticatedUser) -> None:
        if not self.mfa_verified(user):
            raise PilotError("mfa_required", "Finish two-step sign-in to continue", 403)
        self.note_mfa(user)

    def note_mfa(self, user: AuthenticatedUser) -> None:
        """Audit: the first session that passed MFA (and the first again after a reset)."""
        if not self.mfa_verified(user):
            return
        security = self.store.account_security(user.id)
        if security["mfa_enrolled_at"]:
            return  # (an operator reset clears it, so the next MFA session is a re-enrollment)
        membership = self.store.membership_for_user(user.id)
        self.store.set_account_security(user.id, mfa_enrolled_at=now_iso(), event={
            "event_type": "mfa_reenrolled" if security["mfa_reset_at"] else "mfa_enrolled", "actor": f"user:{user.id}",
            "practice_id": membership["practice_id"] if membership else None, "metadata": {"method": "totp"}})

    def revoke_all_sessions(self, user: AuthenticatedUser) -> dict:
        """"Sign out everywhere": every session issued up to now stops working at once."""
        now = now_iso()
        membership = self.store.membership_for_user(user.id)
        self.store.set_account_security(user.id, sessions_revoked_at=now, event={
            "event_type": "signed_out_everywhere", "actor": f"user:{user.id}",
            "practice_id": membership["practice_id"] if membership else None})
        return {"revoked_at": now}

    # ----------------------------------------------------------------- recovery

    def recovery_view(self, user_id: str) -> dict | None:
        row = self.store.fetch_one(
            "SELECT status, created_at, decided_at FROM mfa_recovery_requests WHERE user_id = ? "
            "ORDER BY created_at DESC LIMIT 1", (user_id,))
        return dict(row) if row else None

    def request_recovery(self, user: AuthenticatedUser, reason: str | None) -> dict:
        """The member (signed in with their password, without their authenticator) asks Lamina to
        reset two-step sign-in. Nothing changes until an operator completes it."""
        membership = self.store.membership_for_user(user.id)
        self.store.open_recovery_request(user.id, membership["practice_id"] if membership else None,
                                         (reason or "").strip()[:500] or None)
        return self.recovery_view(user.id) or {}

    def recovery_queue(self) -> list[dict]:
        return self.store.fetch_all(
            "SELECT id, user_id, practice_id, reason, status, created_at FROM mfa_recovery_requests "
            "WHERE status = 'open' ORDER BY created_at")

    def decide_recovery(self, operator: AuthenticatedUser, request_id: str, decision: str, note: str | None) -> dict:
        text = (note or "").strip()
        if not text:
            raise PilotError("note_required", "Record how the member's identity was checked", 422)
        row = self.store.fetch_one("SELECT * FROM mfa_recovery_requests WHERE id = ?", (request_id,))
        if not row or row["status"] != "open":
            raise PilotError("request_unavailable", "This recovery request is not open", 404)
        if row["user_id"] == operator.id:
            raise PilotError("self_decision_forbidden", "You can't reset your own two-step sign-in", 403)
        decided = self.store.decide_recovery_request(
            request_id, "completed" if decision == "complete" else "declined", f"user:{operator.id}", text[:500])
        return {"id": request_id, "status": (decided or {}).get("status"),
                # The authenticator itself lives in Supabase: the operator removes it there.
                "next": "Remove the member's authenticator in the Supabase dashboard (Authentication → Users → "
                        "the member → MFA factors). Their sessions are already signed out; at their next sign-in "
                        "they set up a new authenticator."
                if decision == "complete" else None}

    # ---------------------------------------------- new-practice (access) invitations

    def create_access_invitation(self, operator: AuthenticatedUser, email: str, npi: str, note: str | None) -> dict:
        address = valid_email(email)
        digits = "".join(ch for ch in npi if ch.isdigit())
        if len(digits) != 10:
            raise PilotError("invalid_npi", "Enter the physician's 10-digit NPI", 422)
        invitation, token = self.store.create_access_invitation(
            email=address, npi=digits, note=(note or "").strip()[:300] or None, actor=f"user:{operator.id}")
        return {**self._access_view(invitation), "token": token}  # the token is returned this once

    def access_invitations(self) -> list[dict]:
        return [self._access_view(row) for row in self.store.fetch_all(
            "SELECT * FROM pilot_access_invitations ORDER BY created_at DESC")]

    def revoke_access_invitation(self, operator: AuthenticatedUser, invitation_id: str) -> None:
        if not self.store.revoke_access_invitation(invitation_id, f"user:{operator.id}"):
            raise PilotError("invitation_unavailable", "This invitation is no longer pending", 404)

    @staticmethod
    def _access_view(row: dict) -> dict:
        now = now_iso()
        state = ("approved" if row["approved_at"] else "accepted" if row["accepted_at"] else
                 "revoked" if row["revoked_at"] else "expired" if row["expires_at"] <= now else "pending")
        return {"id": row["id"], "email": row["email"], "npi": row["npi"], "note": row["note"], "state": state,
                "created_at": row["created_at"], "expires_at": row["expires_at"], "ttl_days": INVITATION_TTL_DAYS}
