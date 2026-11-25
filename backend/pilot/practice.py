"""Practice setup, membership, invitations, and the single pilot access guard.

Roles (deliberately small, not an RBAC system):
* physician -- full pilot workspace access; manages practice, staff, and rules.
* staff     -- referral intake and triage review. Cannot edit physician identity,
               practice rules, membership, or make the final accept/redirect/decline
               disposition.

Access policy (preserves the existing manual pilot gate): a practice opens only
when one of its physician members holds a confirmed identity whose owner scope
Lamina has approved. Staff inherit that gate; they never bypass it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .store import PilotStore

_ACTIVE_CLAIM_STATUSES = {"claimed", "verification_pending", "verified"}
SIGN_IN_EVENT_WINDOW = timedelta(minutes=30)


class PilotError(Exception):
    status_code = 409

    def __init__(self, code: str, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        if status_code is not None:
            self.status_code = status_code


@dataclass(frozen=True)
class PracticeContext:
    user_id: str
    practice: dict
    member: dict
    role: str
    owner_scope_id: str | None
    # Set for non-user actors (e.g. "public:sender:<link>") acting on a practice's behalf.
    actor_label: str | None = None

    @property
    def practice_id(self) -> str:
        return self.practice["id"]

    @property
    def actor(self) -> str:
        return self.actor_label or f"user:{self.user_id}"

    @property
    def is_admin(self) -> bool:
        """Practice admin: membership and practice settings. Not a clinical authority."""
        return self.role == "physician" and bool(self.member.get("is_admin"))

    def require_admin(self, action: str) -> None:
        if not self.is_admin:
            raise PilotError("practice_admin_required", f"Only a practice admin can {action}", 403)

    def require_physician(self, action: str) -> None:
        if self.role != "physician":
            raise PilotError(
                "physician_required", f"Only a physician in this practice can {action}", 403
            )


class PracticeService:
    def __init__(self, store: PilotStore) -> None:
        self.store = store
        self.workflow = store.workflow

    # --------------------------------------------------------- physician state

    def _confirmed_physician_scope(self, user_id: str) -> dict | None:
        """The account's own confirmed physician owner scope, or None."""
        scope = self.workflow.selected_physician_owner_scope(user_id)
        if not scope:
            return None
        claim = self.workflow.provider_claim(scope["provider_claim_id"])
        if (
            not claim
            or claim["auth_user_id"] != user_id
            or claim["status"] not in _ACTIVE_CLAIM_STATUSES
            or not claim.get("identity_confirmed_at")
        ):
            return None
        return scope

    def _scope_approved(self, scope_id: str | None) -> bool:
        if not scope_id:
            return False
        scope = self.workflow.physician_owner_scope(scope_id)
        if not scope or scope.get("pilot_access_status") != "approved":
            return False
        claim = self.workflow.provider_claim(scope["provider_claim_id"])
        return bool(
            claim
            and claim["status"] in _ACTIVE_CLAIM_STATUSES
            and claim.get("identity_confirmed_at")
        )

    def practice_approved(self, practice_id: str) -> bool:
        return any(self._scope_approved(scope_id) for scope_id in self.store.physician_scope_ids(practice_id))

    # ------------------------------------------------------------------ access

    def context(self, user_id: str) -> PracticeContext:
        membership = self.store.membership_for_user(user_id)
        if not membership:
            raise PilotError("practice_required", "Set up or join a practice first", 409)
        practice = self.store.practice(membership["practice_id"])
        if not practice or practice["status"] != "active":
            raise PilotError("practice_unavailable", "This practice is not active", 403)
        if membership["role"] == "physician":
            if not self._scope_approved(membership["physician_owner_scope_id"]):
                raise PilotError(
                    "pilot_access_pending",
                    "Your physician profile is awaiting Lamina pilot approval",
                    403,
                )
        elif not self.practice_approved(practice["id"]):
            raise PilotError(
                "practice_not_approved",
                "This practice is awaiting Lamina pilot approval",
                403,
            )
        return PracticeContext(
            user_id=user_id,
            practice=practice,
            member=membership,
            role=membership["role"],
            owner_scope_id=membership["physician_owner_scope_id"],
        )

    def record_sign_in(self, user_id: str, role: str | None, practice_id: str | None) -> None:
        """At most one sign-in event per account per window (status is polled)."""
        actor = f"user:{user_id}"
        event_type = "staff_signed_in" if role == "staff" else "physician_signed_in"
        last = self.store.last_event_at(actor, event_type)
        if last and datetime.now(UTC) - datetime.fromisoformat(last) < SIGN_IN_EVENT_WINDOW:
            return
        self.store.append_event(event_type, actor=actor, practice_id=practice_id)

    # ------------------------------------------------------------------ status

    def complete_pending_access(self, user_id: str) -> None:
        """Idempotent follow-through once the account has confirmed its own physician identity:
        * an accepted physician invitation becomes a (non-admin) physician membership;
        * an accepted operator invitation for a new practice pre-approves pilot access, but only
          for the NPI the operator named."""
        scope = self._confirmed_physician_scope(user_id)
        if not scope or self.store.membership_for_user(user_id):
            return
        invitation = self.store.pending_physician_invitation(user_id)
        if invitation:
            self.store.complete_physician_join(invitation, user_id, scope["id"])
            return
        access = self.store.fetch_one(
            "SELECT * FROM pilot_access_invitations WHERE accepted_by_user_id = ? AND approved_at IS NULL "
            "AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT 1", (user_id,))
        if access and access["npi"] == scope["npi"] and scope.get("pilot_access_status") == "pending":
            self.workflow.decide_pilot_access(scope["id"], "approve", f"invitation:{access['id']}",
                                              "Pre-approved by a Lamina invitation for this NPI")
            self.store.execute(
                [("UPDATE pilot_access_invitations SET approved_at = ? WHERE id = ? AND approved_at IS NULL",
                  (datetime.now(UTC).isoformat(timespec="seconds"), access["id"]))],
                [{"event_type": "pilot_access_approved_by_invitation", "actor": f"invitation:{access['id']}",
                  "autonomy": "automatic", "metadata": {"invitation_id": access["id"], "owner_scope_id": scope["id"]}}])

    def status(self, user_id: str, physician_onboarding: dict[str, Any], *, mfa_verified: bool = True,
               recovery: dict | None = None) -> dict[str, Any]:
        """One projection the frontend routes on. Never trusts client state.

        next_step: mfa | physician_onboarding | practice_setup | pilot_pending | practice_pending |
                   workspace | access_ended | unavailable
        """
        if not mfa_verified:
            # Nothing about the practice is shown until two-step sign-in is done.
            return {"next_step": "mfa", "role": None, "is_admin": False, "practice": None, "physician_name": None,
                    "physician_onboarding": {"status": physician_onboarding.get("status")},
                    "practice_defaults": None, "invitation": None, "mfa_recovery": recovery}
        self.complete_pending_access(user_id)
        membership = self.store.membership_for_user(user_id)
        practice = self.store.practice(membership["practice_id"]) if membership else None
        role = membership["role"] if membership else None
        onboarding_status = physician_onboarding.get("status")
        pending_join = None if membership else self.store.pending_physician_invitation(user_id)
        removed = None if membership or pending_join else self.store.removed_membership(user_id)

        if membership and practice:
            if role == "physician":
                approved = self._scope_approved(membership["physician_owner_scope_id"])
                next_step = "workspace" if approved else (
                    "unavailable" if onboarding_status in {"rejected", "disabled"} else "pilot_pending"
                )
            else:
                next_step = "workspace" if self.practice_approved(practice["id"]) else "practice_pending"
            if practice["status"] != "active":
                next_step = "unavailable"
        elif removed:
            # A deactivated member: access ended. They can't start over on their own (no new
            # practice, no identity claim); a new invitation is the way back.
            next_step = "access_ended"
        elif pending_join:
            next_step = "physician_onboarding"  # confirm your own NPI, then you join
        elif onboarding_status in {"rejected", "disabled"}:
            next_step = "unavailable"
        elif onboarding_status == "active":
            next_step = "practice_setup"  # an operator-approved request (or invitation)
        elif onboarding_status == "pilot_approval_pending":
            next_step = "pilot_pending"  # the request is with the Lamina team; no practice yet
        else:
            next_step = "physician_onboarding"

        if next_step == "workspace":
            self.record_sign_in(user_id, role, practice["id"] if practice else None)

        invited_to = self.store.practice(pending_join["practice_id"]) if pending_join else None
        ended_at = self.store.practice(removed["practice_id"]) if removed else None
        return {
            "next_step": next_step,
            "role": role,
            "is_admin": bool(membership and membership["role"] == "physician" and membership.get("is_admin")),
            "practice": self._practice_view(practice) if practice else None,
            # Whose agent this is ("Dr. X"), so staff copy can name the physician.
            "physician_name": self._physician_name(practice["id"]) if practice else None,
            "physician_onboarding": physician_onboarding,
            "practice_defaults": (
                self._practice_defaults(user_id) if next_step == "practice_setup" else None
            ),
            # Joining a practice as a physician: confirm your own identity first.
            "invitation": {"practice_name": invited_to["name"], "role": "physician"} if invited_to else None,
            "access_ended": {"practice_name": ended_at["name"] if ended_at else None, "at": removed["updated_at"]}
            if removed else None,
            "mfa_recovery": recovery,
        }

    @staticmethod
    def _practice_view(practice: dict) -> dict:
        return {
            key: practice.get(key)
            for key in (
                "id", "name", "specialty", "website", "address", "phone", "contact_email",
                "status", "created_at", "idle_timeout_minutes",
            )
        }

    def _practice_defaults(self, user_id: str) -> dict | None:
        """Prefill from the physician's own NPPES record; the physician confirms or edits."""
        scope = self._confirmed_physician_scope(user_id)
        if not scope:
            return None
        snapshot = scope.get("nppes_snapshot") or {}
        identity = scope.get("provider_identity") or {}
        location = (snapshot.get("practice_locations") or [{}])[0] or {}
        address = ", ".join(
            part for part in (
                location.get("address_line"),
                location.get("city"),
                " ".join(filter(None, [location.get("state"), location.get("postal_code")])),
            ) if part
        )
        last_name = snapshot.get("last_name") or ""
        return {
            "name": f"{last_name.title()} {snapshot.get('primary_specialty') or 'Specialty'} Practice".strip()
            if last_name else "",
            "specialty": snapshot.get("primary_specialty") or identity.get("specialty"),
            "address": address or None,
            "phone": location.get("phone") or identity.get("phone"),
            "source": "NPPES public registry — confirm or edit before saving",
        }

    # --------------------------------------------------------------- practices

    def create_practice(self, user_id: str, fields: dict[str, Any]) -> dict:
        if self.store.membership_for_user(user_id):
            raise PilotError("already_in_practice", "This account already belongs to a practice")
        scope = self._confirmed_physician_scope(user_id)
        if not scope:
            raise PilotError(
                "physician_profile_required",
                "Confirm your professional profile before creating a practice",
            )
        if scope.get("pilot_access_status") in {"rejected", "disabled"}:
            raise PilotError("account_unavailable", "This account cannot create a practice", 403)
        # Invite-only: a new practice needs an operator-approved request or an operator invitation
        # (which approves on identity confirmation). No open self-service practice creation.
        if scope.get("pilot_access_status") != "approved":
            raise PilotError("pilot_access_pending",
                             "The Lamina team reviews each new practice first. You can set it up once your "
                             "request is approved", 403)
        if self.store.removed_membership(user_id) or self.store.pending_physician_invitation(user_id):
            raise PilotError("practice_creation_unavailable",
                             "This account can't start a new practice. Ask the Lamina team", 403)
        cleaned = {key: (value.strip() if isinstance(value, str) else value) for key, value in fields.items()}
        cleaned = {key: (value or None) for key, value in cleaned.items()}
        if not cleaned.get("name"):
            raise PilotError("invalid_practice", "Practice name is required", 422)
        practice, _ = self.store.create_practice(
            user_id=user_id, owner_scope_id=scope["id"], fields=cleaned
        )
        return practice

    def update_practice(self, context: PracticeContext, fields: dict[str, Any]) -> dict:
        context.require_admin("edit practice information")
        cleaned = {key: (value.strip() if isinstance(value, str) else value) or None for key, value in fields.items()}
        if not cleaned.get("name"):
            raise PilotError("invalid_practice", "Practice name is required", 422)
        return self._practice_view(self.store.update_practice(context.practice_id, cleaned, context.actor))

    IDLE_TIMEOUT_RANGE = (15, 60)

    def set_idle_timeout(self, context: PracticeContext, minutes: int) -> dict:
        """Admin: how long the practice's sessions may sit idle before signing out (15-60 min)."""
        context.require_admin("change the practice's session settings")
        low, high = self.IDLE_TIMEOUT_RANGE
        if not low <= minutes <= high:
            raise PilotError("invalid_idle_timeout", f"Choose between {low} and {high} minutes", 422)
        before = int(context.practice.get("idle_timeout_minutes") or 30)
        if minutes != before:
            self.store.execute(
                [("UPDATE practices SET idle_timeout_minutes = ?, updated_at = ? WHERE id = ?",
                  (minutes, datetime.now(UTC).isoformat(timespec="seconds"), context.practice_id))],
                [{"event_type": "practice_idle_timeout_changed", "actor": context.actor, "practice_id": context.practice_id,
                  "metadata": {"from": before, "to": minutes}}])
        return self._practice_view(self.store.practice(context.practice_id))

    # ---------------------------------------------------------------- members

    def _physician_name(self, practice_id: str) -> str | None:
        from .attribution import ActorDirectory

        scopes = self.store.physician_scope_ids(practice_id)
        return ActorDirectory(self.store, practice_id).physician_name(scopes[0]) if len(scopes) == 1 else None

    def members_view(self, context: PracticeContext) -> dict:
        members = []
        for member in self.store.members(context.practice_id):
            identity = None
            if member["physician_owner_scope_id"]:
                scope = self.workflow.physician_owner_scope(member["physician_owner_scope_id"])
                identity = (scope or {}).get("provider_identity")
            members.append({
                "id": member["id"],
                "role": member["role"],
                "label": member["label"] or (identity or {}).get("display_name"),
                "is_you": member["user_id"] == context.user_id,
                "is_admin": bool(member.get("is_admin")),
                "joined_at": member["created_at"],
            })
        from .attribution import ActorDirectory

        invitations = []
        if context.is_admin:
            directory = ActorDirectory(self.store, context.practice_id)
            now = datetime.now(UTC).isoformat(timespec="seconds")
            for invitation in self.store.invitations(context.practice_id):
                state = (
                    "accepted" if invitation["accepted_at"] else
                    "revoked" if invitation["revoked_at"] else
                    "expired" if invitation["expires_at"] <= now else "pending"
                )
                invitations.append({
                    "id": invitation["id"], "role": invitation["role"], "email": invitation.get("email"),
                    "label": invitation["label"], "state": state,
                    "created_at": invitation["created_at"], "expires_at": invitation["expires_at"],
                    "invited_by_name": directory.describe(invitation["created_by"])["name"],
                })
        admins = sum(1 for member in members if member["is_admin"])
        for member in members:
            # Who can be deactivated (admins only): never yourself, never the last admin.
            member["can_deactivate"] = context.is_admin and not member["is_you"] and not (member["is_admin"] and admins <= 1)
        return {"members": members, "invitations": invitations, "can_manage": context.is_admin}

    def invite(self, context: PracticeContext, role: str, email: str | None, label: str | None) -> dict:
        """An admin invites a staff member or another physician by email. The invitee signs up
        with their own account (no shared credentials); the invitation is bound to that email,
        expires after a week, and can be revoked until it is accepted."""
        from .accounts import valid_email

        context.require_admin("invite people to the practice")
        if role not in {"staff", "physician"}:
            raise PilotError("invalid_role", "Invite as staff or as a physician", 422)
        address = valid_email(email)
        invitation, token = self.store.create_invitation(
            context.practice_id, role=role, label=(label or "").strip() or None, email=address, actor=context.actor
        )
        return {
            "id": invitation["id"], "role": invitation["role"], "label": invitation["label"],
            "email": invitation["email"], "expires_at": invitation["expires_at"],
            # Returned exactly once; only its hash is stored.
            "token": token,
        }

    def revoke_invitation(self, context: PracticeContext, invitation_id: str) -> None:
        context.require_admin("revoke invitations")
        if not self.store.revoke_invitation(context.practice_id, invitation_id, context.actor):
            raise PilotError("invitation_unavailable", "This invitation is no longer pending", 404)

    def deactivate_member(self, context: PracticeContext, member_id: str) -> dict:
        """Admin: end a member's access now. Recorded; their past work keeps their name."""
        context.require_admin("deactivate members")
        result = self.store.deactivate_member(context.practice_id, member_id, context.actor)
        if result == "not_found":
            raise PilotError("member_not_found", "Member not found", 404)
        if result == "self":
            raise PilotError("cannot_deactivate_self", "You can't deactivate yourself. Ask another admin", 409)
        if result == "last_admin":
            raise PilotError("last_admin", "A practice needs at least one admin. Make someone else an admin first", 409)
        return self.members_view(context)

    def set_admin(self, context: PracticeContext, member_id: str, is_admin: bool) -> dict:
        context.require_admin("change who administers the practice")
        result = self.store.set_admin(context.practice_id, member_id, is_admin, context.actor)
        if result == "not_found":
            raise PilotError("member_not_found", "Member not found", 404)
        if result == "not_physician":
            # Gap (Step 17 follow-up): there is no non-physician admin role yet.
            raise PilotError("admin_requires_physician", "Only physicians can be practice admins for now", 422)
        if result == "last_admin":
            raise PilotError("last_admin", "A practice needs at least one admin. Make someone else an admin first", 409)
        return self.members_view(context)

    def _usable_invitation(self, token: str) -> tuple[str, dict]:
        """('practice', row) for a practice invitation, ('new_practice', row) for an operator
        invitation to set up a new practice. Invalid, expired, used and revoked look the same."""
        now = datetime.now(UTC).isoformat(timespec="seconds")
        for kind, row in (("practice", self.store.invitation_by_token(token) if token else None),
                          ("new_practice", self.store.access_invitation_by_token(token) if token else None)):
            if row and not row["accepted_at"] and not row["revoked_at"] and row["expires_at"] > now:
                if kind == "practice" and not row.get("email"):
                    break  # issued before email-bound invitations: not usable any more
                return kind, row
        raise PilotError(
            "invitation_unavailable",
            "This invitation link is invalid, expired, revoked, or already used. Ask for a new one",
            404,
        )

    @staticmethod
    def _require_email_match(row: dict, email: str | None) -> None:
        if not email or email != (row.get("email") or "").casefold():
            raise PilotError(
                "invitation_email_mismatch",
                "This invitation was sent to a different email address. Sign in with the address it "
                "was sent to, or ask for a new invitation",
                403,
            )

    def preview_invitation(self, token: str, email: str | None = None) -> dict:
        kind, invitation = self._usable_invitation(token)
        matches = bool(email) and email == (invitation.get("email") or "").casefold()
        if kind == "new_practice":
            return {"kind": kind, "practice_name": None, "practice_specialty": None, "role": "physician",
                    "expires_at": invitation["expires_at"], "email_matches": matches}
        practice = self.store.practice(invitation["practice_id"]) or {}
        return {
            "kind": kind,
            "practice_name": practice.get("name"),
            "practice_specialty": practice.get("specialty"),
            "role": invitation["role"],
            "expires_at": invitation["expires_at"],
            # Never the invited address itself: only whether the signed-in account matches it.
            "email_matches": matches,
        }

    def accept_invitation(self, user_id: str, token: str, email: str | None = None) -> dict | None:
        kind, invitation = self._usable_invitation(token)
        self._require_email_match(invitation, email)
        if self.store.membership_for_user(user_id):
            raise PilotError("already_in_practice", "This account already belongs to a practice")
        role = "physician" if kind == "new_practice" else invitation["role"]
        if role == "staff":
            if self._confirmed_physician_scope(user_id):
                raise PilotError(
                    "physician_account",
                    "This account holds a confirmed physician profile. Physicians join as physicians; "
                    "staff invitations are for staff accounts",
                )
            if self.store.pending_physician_invitation(user_id):
                raise PilotError("already_invited", "This account already accepted a physician invitation")
        elif self.store.has_staff_history(user_id):
            # A staff account can never become (or claim) a physician identity.
            raise PilotError("staff_account", "This is a staff account. Physicians use their own account", 403)
        try:
            if kind == "new_practice":
                if not self.store.accept_access_invitation(invitation, user_id):
                    raise ValueError("invitation_unavailable")
                self.complete_pending_access(user_id)
                return None
            membership = self.store.accept_invitation(invitation, user_id)
        except ValueError as error:
            raise PilotError(
                "invitation_unavailable", "This invitation is no longer available", 404
            ) from error
        if role == "physician":
            # Already a confirmed physician (no practice): join now. Otherwise after NPI confirmation.
            self.complete_pending_access(user_id)
        return membership
