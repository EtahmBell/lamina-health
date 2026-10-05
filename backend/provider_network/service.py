from __future__ import annotations

from backend.config import environment
from backend.synthetic_data import ALL_PHYSICIANS, SYNTHETIC_PHYSICIAN_NPIS
from backend.workflow import WorkflowStore, workflow_store

from .directory import DirectoryUnavailableError, NppesDirectory
from .lifecycle import project_lifecycle
from .models import (
    AgentPreferences,
    AgentPreferencesInput,
    AgentStatus,
    ClaimStatus,
    PhysicianNetworkProfile,
    ProviderClaim,
    ProviderClaimState,
    ProviderSearchResponse,
    ProviderSource,
    ReservedAgentIdentity,
)


class ProviderNotFoundError(LookupError):
    pass


class ProviderDirectoryUnavailableError(RuntimeError):
    pass


class AgentTransitionError(ValueError):
    pass


class ClaimNotFoundError(LookupError):
    pass


class ClaimConflictError(ValueError):
    pass


class DemoVerificationForbiddenError(PermissionError):
    pass


class DemoVerificationDisabledError(PermissionError):
    pass


def _enabled(value: str) -> bool:
    return value.strip().casefold() in {"1", "true", "yes", "on"}


def _synthetic_profiles() -> list[PhysicianNetworkProfile]:
    profiles: list[PhysicianNetworkProfile] = []
    for physician in ALL_PHYSICIANS:
        city, state = physician.location.rsplit(", ", 1)
        npi = SYNTHETIC_PHYSICIAN_NPIS[physician.id]
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
                synthetic=True,
            )
        )
    return profiles


class ProviderNetwork:
    def __init__(
        self,
        directory: NppesDirectory | None = None,
        store: WorkflowStore | None = None,
        demo_verification_enabled: bool | None = None,
    ) -> None:
        self.directory = directory or NppesDirectory()
        self.store = store or workflow_store
        self.synthetic = {profile.npi: profile for profile in _synthetic_profiles()}
        self.demo_verification_enabled = (
            _enabled(environment.get("LAMINA_DEMO_VERIFICATION_ENABLED", "false"))
            if demo_verification_enabled is None
            else demo_verification_enabled
        )

    def _resolve(self, npi: str) -> PhysicianNetworkProfile:
        profile = self.synthetic.get(npi)
        if profile is None:
            try:
                profile = self.directory.get(npi)
            except DirectoryUnavailableError as error:
                raise ProviderDirectoryUnavailableError(
                    "The NPPES directory is temporarily unavailable"
                ) from error
        if not profile:
            raise ProviderNotFoundError("Physician profile not found")
        return profile

    @staticmethod
    def _public_claim(row: dict) -> ProviderClaim:
        return ProviderClaim.model_validate(
            {key: value for key, value in row.items() if key != "auth_user_id"}
        )

    def _owned_claim(self, claim_id: int, auth_user_id: str) -> dict:
        claim = self.store.provider_claim(claim_id)
        if not claim or claim["auth_user_id"] != auth_user_id:
            raise ClaimNotFoundError("Provider claim not found")
        return claim

    def search(
        self,
        query: str = "",
        specialty: str = "",
        location: str = "",
        limit: int = 20,
        auth_user_id: str | None = None,
    ) -> ProviderSearchResponse:
        normalized = " ".join(
            value.strip() for value in (query, specialty, location) if value.strip()
        ).casefold()
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
                synthetic.append(self._with_state(profile, auth_user_id))
        remaining = max(0, limit - len(synthetic))
        directory = self.directory.search_diagnostic(query, specialty, location, max(1, remaining))
        nppes = [
            self._with_state(profile, auth_user_id) for profile in directory.profiles[:remaining]
        ]
        results = (synthetic + nppes)[:limit]
        return ProviderSearchResponse(
            results=results,
            count=len(results),
            directory_available=directory.status.value not in {"unavailable"},
            directory_records=directory.total,
            directory_status=directory.status,
            directory_backend=directory.backend,
            directory_message=directory.message,
            data_mode="read_only_nppes_with_synthetic_demo",
        )

    def get(self, npi: str, auth_user_id: str | None = None) -> PhysicianNetworkProfile:
        return self._with_state(self._resolve(npi), auth_user_id)

    def claim_state(self, npi: str, auth_user_id: str | None = None) -> ProviderClaimState:
        profile = self.get(npi, auth_user_id)
        return ProviderClaimState(
            npi=profile.npi,
            synthetic=profile.synthetic,
            lifecycle_status=profile.lifecycle_status,
            claimable=profile.claimable,
            agent_active=profile.agent_active,
            claimed_by_me=profile.claimed_by_me,
            my_claim_id=profile.my_claim_id,
            my_claim_status=profile.my_claim_status,
        )

    def claim(self, npi: str, auth_user_id: str) -> ProviderClaim:
        self._resolve(npi)
        claim, conflict = self.store.claim_provider(auth_user_id, npi)
        if conflict:
            raise ClaimConflictError("Provider identity already has an active claim")
        return self._public_claim(claim)

    def claims_for_user(self, auth_user_id: str) -> list[ProviderClaim]:
        return [self._public_claim(row) for row in self.store.provider_claims(auth_user_id)]

    def submit_verification(self, claim_id: int, auth_user_id: str) -> ProviderClaim:
        self._owned_claim(claim_id, auth_user_id)
        try:
            claim = self.store.submit_provider_verification(claim_id, auth_user_id)
        except ValueError as error:
            raise AgentTransitionError(str(error)) from error
        if not claim:
            raise ClaimNotFoundError("Provider claim not found")
        return self._public_claim(claim)

    def verify_demo(self, claim_id: int, auth_user_id: str) -> ProviderClaim:
        claim = self._owned_claim(claim_id, auth_user_id)
        profile = self._resolve(claim["npi"])
        if profile.source != ProviderSource.SYNTHETIC:
            raise DemoVerificationForbiddenError(
                "Real NPPES identities require production physician verification"
            )
        if not self.demo_verification_enabled:
            raise DemoVerificationDisabledError("Synthetic demo verification is disabled")
        try:
            verified = self.store.verify_provider_claim(
                claim_id, auth_user_id, "synthetic_demo"
            )
        except ValueError as error:
            raise AgentTransitionError(str(error)) from error
        if not verified:
            raise ClaimNotFoundError("Provider claim not found")
        return self._public_claim(verified)

    def configure(
        self, npi: str, auth_user_id: str, request: AgentPreferencesInput
    ) -> PhysicianNetworkProfile:
        profile = self._resolve(npi)
        claim = self.store.active_provider_claim(npi)
        if not claim or claim["auth_user_id"] != auth_user_id:
            raise ClaimNotFoundError("Provider claim not found")
        if claim["status"] != ClaimStatus.VERIFIED:
            raise AgentTransitionError("Verify the physician identity before configuration")
        preferences = AgentPreferences.model_validate(
            request.model_dump(exclude={"practice_confirmed"})
        )
        self.store.save_provider_agent_preferences(
            npi,
            request.practice_confirmed,
            preferences.model_dump(mode="json"),
        )
        return self._with_state(profile, auth_user_id)

    def activate(self, claim_id: int, auth_user_id: str) -> PhysicianNetworkProfile:
        claim = self._owned_claim(claim_id, auth_user_id)
        if claim["status"] != ClaimStatus.VERIFIED:
            raise AgentTransitionError("A verified claim is required before activation")
        profile = self._resolve(claim["npi"])
        self.store.activate_provider_agent(profile.npi)
        return self._with_state(profile, auth_user_id)

    def disable(self, claim_id: int, auth_user_id: str) -> PhysicianNetworkProfile:
        claim = self._owned_claim(claim_id, auth_user_id)
        if claim["status"] != ClaimStatus.VERIFIED:
            raise AgentTransitionError("A verified claim is required to disable this agent")
        profile = self._resolve(claim["npi"])
        state = self.store.provider_agent_state(profile.npi)
        if not state or state["status"] not in {"active", "disabled"}:
            raise AgentTransitionError("The provider agent is not active")
        if state["status"] == "active":
            self.store.disable_provider_agent(profile.npi)
        return self._with_state(profile, auth_user_id)

    def _with_state(
        self,
        profile: PhysicianNetworkProfile,
        auth_user_id: str | None = None,
    ) -> PhysicianNetworkProfile:
        claim = self.store.active_provider_claim(profile.npi)
        agent_state = self.store.provider_agent_state(profile.npi)
        lifecycle = project_lifecycle(claim, agent_state)
        owned = bool(claim and auth_user_id and claim["auth_user_id"] == auth_user_id)
        preferences = (
            AgentPreferences.model_validate(agent_state["preferences"])
            if agent_state and agent_state.get("preferences") else None
        )
        return profile.model_copy(
            update={
                "agent": ReservedAgentIdentity(
                    id=profile.agent.id,
                    status=lifecycle,
                    practice_confirmed=bool(
                        agent_state and agent_state.get("practice_confirmed")
                    ),
                    preferences=preferences,
                ),
                "synthetic": profile.source == ProviderSource.SYNTHETIC,
                "lifecycle_status": lifecycle,
                "claimable": claim is None,
                "agent_active": lifecycle == AgentStatus.ACTIVE,
                "claimed_by_me": owned,
                "my_claim_id": claim["id"] if owned else None,
                "my_claim_status": ClaimStatus(claim["status"]) if owned else None,
            },
            deep=True,
        )
