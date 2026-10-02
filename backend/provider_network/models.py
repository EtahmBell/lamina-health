from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentStatus(StrEnum):
    RESERVED = "reserved"
    CLAIMED = "claimed"
    VERIFICATION_PENDING = "verification_pending"
    VERIFIED = "verified"
    ACTIVE = "active"
    DISABLED = "disabled"


class ProviderSource(StrEnum):
    NPPES = "NPPES"
    SYNTHETIC = "SYNTHETIC"


class ClaimStatus(StrEnum):
    CLAIMED = "claimed"
    VERIFICATION_PENDING = "verification_pending"
    VERIFIED = "verified"
    REJECTED = "rejected"
    REVOKED = "revoked"


class AgentPreferences(StrictModel):
    areas_of_focus: list[str] = Field(default_factory=list, max_length=12)
    cases_accepted: list[str] = Field(default_factory=list, max_length=12)
    cases_redirected: list[str] = Field(default_factory=list, max_length=12)
    preferred_pre_referral_workup: list[str] = Field(default_factory=list, max_length=12)
    notes: str = Field(default="", max_length=500)

    @field_validator(
        "areas_of_focus",
        "cases_accepted",
        "cases_redirected",
        "preferred_pre_referral_workup",
    )
    @classmethod
    def normalize_lists(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            clean = " ".join(value.split())
            if clean and clean.casefold() not in seen:
                seen.add(clean.casefold())
                normalized.append(clean)
        return normalized


class AgentPreferencesInput(AgentPreferences):
    practice_confirmed: bool


class ReservedAgentIdentity(StrictModel):
    id: str
    status: AgentStatus
    practice_confirmed: bool = False
    preferences: AgentPreferences | None = None


class PhysicianNetworkProfile(StrictModel):
    npi: str
    display_name: str
    specialty: str
    taxonomy_code: str | None = None
    organization: str | None = None
    city: str
    state: str
    phone: str | None = None
    source: ProviderSource
    agent: ReservedAgentIdentity
    consult_eligible: bool = False
    consult_physician_id: str | None = None
    directory_disclaimer: str
    synthetic: bool = False
    lifecycle_status: AgentStatus = AgentStatus.RESERVED
    claimable: bool = True
    agent_active: bool = False
    claimed_by_me: bool = False
    my_claim_id: int | None = None
    my_claim_status: ClaimStatus | None = None


class ProviderClaim(StrictModel):
    id: int
    npi: str
    status: ClaimStatus
    claimed_at: str
    verification_submitted_at: str | None = None
    verified_at: str | None = None
    updated_at: str
    verification_method: str | None = None


class ProviderClaimState(StrictModel):
    npi: str
    synthetic: bool
    lifecycle_status: AgentStatus
    claimable: bool
    agent_active: bool
    claimed_by_me: bool = False
    my_claim_id: int | None = None
    my_claim_status: ClaimStatus | None = None


class ProviderSearchResponse(StrictModel):
    results: list[PhysicianNetworkProfile]
    count: int
    directory_available: bool
    directory_records: int
    data_mode: Literal["read_only_nppes_with_synthetic_demo"]

