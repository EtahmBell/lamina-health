"""Physician pilot onboarding: identity discovery, confirmation, and the pilot gate.

Three deliberately separate concepts:

* NPPES lookup      -> identity *discovery* (a public record exists for this NPI)
* user confirmation -> identity *assertion* ("this record is me"), auditable
* pilot approval    -> Lamina's *manual pilot gate*, internal-only

None of these is credentialing or licensure verification.

Canonical relationship:
    authenticated user (Supabase JWT `sub`)
      -> provider_claims row (one active per NPI, one active per account)
      -> physician_owner_scopes row (opaque storage_scope_id / physician_id)
      -> private /api/me/physician/* workspace, gated by pilot_access_status
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from threading import Lock
from time import monotonic
from typing import Any, Protocol

from backend.config import environment
from backend.provider_network.directory import (
    DirectoryRateLimitedError,
    DirectoryUnavailableError,
    LiveNppesTransport,
)
from backend.provider_network.identity import (
    IdentityLookupError,
    IdentityLookupRateLimitedError,
    IdentityLookupUnavailableError,
    NppesIdentity,
    NppesIdentityResolver,
    _live_lookup_enabled,
    normalize_npi,
    normalize_nppes_record,
)
from backend.workflow import WorkflowStore, workflow_store


class NppesSearchTransport(Protocol):
    def search(
        self, query: str, specialty: str, location: str, limit: int
    ) -> tuple[list[dict], int]: ...

VERIFICATION_METHOD = "nppes_match_self_attested"
_ACTIVE_CLAIM_STATUSES = {"claimed", "verification_pending", "verified"}


class OnboardingStatus(StrEnum):
    ACCOUNT_CREATED = "account_created"
    IDENTITY_SELECTED = "identity_selected"
    PILOT_APPROVAL_PENDING = "pilot_approval_pending"
    ACTIVE = "active"
    REJECTED = "rejected"
    DISABLED = "disabled"


class OnboardingError(Exception):
    status_code = 409

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class OnboardingConflictError(OnboardingError):
    status_code = 409


class OnboardingRateLimitedError(OnboardingError):
    status_code = 429


class PilotAdminNotFoundError(OnboardingError):
    status_code = 404


class PilotAdminForbiddenError(OnboardingError):
    status_code = 403


class LookupThrottle:
    """Per-account sliding-window limit so Lamina is not an open NPPES proxy.

    In-process only; a multi-worker deployment should move this to shared storage.
    """

    def __init__(
        self, limit: int = 20, window_seconds: float = 600, clock: Callable[[], float] = monotonic
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window_seconds:
                hits.popleft()
            if len(hits) >= self.limit:
                raise OnboardingRateLimitedError(
                    "lookup_rate_limited", "Too many NPI lookups. Try again in a few minutes"
                )
            hits.append(now)


def _selection_max_age() -> timedelta:
    try:
        seconds = int(environment.get("LAMINA_NPPES_SELECTION_MAX_AGE_SECONDS", "86400"))
    except ValueError:
        seconds = 86400
    return timedelta(seconds=max(60, seconds))


def _public_identity(identity: dict | None) -> dict | None:
    """The physician's own NPPES snapshot, as shown back to that physician only."""
    return dict(identity) if identity else None


class PhysicianOnboardingService:
    def __init__(
        self,
        store: WorkflowStore | None = None,
        resolver: NppesIdentityResolver | None = None,
        throttle: LookupThrottle | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        search_transport: NppesSearchTransport | None = None,
    ) -> None:
        self.store = store or workflow_store
        self.resolver = resolver or NppesIdentityResolver()
        self.throttle = throttle or LookupThrottle()
        self._now = now
        self._search_transport = search_transport

    # ----------------------------------------------------------- projection

    def _active_scope(self, user_id: str) -> tuple[dict | None, dict | None]:
        """The account's selected owner scope and its claim, if the claim is active."""
        scope = self.store.selected_physician_owner_scope(user_id)
        if not scope:
            return None, None
        claim = self.store.provider_claim(scope["provider_claim_id"])
        if not claim or claim["auth_user_id"] != user_id:
            return None, None
        return scope, claim

    def status(self, user_id: str) -> dict[str, Any]:
        """Single server-derived onboarding projection. Never trusts client state."""
        scope, claim = self._active_scope(user_id)
        selection = self.store.identity_selection(user_id)
        active_claim = bool(claim and claim["status"] in _ACTIVE_CLAIM_STATUSES)
        confirmed = bool(active_claim and claim and claim.get("identity_confirmed_at"))

        if confirmed and scope:
            pilot = scope["pilot_access_status"]
            status = {
                "approved": OnboardingStatus.ACTIVE,
                "disabled": OnboardingStatus.DISABLED,
                "rejected": OnboardingStatus.REJECTED,
            }.get(pilot, OnboardingStatus.PILOT_APPROVAL_PENDING)
        elif not active_claim and self.store.has_rejected_claim(user_id):
            status = OnboardingStatus.REJECTED
        elif selection or (active_claim and scope):
            # Includes a legacy unconfirmed claim: it must be confirmed explicitly.
            status = OnboardingStatus.IDENTITY_SELECTED
        else:
            status = OnboardingStatus.ACCOUNT_CREATED

        selected_view = None
        if status == OnboardingStatus.IDENTITY_SELECTED:
            if selection:
                holder = self.store.active_provider_claim(selection["npi"])
                selected_view = {
                    "identity": _public_identity(selection["identity"]),
                    "selected_at": selection["selected_at"],
                    "claim_available": holder is None or holder["auth_user_id"] == user_id,
                }
            elif scope:
                selected_view = {
                    "identity": _public_identity(
                        scope.get("nppes_snapshot") or scope["provider_identity"]
                    ),
                    "selected_at": claim["claimed_at"] if claim else None,
                    "claim_available": True,
                    "legacy_claim": True,
                }
        confirmed_view = None
        if confirmed and scope and claim:
            confirmed_view = {
                "identity": _public_identity(
                    scope.get("nppes_snapshot") or scope["provider_identity"]
                ),
                "npi": scope["npi"],
                "confirmed_at": claim["identity_confirmed_at"],
            }
        pilot_view = None
        if confirmed and scope:
            pilot_view = {
                "status": scope["pilot_access_status"],
                "decided_at": scope.get("pilot_access_decided_at"),
            }
        actions = {
            OnboardingStatus.ACCOUNT_CREATED: ["lookup_npi"],
            OnboardingStatus.IDENTITY_SELECTED: ["lookup_npi", "confirm_identity", "clear_selection"],
            OnboardingStatus.PILOT_APPROVAL_PENDING: [],
            OnboardingStatus.ACTIVE: ["open_workspace"],
            OnboardingStatus.REJECTED: [],
            OnboardingStatus.DISABLED: [],
        }[status]
        if status == OnboardingStatus.IDENTITY_SELECTED and selected_view and selected_view.get(
            "legacy_claim"
        ):
            actions = ["confirm_identity"]  # A held claim cannot be swapped for another NPI.
        return {
            "status": status.value,
            "selection": selected_view,
            "confirmed_identity": confirmed_view,
            "pilot_access": pilot_view,
            "workspace_available": status == OnboardingStatus.ACTIVE,
            "allowed_actions": actions,
            "verification_semantics": {
                "nppes_lookup": "identity_discovery",
                "physician_confirmation": "self_attested",
                "pilot_approval": "manual_lamina_review",
                "credentialing": "not_performed",
            },
        }

    # ---------------------------------------------------------- transitions

    def _require(self, user_id: str, action: str) -> dict[str, Any]:
        current = self.status(user_id)
        if action not in current["allowed_actions"]:
            raise OnboardingConflictError(
                "invalid_onboarding_transition",
                {
                    OnboardingStatus.PILOT_APPROVAL_PENDING.value: (
                        "Your physician identity is already confirmed and awaiting approval"
                    ),
                    OnboardingStatus.ACTIVE.value: (
                        "Your physician identity is already confirmed. Contact Lamina to change it"
                    ),
                    OnboardingStatus.REJECTED.value: (
                        "This account cannot continue onboarding. Contact Lamina"
                    ),
                    OnboardingStatus.DISABLED.value: (
                        "This physician workspace is disabled. Contact Lamina"
                    ),
                }.get(current["status"], "This onboarding step is not available right now"),
            )
        return current

    def lookup(self, user_id: str, npi_input: str) -> dict[str, Any]:
        """Identity discovery. Persists a server-side selection; creates no ownership."""
        self._require(user_id, "lookup_npi")
        npi = normalize_npi(npi_input)  # Validate before spending rate-limit budget.
        self.throttle.check(user_id)
        identity = self.resolver.lookup(npi)
        self.store.save_identity_selection(
            user_id, identity.npi, identity.model_dump(mode="json"), identity.fetched_at
        )
        return self.status(user_id)

    def _search(self) -> NppesSearchTransport:
        if self._search_transport is None:
            if not _live_lookup_enabled():
                raise IdentityLookupUnavailableError("NPPES search is not available right now")
            self._search_transport = LiveNppesTransport()
        return self._search_transport

    def search(
        self, user_id: str, name: str, location: str = "", specialty: str = ""
    ) -> dict[str, Any]:
        """Identity discovery by name. Returns candidates only: no selection, no claim.

        Picking a candidate goes through `lookup` (exact NPI) and then the explicit
        confirmation step, exactly like typing the NPI.
        """
        self._require(user_id, "lookup_npi")
        terms = " ".join(name.split())
        if len(terms.replace(" ", "")) < 2:
            raise OnboardingConflictError("search_too_short", "Enter at least two letters of your name")
        if terms.isdigit():
            raise OnboardingConflictError("search_use_npi", "Use the NPI field to search by number")
        self.throttle.check(user_id)
        try:
            raw_results, total = self._search().search(terms, specialty, location, 20)
        except DirectoryRateLimitedError as error:
            raise IdentityLookupRateLimitedError("NPPES is busy right now. Try again in a minute") from error
        except DirectoryUnavailableError as error:
            raise IdentityLookupUnavailableError(
                "NPPES search is not available right now. Try again shortly"
            ) from error
        fetched_at = self._now().isoformat(timespec="seconds")
        candidates = []
        for raw in raw_results:
            number = str((raw or {}).get("number", ""))
            try:
                identity = normalize_nppes_record(raw, normalize_npi(number), fetched_at)
            except IdentityLookupError:
                continue  # Organizations, inactive, synthetic, or malformed rows are skipped.
            holder = self.store.active_provider_claim(identity.npi)
            candidates.append({
                "identity": identity.model_dump(mode="json"),
                "claim_available": holder is None or holder["auth_user_id"] == user_id,
            })
        return {"results": candidates, "result_count": total, "truncated": total > len(candidates)}

    def clear_selection(self, user_id: str) -> dict[str, Any]:
        """"Not me": discard the pending selection. Never touches confirmed claims."""
        self._require(user_id, "clear_selection")
        self.store.clear_identity_selection(user_id)
        return self.status(user_id)

    def confirm(self, user_id: str, npi_input: str) -> dict[str, Any]:
        """User assertion: bind exactly one claim + private owner scope to this account.

        The identity data comes only from the server-held selection snapshot; the
        request supplies just the NPI the user saw, which must match it.
        """
        current = self.status(user_id)
        if current["status"] in {
            OnboardingStatus.PILOT_APPROVAL_PENDING.value,
            OnboardingStatus.ACTIVE.value,
        }:
            confirmed = current["confirmed_identity"] or {}
            if confirmed.get("npi") == "".join(str(npi_input).split()):
                return current  # Idempotent replay of the same confirmation.
        if current["status"] == OnboardingStatus.ACCOUNT_CREATED.value:
            raise OnboardingConflictError(
                "selection_required", "Look up your NPI before confirming"
            )
        self._require(user_id, "confirm_identity")
        npi = normalize_npi(npi_input)
        selection = self.store.identity_selection(user_id)
        if selection:
            if selection["npi"] != npi:
                raise OnboardingConflictError(
                    "selection_mismatch",
                    "This NPI does not match the identity you looked up. Look it up again",
                )
            fetched_at = datetime.fromisoformat(selection["fetched_at"])
            if self._now() - fetched_at > _selection_max_age():
                raise OnboardingConflictError(
                    "selection_expired", "This lookup has expired. Look up your NPI again"
                )
            identity = NppesIdentity.model_validate(selection["identity"])
        else:
            # Legacy unconfirmed claim: confirm against a fresh NPPES lookup.
            legacy = (current.get("selection") or {}).get("legacy_claim")
            scope, _ = self._active_scope(user_id)
            if not legacy or not scope or scope["npi"] != npi:
                raise OnboardingConflictError(
                    "selection_required", "Look up your NPI before confirming"
                )
            identity = self.resolver.lookup(npi)
        outcome, _, _ = self.store.confirm_physician_identity(
            user_id,
            identity.npi,
            nppes_snapshot=identity.model_dump(mode="json"),
            provider_identity=identity.provider_identity(),
            nppes_fetched_at=identity.fetched_at,
            verification_method=VERIFICATION_METHOD,
        )
        if outcome == "npi_claimed":
            raise OnboardingConflictError(
                "npi_already_claimed",
                "This NPI is already linked to another Lamina account. If you believe this is "
                "a mistake, contact Lamina — the existing link will not be changed automatically",
            )
        if outcome == "account_bound":
            raise OnboardingConflictError(
                "account_already_bound",
                "This account is already linked to a different physician identity",
            )
        if outcome == "account_rejected":
            raise OnboardingConflictError(
                "account_rejected", "This account cannot continue onboarding. Contact Lamina"
            )
        return self.status(user_id)

    # ------------------------------------------------------------- internal

    @staticmethod
    def _admin_view(row: dict) -> dict[str, Any]:
        return {
            "owner_scope_id": row["id"],
            "auth_user_id": row["auth_user_id"],
            "npi": row["npi"],
            "claim_status": row.get("claim_status"),
            "identity_confirmed_at": row.get("identity_confirmed_at"),
            "verification_method": row.get("verification_method"),
            "nppes_snapshot": row.get("nppes_snapshot"),
            "nppes_fetched_at": row.get("nppes_fetched_at"),
            "pilot_access_status": row["pilot_access_status"],
            "pilot_access_decided_at": row.get("pilot_access_decided_at"),
            "pilot_access_decided_by": row.get("pilot_access_decided_by"),
            "pilot_access_note": row.get("pilot_access_note"),
            "created_at": row["created_at"],
        }

    def review_queue(self, pilot_access_status: str | None = "pending") -> list[dict]:
        return [
            self._admin_view(row) for row in self.store.pilot_owner_scopes(pilot_access_status)
        ]

    def decide(
        self, scope_id: str, decision: str, actor: str, note: str | None = None
    ) -> dict[str, Any]:
        """Internal pilot gate. `actor` is recorded verbatim as `pilot_access_decided_by`."""
        if decision not in {"approve", "reject", "disable"}:
            raise OnboardingConflictError("invalid_decision", "Unknown pilot decision")
        existing = self.store.physician_owner_scope(scope_id)
        if not existing:
            raise PilotAdminNotFoundError("not_found", "Pilot physician not found")
        if actor in {existing["auth_user_id"], f"user:{existing['auth_user_id']}"}:
            raise PilotAdminForbiddenError(
                "self_decision_forbidden", "Pilot decisions cannot be made on your own account"
            )
        try:
            row = self.store.decide_pilot_access(scope_id, decision, actor, note)
        except ValueError as error:
            raise OnboardingConflictError("invalid_pilot_transition", str(error)) from error
        if not row:
            raise PilotAdminNotFoundError("not_found", "Pilot physician not found")
        claim = self.store.provider_claim(row["provider_claim_id"]) or {}
        return self._admin_view(
            {
                **row,
                "claim_status": claim.get("status"),
                "identity_confirmed_at": claim.get("identity_confirmed_at"),
                "verification_method": claim.get("verification_method"),
            }
        )


__all__ = [
    "VERIFICATION_METHOD",
    "IdentityLookupError",
    "LookupThrottle",
    "OnboardingConflictError",
    "OnboardingError",
    "OnboardingStatus",
    "PhysicianOnboardingService",
    "PilotAdminForbiddenError",
    "PilotAdminNotFoundError",
]
