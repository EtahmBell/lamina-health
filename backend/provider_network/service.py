from __future__ import annotations

from dataclasses import dataclass
from threading import RLock

from backend.synthetic_data import PHYSICIANS

from .directory import NppesDirectory
from .models import (
    AgentPreferences,
    AgentPreferencesInput,
    AgentStatus,
    PhysicianNetworkProfile,
    ProviderSearchResponse,
    ProviderSource,
    ReservedAgentIdentity,
)


class ProviderNotFoundError(LookupError):
    pass


class AgentTransitionError(ValueError):
    pass


class DemoVerificationForbiddenError(PermissionError):
    pass


@dataclass
class AgentOverlay:
    status: AgentStatus = AgentStatus.RESERVED
    practice_confirmed: bool = False
    preferences: AgentPreferences | None = None


SYNTHETIC_NPIS = {
    "physician-jung": "9900000001",
    "physician-onadeko": "9900000002",
    "physician-patel": "9900000003",
    "physician-rossi": "9900000004",
    "physician-chen": "9900000005",
}


def _synthetic_profiles() -> list[PhysicianNetworkProfile]:
    profiles: list[PhysicianNetworkProfile] = []
    for physician in PHYSICIANS:
        city, state = physician.location.rsplit(", ", 1)
        npi = SYNTHETIC_NPIS[physician.id]
        profiles.append(
            PhysicianNetworkProfile(
                npi=npi,
                display_name=physician.name.replace(" (synthetic)", ""),
                specialty=physician.specialty,
                organization="Lamina synthetic specialty network",
                city=city,
                state=state,
                source=ProviderSource.SYNTHETIC,
                agent=ReservedAgentIdentity(id=f"agent-{npi}", status=AgentStatus.RESERVED),
                consult_eligible=True,
                consult_physician_id=physician.id,
                directory_disclaimer=(
                    "Synthetic physician identity and practice footprint for the Lamina demo."
                ),
            )
        )
    return profiles


class ProviderNetwork:
    def __init__(self, directory: NppesDirectory | None = None) -> None:
        self.directory = directory or NppesDirectory()
        self.synthetic = {profile.npi: profile for profile in _synthetic_profiles()}
        self._overlays: dict[str, AgentOverlay] = {}
        self._lock = RLock()

    def reset_demo_state(self) -> None:
        with self._lock:
            self._overlays.clear()

    def search(
        self, query: str = "", specialty: str = "", location: str = "", limit: int = 20
    ) -> ProviderSearchResponse:
        terms = " ".join(value.strip() for value in (query, specialty, location) if value.strip())
        normalized = terms.casefold()
        synthetic: list[PhysicianNetworkProfile] = []
        for profile in self.synthetic.values():
            searchable = (
                f"{profile.display_name} {profile.specialty} {profile.city} {profile.state}"
            ).casefold()
            if (
                not normalized
                or normalized in searchable
                or all(token in searchable for token in normalized.split())
            ):
                synthetic.append(self._with_overlay(profile))
        remaining = max(0, limit - len(synthetic))
        nppes = [self._with_overlay(profile) for profile in self.directory.search(terms, remaining)]
        results = (synthetic + nppes)[:limit]
        return ProviderSearchResponse(
            results=results,
            count=len(results),
            directory_available=self.directory.available,
            directory_records=self.directory.count(),
            data_mode="read_only_nppes_with_synthetic_demo",
        )

    def get(self, npi: str) -> PhysicianNetworkProfile:
        profile = self.synthetic.get(npi) or self.directory.get(npi)
        if not profile:
            raise ProviderNotFoundError("Physician profile not found")
        return self._with_overlay(profile)

    def claim(self, npi: str) -> PhysicianNetworkProfile:
        profile = self.get(npi)
        with self._lock:
            overlay = self._overlays.setdefault(npi, AgentOverlay(status=profile.agent.status))
            if overlay.status == AgentStatus.RESERVED:
                overlay.status = AgentStatus.VERIFICATION_PENDING
            elif overlay.status != AgentStatus.VERIFICATION_PENDING:
                raise AgentTransitionError("Only a reserved profile can begin verification")
        return self.get(npi)

    def verify_demo(self, npi: str) -> PhysicianNetworkProfile:
        profile = self.get(npi)
        if profile.source != ProviderSource.SYNTHETIC:
            raise DemoVerificationForbiddenError(
                "NPPES profiles require production identity verification; demo verification is synthetic only"
            )
        with self._lock:
            overlay = self._overlays.setdefault(npi, AgentOverlay(status=profile.agent.status))
            if overlay.status == AgentStatus.VERIFIED:
                return self.get(npi)
            if overlay.status != AgentStatus.VERIFICATION_PENDING:
                raise AgentTransitionError("Claim the reserved profile before demo verification")
            overlay.status = AgentStatus.VERIFIED
        return self.get(npi)

    def configure(self, npi: str, request: AgentPreferencesInput) -> PhysicianNetworkProfile:
        profile = self.get(npi)
        if profile.source != ProviderSource.SYNTHETIC:
            raise DemoVerificationForbiddenError(
                "Demo agent configuration is limited to synthetic physician profiles"
            )
        with self._lock:
            overlay = self._overlays.setdefault(npi, AgentOverlay(status=profile.agent.status))
            if overlay.status not in {AgentStatus.VERIFIED, AgentStatus.ACTIVE}:
                raise AgentTransitionError("Verify the physician identity before configuring the agent")
            overlay.practice_confirmed = request.practice_confirmed
            overlay.preferences = AgentPreferences.model_validate(
                request.model_dump(exclude={"practice_confirmed"})
            )
        return self.get(npi)

    def activate(self, npi: str) -> PhysicianNetworkProfile:
        profile = self.get(npi)
        if profile.source != ProviderSource.SYNTHETIC:
            raise DemoVerificationForbiddenError(
                "NPPES profiles cannot be activated through the synthetic demo workflow"
            )
        with self._lock:
            overlay = self._overlays.setdefault(npi, AgentOverlay(status=profile.agent.status))
            if overlay.status == AgentStatus.ACTIVE:
                return self.get(npi)
            if overlay.status != AgentStatus.VERIFIED:
                raise AgentTransitionError("Verify the physician identity before activation")
            if not overlay.practice_confirmed or not overlay.preferences:
                raise AgentTransitionError("Confirm practice information and save preferences first")
            if not overlay.preferences.areas_of_focus:
                raise AgentTransitionError("Add at least one area of focus before activation")
            overlay.status = AgentStatus.ACTIVE
        return self.get(npi)

    def _with_overlay(self, profile: PhysicianNetworkProfile) -> PhysicianNetworkProfile:
        with self._lock:
            overlay = self._overlays.get(profile.npi)
            if not overlay:
                return profile.model_copy(deep=True)
            return profile.model_copy(
                update={
                    "agent": ReservedAgentIdentity(
                        id=profile.agent.id,
                        status=overlay.status,
                        practice_confirmed=overlay.practice_confirmed,
                        preferences=overlay.preferences,
                    )
                },
                deep=True,
            )
