"""Authenticated physician onboarding API and the internal pilot-approval API.

Every route derives the account solely from the verified bearer token. Request
bodies carry only the NPI the physician typed or saw; no route accepts a user
ID, owner-scope ID, physician ID, storage key, or approval state from a physician.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from backend.auth import AuthenticatedUser, require_authenticated_user
from backend.config import environment
from backend.physician_onboarding import OnboardingError, PhysicianOnboardingService
from backend.provider_network.identity import (
    IdentityLookupError,
    IdentityLookupRateLimitedError,
    IdentityLookupUnavailableError,
    IdentityNotFoundError,
)

router = APIRouter(prefix="/api/me/onboarding", tags=["physician-onboarding"])
internal_router = APIRouter(prefix="/api/internal/pilot-physicians", tags=["pilot-admin"])
onboarding_service = PhysicianOnboardingService()
RequiredUser = Annotated[AuthenticatedUser, Depends(require_authenticated_user)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NpiInput(_Strict):
    npi: str = Field(min_length=1, max_length=20)


class PilotDecisionInput(_Strict):
    note: str | None = Field(default=None, max_length=500)


def _detail(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _run(action):
    try:
        return action()
    except OnboardingError as error:
        raise HTTPException(error.status_code, _detail(error.code, error.message)) from error
    except IdentityLookupRateLimitedError as error:
        raise HTTPException(429, _detail(error.code, str(error))) from error
    except IdentityLookupUnavailableError as error:
        raise HTTPException(503, _detail(error.code, str(error))) from error
    except IdentityNotFoundError as error:
        raise HTTPException(404, _detail(error.code, str(error))) from error
    except IdentityLookupError as error:  # invalid, synthetic, not eligible
        raise HTTPException(422, _detail(error.code, str(error))) from error


@router.get("/status")
def onboarding_status(user: RequiredUser) -> dict:
    return _run(lambda: onboarding_service.status(user.id))


@router.post("/npi/lookup")
def lookup_npi(update: NpiInput, user: RequiredUser) -> dict:
    return _run(lambda: onboarding_service.lookup(user.id, update.npi))


class NameSearchInput(_Strict):
    name: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=120)
    specialty: str = Field(default="", max_length=120)


@router.post("/npi/search")
def search_by_name(update: NameSearchInput, user: RequiredUser) -> dict:
    return _run(
        lambda: onboarding_service.search(user.id, update.name, update.location, update.specialty)
    )


def _record_profile_claim(user_id: str, before: str, after: dict) -> None:
    """Pilot analytics: one `physician_claimed_profile` event per real confirmation."""
    if before == after.get("status") or after.get("status") not in {
        "pilot_approval_pending", "active",
    }:
        return
    from backend.pilot.store import pilot_store_for

    scope = onboarding_service.store.selected_physician_owner_scope(user_id)
    pilot_store_for(onboarding_service.store).append_event(
        "physician_claimed_profile",
        actor=f"user:{user_id}",
        owner_scope_id=scope["id"] if scope else None,
        metadata={"verification_method": "nppes_match_self_attested"},
    )


@router.delete("/selection")
def clear_selection(user: RequiredUser) -> dict:
    return _run(lambda: onboarding_service.clear_selection(user.id))


@router.post("/identity/confirm")
def confirm_identity(update: NpiInput, user: RequiredUser) -> dict:
    before = _run(lambda: onboarding_service.status(user.id))["status"]
    result = _run(lambda: onboarding_service.confirm(user.id, update.npi))
    _record_profile_claim(user.id, before, result)
    return result


# ------------------------------------------------------------------ internal


def pilot_admin_user_ids() -> frozenset[str]:
    raw = environment.get("LAMINA_PILOT_ADMIN_USER_IDS", "")
    return frozenset(value.strip() for value in raw.split(",") if value.strip())


def require_pilot_admin(user: RequiredUser) -> AuthenticatedUser:
    """Allow-listed Supabase accounts only. Everyone else sees a non-disclosing 404."""
    if user.id not in pilot_admin_user_ids():
        raise HTTPException(404, "Not Found")
    return user


PilotAdmin = Annotated[AuthenticatedUser, Depends(require_pilot_admin)]


@internal_router.get("")
def pilot_review_queue(
    admin: PilotAdmin,
    status: Annotated[
        Literal["pending", "approved", "rejected", "disabled"] | None, Query()
    ] = "pending",
) -> list[dict]:
    del admin
    return onboarding_service.review_queue(status)


@internal_router.post("/{scope_id}/{decision}")
def decide_pilot_physician(
    scope_id: str,
    decision: Literal["approve", "reject", "disable"],
    admin: PilotAdmin,
    update: PilotDecisionInput | None = None,
) -> dict:
    note = update.note if update else None
    return _run(
        lambda: onboarding_service.decide(scope_id, decision, f"user:{admin.id}", note)
    )
