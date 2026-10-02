from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import (
    AuthenticatedUser,
    optional_authenticated_user,
    require_authenticated_user,
)

from .models import (
    AgentPreferencesInput,
    PhysicianNetworkProfile,
    ProviderClaim,
    ProviderClaimState,
    ProviderSearchResponse,
)
from .service import (
    AgentTransitionError,
    ClaimConflictError,
    ClaimNotFoundError,
    DemoVerificationDisabledError,
    DemoVerificationForbiddenError,
    ProviderNetwork,
    ProviderNotFoundError,
)

router = APIRouter(prefix="/api", tags=["physician-network"])
provider_network = ProviderNetwork()
OptionalUser = Annotated[AuthenticatedUser | None, Depends(optional_authenticated_user)]
RequiredUser = Annotated[AuthenticatedUser, Depends(require_authenticated_user)]


def _run(action):
    try:
        return action()
    except ProviderNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ClaimNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (DemoVerificationForbiddenError, DemoVerificationDisabledError) as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except (AgentTransitionError, ClaimConflictError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/providers/search", response_model=ProviderSearchResponse)
def search_providers(
    user: OptionalUser,
    q: Annotated[str, Query(max_length=120)] = "",
    specialty: Annotated[str, Query(max_length=80)] = "",
    location: Annotated[str, Query(max_length=80)] = "",
    limit: Annotated[int, Query(ge=1, le=40)] = 20,
) -> ProviderSearchResponse:
    return provider_network.search(
        q, specialty, location, limit, auth_user_id=user.id if user else None
    )


@router.get("/providers/{npi}", response_model=PhysicianNetworkProfile)
def get_provider(
    npi: str,
    user: OptionalUser,
) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.get(npi, user.id if user else None))


@router.get("/providers/{npi}/claim-state", response_model=ProviderClaimState)
def provider_claim_state(
    npi: str,
    user: OptionalUser,
) -> ProviderClaimState:
    return _run(lambda: provider_network.claim_state(npi, user.id if user else None))


@router.post("/providers/{npi}/claim", response_model=ProviderClaim)
def claim_provider(
    npi: str,
    user: RequiredUser,
) -> ProviderClaim:
    return _run(lambda: provider_network.claim(npi, user.id))


@router.get("/me/provider-claims", response_model=list[ProviderClaim])
def my_provider_claims(
    user: RequiredUser,
) -> list[ProviderClaim]:
    return provider_network.claims_for_user(user.id)


@router.post(
    "/provider-claims/{claim_id}/submit-verification",
    response_model=ProviderClaim,
)
def submit_provider_verification(
    claim_id: int,
    user: RequiredUser,
) -> ProviderClaim:
    return _run(lambda: provider_network.submit_verification(claim_id, user.id))


@router.post("/provider-claims/{claim_id}/verify-demo", response_model=ProviderClaim)
def verify_demo_provider(
    claim_id: int,
    user: RequiredUser,
) -> ProviderClaim:
    return _run(lambda: provider_network.verify_demo(claim_id, user.id))


@router.put("/providers/{npi}/preferences", response_model=PhysicianNetworkProfile)
def configure_provider(
    npi: str,
    preferences: AgentPreferencesInput,
    user: RequiredUser,
) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.configure(npi, user.id, preferences))


@router.post(
    "/provider-claims/{claim_id}/activate-agent",
    response_model=PhysicianNetworkProfile,
)
def activate_provider_agent(
    claim_id: int,
    user: RequiredUser,
) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.activate(claim_id, user.id))


@router.post(
    "/provider-claims/{claim_id}/disable-agent",
    response_model=PhysicianNetworkProfile,
)
def disable_provider_agent(
    claim_id: int,
    user: RequiredUser,
) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.disable(claim_id, user.id))

