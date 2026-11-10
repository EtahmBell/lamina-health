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

    def status(self, user_id: str, physician_onboarding: dict[str, Any]) -> dict[str, Any]:
        """One projection the frontend routes on. Never trusts client state.

        next_step: physician_onboarding | practice_setup | pilot_pending |
                   practice_pending | workspace | unavailable
        """
        membership = self.store.membership_for_user(user_id)
        practice = self.store.practice(membership["practice_id"]) if membership else None
        role = membership["role"] if membership else None
        onboarding_status = physician_onboarding.get("status")

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
        elif onboarding_status in {"rejected", "disabled"}:
            next_step = "unavailable"
        elif onboarding_status in {"pilot_approval_pending", "active"}:
            next_step = "practice_setup"
        else:
            next_step = "physician_onboarding"

        if next_step == "workspace":
            self.record_sign_in(user_id, role, practice["id"] if practice else None)

        return {
            "next_step": next_step,
            "role": role,
            "practice": self._practice_view(practice) if practice else None,
            "physician_onboarding": physician_onboarding,
            "practice_defaults": (
                self._practice_defaults(user_id) if next_step == "practice_setup" else None
            ),
        }

    @staticmethod
    def _practice_view(practice: dict) -> dict:
        return {
            key: practice.get(key)
            for key in (
                "id", "name", "specialty", "website", "address", "phone", "contact_email",
                "status", "created_at",
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
        cleaned = {key: (value.strip() if isinstance(value, str) else value) for key, value in fields.items()}
        cleaned = {key: (value or None) for key, value in cleaned.items()}
        if not cleaned.get("name"):
            raise PilotError("invalid_practice", "Practice name is required", 422)
        practice, _ = self.store.create_practice(
            user_id=user_id, owner_scope_id=scope["id"], fields=cleaned
        )
        return practice

    def update_practice(self, context: PracticeContext, fields: dict[str, Any]) -> dict:
        context.require_physician("edit practice information")
        cleaned = {key: (value.strip() if isinstance(value, str) else value) or None for key, value in fields.items()}
        if not cleaned.get("name"):
            raise PilotError("invalid_practice", "Practice name is required", 422)
        return self._practice_view(self.store.update_practice(context.practice_id, cleaned, context.actor))

    # ---------------------------------------------------------------- members

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
                "joined_at": member["created_at"],
            })
        invitations = []
        if context.role == "physician":
            now = datetime.now(UTC).isoformat(timespec="seconds")
            for invitation in self.store.invitations(context.practice_id):
                state = (
                    "accepted" if invitation["accepted_at"] else
                    "revoked" if invitation["revoked_at"] else
                    "expired" if invitation["expires_at"] <= now else "pending"
                )
                invitations.append({
                    "id": invitation["id"], "role": invitation["role"],
                    "label": invitation["label"], "state": state,
                    "created_at": invitation["created_at"], "expires_at": invitation["expires_at"],
                })
        return {"members": members, "invitations": invitations}

    def invite(self, context: PracticeContext, role: str, label: str | None) -> dict:
        context.require_physician("invite staff")
        invitation, token = self.store.create_invitation(
            context.practice_id, role=role, label=(label or "").strip() or None, actor=context.actor
        )
        return {
            "id": invitation["id"], "role": invitation["role"], "label": invitation["label"],
            "expires_at": invitation["expires_at"],
            # Returned exactly once; only its hash is stored.
            "token": token,
        }

    def revoke_invitation(self, context: PracticeContext, invitation_id: str) -> None:
        context.require_physician("revoke invitations")
        if not self.store.revoke_invitation(context.practice_id, invitation_id, context.actor):
            raise PilotError("invitation_unavailable", "This invitation is no longer pending", 404)

    def remove_member(self, context: PracticeContext, member_id: str) -> None:
        context.require_physician("remove staff")
        if not self.store.remove_member(context.practice_id, member_id, context.actor):
            raise PilotError("member_not_found", "Staff member not found", 404)

    def _usable_invitation(self, token: str) -> dict:
        invitation = self.store.invitation_by_token(token) if token else None
        now = datetime.now(UTC).isoformat(timespec="seconds")
        if (
            not invitation
            or invitation["accepted_at"]
            or invitation["revoked_at"]
            or invitation["expires_at"] <= now
        ):
            raise PilotError(
                "invitation_unavailable",
                "This invitation link is invalid, expired, or already used. Ask the practice "
                "for a new one",
                404,
            )
        return invitation

    def preview_invitation(self, token: str) -> dict:
        invitation = self._usable_invitation(token)
        practice = self.store.practice(invitation["practice_id"]) or {}
        return {
            "practice_name": practice.get("name"),
            "practice_specialty": practice.get("specialty"),
            "role": invitation["role"],
            "expires_at": invitation["expires_at"],
        }

    def accept_invitation(self, user_id: str, token: str) -> dict:
        invitation = self._usable_invitation(token)
        if self.store.membership_for_user(user_id):
            raise PilotError("already_in_practice", "This account already belongs to a practice")
        if self._confirmed_physician_scope(user_id):
            raise PilotError(
                "physician_account",
                "This account holds a confirmed physician profile. Physicians create their own "
                "practice; staff invitations are for staff accounts",
            )
        try:
            return self.store.accept_invitation(invitation, user_id)
        except ValueError as error:
            raise PilotError(
                "invitation_unavailable", "This invitation is no longer available", 404
            ) from error
