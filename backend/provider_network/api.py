from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from .models import AgentPreferencesInput, PhysicianNetworkProfile, ProviderSearchResponse
from .service import (
    AgentTransitionError,
    DemoVerificationForbiddenError,
    ProviderNetwork,
    ProviderNotFoundError,
)

router = APIRouter(prefix="/api/providers", tags=["physician-network"])
provider_network = ProviderNetwork()


def _run(action):
    try:
        return action()
    except ProviderNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except DemoVerificationForbiddenError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except AgentTransitionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/search", response_model=ProviderSearchResponse)
def search_providers(
    q: Annotated[str, Query(max_length=120)] = "",
    specialty: Annotated[str, Query(max_length=80)] = "",
    location: Annotated[str, Query(max_length=80)] = "",
    limit: Annotated[int, Query(ge=1, le=40)] = 20,
) -> ProviderSearchResponse:
    return provider_network.search(q, specialty, location, limit)


@router.get("/{npi}", response_model=PhysicianNetworkProfile)
def get_provider(npi: str) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.get(npi))


@router.post("/{npi}/claim", response_model=PhysicianNetworkProfile)
def claim_provider(npi: str) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.claim(npi))


@router.post("/{npi}/verify-demo", response_model=PhysicianNetworkProfile)
def verify_demo_provider(npi: str) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.verify_demo(npi))


@router.put("/{npi}/preferences", response_model=PhysicianNetworkProfile)
def configure_provider(
    npi: str, preferences: AgentPreferencesInput
) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.configure(npi, preferences))


@router.post("/{npi}/activate", response_model=PhysicianNetworkProfile)
def activate_provider(npi: str) -> PhysicianNetworkProfile:
    return _run(lambda: provider_network.activate(npi))

