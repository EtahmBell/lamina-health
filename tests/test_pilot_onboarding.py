"""Pilot physician onboarding: identity discovery, confirmation, ownership, and the pilot gate.

Everything here runs offline: NPPES is a fake transport returning raw API-shaped
records, and Supabase is a fake token verifier.
"""

from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import engagement as engagement_api
from backend.api import physician_onboarding as onboarding_api
from backend.api import physician_sandbox as sandbox_api
from backend.auth import AuthenticatedUser, AuthenticationError, get_token_verifier
from backend.main import app
from backend.physician_onboarding import (
    LookupThrottle,
    OnboardingError,
    PhysicianOnboardingService,
)
from backend.physician_sandbox import PhysicianSandboxService
from backend.provider_network import api as provider_api
from backend.provider_network.directory import (
    DirectoryMalformedResponseError,
    DirectoryQueryRejectedError,
    DirectoryRateLimitedError,
    DirectoryTimeoutError,
    DirectoryUnavailableError,
    NppesDirectory,
)
from backend.provider_network.identity import (
    NppesIdentityResolver,
    normalize_nppes_record,
    npi_checksum_valid,
)
from backend.provider_network.service import ProviderNetwork
from backend.synthetic_data import SYNTHETIC_PHYSICIAN_NPIS
from backend.workflow import WorkflowStore

NPI_A = "1234567893"
NPI_B = "1234567802"
NPI_ORG = "1234567810"
NPI_INACTIVE = "1234567828"
NPI_UNKNOWN = "1987654328"
SYNTHETIC_NPI = SYNTHETIC_PHYSICIAN_NPIS["physician-jung"]

PRIVATE_GET_ROUTES = [
    "/api/me/physician/profile",
    "/api/me/physician/interests",
    "/api/me/physician/initialization",
    "/api/me/physician/agent-overview",
    "/api/me/physician/practice-representation",
    "/api/me/physician/training",
    "/api/me/physician/training/history",
    "/api/me/physician/training/sessions/1",
    "/api/me/physician/profile/enrichment",
    "/api/me/physician/agent-test-cases",
    "/api/me/physician/posts",
]
PRIVATE_WRITE_ROUTES = [
    ("PUT", "/api/me/physician/profile/items/about", {"category": "about", "title": "x"}),
    ("POST", "/api/me/physician/interests", {"interest_type": "case_interest", "title": "x"}),
    ("POST", "/api/me/physician/training/sessions", {}),
    ("POST", "/api/me/physician/agent-chat", {"mode": "practice_question", "message": "x"}),
    ("POST", "/api/me/physician/posts", {"type": "other", "title": "x", "body": "y"}),
    ("POST", "/api/me/physician/profile/enrich", None),
]


def _record(
    npi: str,
    first: str,
    last: str,
    specialty: str,
    code: str,
    city: str,
    state: str = "CA",
    *,
    status: str = "A",
    enumeration_type: str = "NPI-1",
) -> dict:
    return {
        "number": npi,
        "enumeration_type": enumeration_type,
        "basic": {
            "first_name": first.upper(),
            "middle_name": "Q",
            "last_name": last.upper(),
            "credential": "M.D.",
            "status": status,
            "enumeration_date": "2010-04-01",
            "last_updated": "2024-02-03",
        },
        "taxonomies": [
            {"code": "208D00000X", "desc": "General Practice", "primary": False, "state": state},
            {
                "code": code,
                "desc": specialty,
                "primary": True,
                "state": state,
                "license": "A12345",
            },
        ],
        "addresses": [
            {
                "address_purpose": "MAILING",
                "address_1": "PO BOX 9",
                "city": "ELSEWHERE",
                "state": state,
                "postal_code": "999990000",
            },
            {
                "address_purpose": "LOCATION",
                "address_1": "100 MAIN ST",
                "city": city.upper(),
                "state": state,
                "postal_code": "943010000",
                "telephone_number": "650-555-0100",
            },
        ],
        "practiceLocations": [
            {"address_1": "200 SECOND AVE", "city": "SAN JOSE", "state": state,
             "postal_code": "95112"}
        ],
    }


RECORDS = {
    NPI_A: _record(NPI_A, "Jane", "Smith", "Nephrology", "207RN0300X", "Palo Alto"),
    NPI_B: _record(NPI_B, "John", "Doe", "Cardiovascular Disease", "207RC0000X", "Oakland"),
    NPI_ORG: {**_record(NPI_ORG, "Bay", "Clinic", "Clinic", "261Q00000X", "Oakland"),
              "enumeration_type": "NPI-2"},
    NPI_INACTIVE: _record(NPI_INACTIVE, "Old", "Record", "Nephrology", "207RN0300X", "Fresno",
                          status="D"),
}


class FakeTransport:
    def __init__(self) -> None:
        self.mode = "ok"
        self.calls = 0
        self.records = dict(RECORDS)

    def fetch_record(self, npi: str) -> dict | None:
        self.calls += 1
        failures = {
            "timeout": DirectoryTimeoutError("timeout"),
            "down": DirectoryUnavailableError("down"),
            "malformed": DirectoryMalformedResponseError("bad json"),
            "rate": DirectoryRateLimitedError("429"),
            "rejected": DirectoryQueryRejectedError("Errors"),
        }
        if self.mode in failures:
            raise failures[self.mode]
        if self.mode == "garbage":
            return {"number": npi, "enumeration_type": "NPI-1", "basic": "not-an-object"}
        return self.records.get(npi)


class FakeVerifier:
    users: ClassVar = {
        "token-user-a": "user-a",
        "token-user-b": "user-b",
        "token-user-c": "user-c",
        "token-admin": "admin",
    }

    def verify(self, token: str) -> AuthenticatedUser:
        if user := self.users.get(token):
            return AuthenticatedUser(id=user)
        raise AuthenticationError("invalid")


def _h(user: str) -> dict[str, str]:
    return {"Authorization": f"Bearer token-{user}"}


class Harness:
    def __init__(self, client: TestClient, store: WorkflowStore, transport: FakeTransport,
                 service: PhysicianOnboardingService) -> None:
        self.client, self.store, self.transport, self.service = client, store, transport, service

    def status(self, user: str) -> dict:
        response = self.client.get("/api/me/onboarding/status", headers=_h(user))
        assert response.status_code == 200, response.text
        return response.json()

    def lookup(self, user: str, npi: str):
        return self.client.post("/api/me/onboarding/npi/lookup", headers=_h(user), json={"npi": npi})

    def confirm(self, user: str, npi: str):
        return self.client.post(
            "/api/me/onboarding/identity/confirm", headers=_h(user), json={"npi": npi}
        )

    def scope(self, user: str) -> dict:
        return self.store.selected_physician_owner_scope(user)

    def decide(self, user: str, decision: str, actor: str = "admin", note: str | None = None):
        return self.client.post(
            f"/api/internal/pilot-physicians/{self.scope(user)['id']}/{decision}",
            headers=_h(actor),
            json={"note": note} if note else None,
        )

    def onboard(self, user: str, npi: str, *, approve: bool = True) -> dict:
        assert self.lookup(user, npi).status_code == 200
        assert self.confirm(user, npi).status_code == 200
        if approve:
            assert self.decide(user, "approve").status_code == 200
        return self.scope(user)


def _empty_directory(path: Path) -> NppesDirectory:
    with sqlite3.connect(path) as db:
        db.executescript(
            """
            CREATE TABLE physicians (
              npi TEXT PRIMARY KEY, display_name TEXT, primary_specialty TEXT,
              primary_taxonomy_code TEXT, organization_name TEXT, city TEXT,
              state TEXT, phone TEXT, active INTEGER, source TEXT,
              first_name TEXT, last_name TEXT
            );
            CREATE TABLE agents (physician_npi TEXT, status TEXT);
            CREATE VIRTUAL TABLE physician_fts USING fts5(
              npi UNINDEXED, display_name, primary_specialty, city, state
            );
            INSERT INTO physicians VALUES
              ('1234567893', 'JANE SMITH, MD', 'Nephrology', '207RN0300X', NULL,
               'PALO ALTO', 'CA', NULL, 1, 'NPPES', 'JANE', 'SMITH');
            INSERT INTO agents VALUES ('1234567893', 'reserved');
            """
        )
    return NppesDirectory(path)


@pytest.fixture
def pilot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    transport = FakeTransport()
    network = ProviderNetwork(_empty_directory(tmp_path / "nppes.sqlite"), store, False)
    service = PhysicianOnboardingService(
        store, NppesIdentityResolver(transport, cache_seconds=0), LookupThrottle(limit=1000)
    )
    monkeypatch.setattr(onboarding_api, "onboarding_service", service)
    monkeypatch.setattr(sandbox_api, "sandbox_service", PhysicianSandboxService(store, network))
    monkeypatch.setattr(provider_api, "provider_network", network)
    monkeypatch.setattr(engagement_api, "workflow_store", store)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
    monkeypatch.setenv("LAMINA_PILOT_ADMIN_USER_IDS", "admin")
    app.dependency_overrides[get_token_verifier] = lambda: FakeVerifier()
    try:
        yield Harness(TestClient(app), store, transport, service)
    finally:
        app.dependency_overrides.clear()


def _no_ownership(store: WorkflowStore, user: str) -> None:
    assert store.provider_claims(user) == []
    assert store.physician_owner_scopes(user) == []


# ---------------------------------------------------------------- auth / identity


def test_unauthenticated_and_invalid_tokens_cannot_touch_onboarding(pilot: Harness) -> None:
    client = pilot.client
    bad = {"Authorization": "Bearer forged"}
    for headers in ({}, bad):
        assert client.get("/api/me/onboarding/status", headers=headers).status_code == 401
        assert client.post("/api/me/onboarding/npi/lookup", headers=headers,
                           json={"npi": NPI_A}).status_code == 401
        assert client.post("/api/me/onboarding/identity/confirm", headers=headers,
                           json={"npi": NPI_A}).status_code == 401
        assert client.delete("/api/me/onboarding/selection", headers=headers).status_code == 401
        assert client.get("/api/me/physician/profile", headers=headers).status_code == 401
    assert pilot.transport.calls == 0


def test_lookup_is_discovery_only_and_normalizes_nppes(pilot: Harness) -> None:
    assert pilot.status("user-a")["status"] == "account_created"
    response = pilot.lookup("user-a", f" {NPI_A} ")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "identity_selected"
    identity = body["selection"]["identity"]
    assert identity["npi"] == NPI_A
    assert identity["display_name"] == "Jane Q Smith, M.D."
    assert identity["primary_specialty"] == "Nephrology"
    assert [t["primary"] for t in identity["taxonomies"]] == [True, False]
    assert "license" not in str(identity["taxonomies"]).casefold()
    cities = [location["city"] for location in identity["practice_locations"]]
    assert cities == ["Palo Alto", "San Jose"], "mailing addresses are not practice locations"
    assert identity["practice_locations"][0]["postal_code"] == "94301"
    assert identity["source"] == "NPPES" and identity["fetched_at"]
    assert body["selection"]["claim_available"] is True
    assert body["verification_semantics"]["credentialing"] == "not_performed"
    _no_ownership(pilot.store, "user-a")
    public = pilot.client.get(f"/api/providers/{NPI_A}/claim-state").json()
    assert public["claimable"] is True
    assert "user-a" not in response.text


@pytest.mark.parametrize(
    ("npi", "code"),
    [
        ("12345", "invalid_npi"),
        ("abcdefghij", "invalid_npi"),
        ("1234567890", "invalid_npi"),  # Fails the NPI check digit.
        ("12345678931", "invalid_npi"),
        (SYNTHETIC_NPI, "synthetic_identity"),
    ],
)
def test_malformed_and_synthetic_npis_are_rejected_before_nppes(
    pilot: Harness, npi: str, code: str
) -> None:
    response = pilot.lookup("user-a", npi)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code
    assert pilot.transport.calls == 0
    _no_ownership(pilot.store, "user-a")
    assert pilot.status("user-a")["status"] == "account_created"


@pytest.mark.parametrize(
    ("npi", "status_code", "code"),
    [
        (NPI_UNKNOWN, 404, "npi_not_found"),
        (NPI_ORG, 422, "npi_not_eligible"),
        (NPI_INACTIVE, 422, "npi_not_eligible"),
    ],
)
def test_unknown_and_ineligible_records_are_handled_safely(
    pilot: Harness, npi: str, status_code: int, code: str
) -> None:
    response = pilot.lookup("user-a", npi)
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    _no_ownership(pilot.store, "user-a")
    assert pilot.store.identity_selection("user-a") is None


@pytest.mark.parametrize(
    ("mode", "status_code", "code"),
    [
        ("timeout", 503, "nppes_unavailable"),
        ("down", 503, "nppes_unavailable"),
        ("malformed", 503, "nppes_unavailable"),
        ("garbage", 503, "nppes_unavailable"),
        ("rate", 429, "nppes_rate_limited"),
        ("rejected", 422, "invalid_npi"),
    ],
)
def test_nppes_failures_fail_closed_and_create_no_ownership(
    pilot: Harness, mode: str, status_code: int, code: str
) -> None:
    pilot.transport.mode = mode
    response = pilot.lookup("user-a", NPI_A)
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert "Traceback" not in response.text
    _no_ownership(pilot.store, "user-a")
    assert pilot.status("user-a")["status"] == "account_created"
    assert pilot.confirm("user-a", NPI_A).status_code == 409


def test_confirmation_creates_exactly_one_scope_and_is_idempotent(pilot: Harness) -> None:
    pilot.lookup("user-a", NPI_A)
    first = pilot.confirm("user-a", NPI_A)
    assert first.status_code == 200
    assert first.json()["status"] == "pilot_approval_pending"
    for _ in range(3):
        replay = pilot.confirm("user-a", NPI_A)
        assert replay.status_code == 200
        assert replay.json()["status"] == "pilot_approval_pending"
    claims = pilot.store.provider_claims("user-a")
    scopes = pilot.store.physician_owner_scopes("user-a")
    assert len(claims) == 1 and len(scopes) == 1
    claim, scope = claims[0], scopes[0]
    assert claim["status"] == "verification_pending"
    assert claim["verification_method"] == "nppes_match_self_attested"
    assert claim["identity_confirmed_at"]
    assert scope["pilot_access_status"] == "pending"
    assert scope["nppes_snapshot"]["npi"] == NPI_A
    assert scope["nppes_fetched_at"] == scope["nppes_snapshot"]["fetched_at"]
    assert NPI_A not in scope["storage_scope_id"] and NPI_A not in scope["physician_id"]
    events = [event["event"] for event in pilot.store.onboarding_events("user-a")]
    assert events == ["identity_selected", "identity_confirmed"]
    assert pilot.store.identity_selection("user-a") is None


def test_concurrent_confirmations_still_create_one_claim_and_scope(pilot: Harness) -> None:
    pilot.lookup("user-a", NPI_A)
    barrier = threading.Barrier(6)

    def confirm() -> int:
        barrier.wait()
        return pilot.service.confirm("user-a", NPI_A)["status"]

    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: _safe(confirm), range(6)))
    assert "pilot_approval_pending" in results
    assert len(pilot.store.provider_claims("user-a")) == 1
    assert len(pilot.store.physician_owner_scopes("user-a")) == 1


def _safe(action):
    try:
        return action()
    except (OnboardingError, sqlite3.Error) as error:  # A racer may lose the write lock.
        return type(error).__name__


def test_confirmation_uses_only_the_server_snapshot(pilot: Harness) -> None:
    assert pilot.confirm("user-a", NPI_A).json()["detail"]["code"] == "selection_required"
    pilot.lookup("user-a", NPI_A)
    forged = pilot.client.post(
        "/api/me/onboarding/identity/confirm",
        headers=_h("user-a"),
        json={"npi": NPI_A, "display_name": "Dr. Somebody Else", "pilot_access_status": "approved"},
    )
    assert forged.status_code == 422, "identity fields and approval state are never accepted"
    mismatch = pilot.confirm("user-a", NPI_B)
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == "selection_mismatch"
    _no_ownership(pilot.store, "user-a")
    assert pilot.confirm("user-a", NPI_A).status_code == 200
    scope = pilot.scope("user-a")
    assert scope["provider_identity"]["display_name"] == "Jane Q Smith, M.D."
    assert scope["pilot_access_status"] == "pending"


def test_nppes_outage_after_selection_does_not_block_or_corrupt_confirmation(
    pilot: Harness,
) -> None:
    pilot.lookup("user-a", NPI_A)
    calls = pilot.transport.calls
    pilot.transport.mode = "down"
    confirmed = pilot.confirm("user-a", NPI_A)
    assert confirmed.status_code == 200
    assert pilot.transport.calls == calls, "confirmation never re-fetches NPPES"
    assert pilot.scope("user-a")["nppes_snapshot"]["npi"] == NPI_A


def test_expired_selection_cannot_be_confirmed(pilot: Harness) -> None:
    pilot.lookup("user-a", NPI_A)
    pilot.service._now = lambda: datetime.now(UTC) + timedelta(days=2)
    expired = pilot.confirm("user-a", NPI_A)
    assert expired.status_code == 409
    assert expired.json()["detail"]["code"] == "selection_expired"
    _no_ownership(pilot.store, "user-a")


def test_not_me_clears_the_selection_without_side_effects(pilot: Harness) -> None:
    pilot.lookup("user-a", NPI_A)
    cleared = pilot.client.delete("/api/me/onboarding/selection", headers=_h("user-a"))
    assert cleared.status_code == 200
    assert cleared.json()["status"] == "account_created"
    _no_ownership(pilot.store, "user-a")
    assert pilot.lookup("user-a", NPI_B).json()["selection"]["identity"]["npi"] == NPI_B


def test_lookup_rate_limit_is_per_account(pilot: Harness) -> None:
    pilot.service.throttle = LookupThrottle(limit=2)
    assert pilot.lookup("user-a", NPI_A).status_code == 200
    assert pilot.lookup("user-a", NPI_B).status_code == 200
    limited = pilot.lookup("user-a", NPI_A)
    assert limited.status_code == 429
    assert limited.json()["detail"]["code"] == "lookup_rate_limited"
    assert pilot.lookup("user-b", NPI_A).status_code == 200


# --------------------------------------------------------------------- ownership


def test_second_account_cannot_claim_a_confirmed_npi(pilot: Harness) -> None:
    pilot.onboard("user-a", NPI_A, approve=False)
    looked_up = pilot.lookup("user-b", NPI_A).json()
    assert looked_up["selection"]["claim_available"] is False
    conflict = pilot.confirm("user-b", NPI_A)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "npi_already_claimed"
    assert "user-a" not in conflict.text and "pos-" not in conflict.text
    _no_ownership(pilot.store, "user-b")
    assert pilot.store.active_provider_claim(NPI_A)["auth_user_id"] == "user-a"
    # Approval of A afterwards is unaffected; B's failed attempt changed nothing.
    assert pilot.decide("user-a", "approve").status_code == 200


def test_npi_cannot_be_changed_after_confirmation_or_activation(pilot: Harness) -> None:
    pilot.onboard("user-a", NPI_A, approve=False)
    for approved in (False, True):
        lookup = pilot.lookup("user-a", NPI_B)
        assert lookup.status_code == 409
        assert lookup.json()["detail"]["code"] == "invalid_onboarding_transition"
        assert pilot.confirm("user-a", NPI_B).status_code == 409
        assert pilot.client.delete(
            "/api/me/onboarding/selection", headers=_h("user-a")
        ).status_code == 409
        if not approved:
            pilot.decide("user-a", "approve")
    assert [claim["npi"] for claim in pilot.store.provider_claims("user-a")] == [NPI_A]
    assert pilot.store.active_provider_claim(NPI_B) is None


def test_legacy_claim_shortcut_cannot_claim_real_npis(pilot: Harness) -> None:
    response = pilot.client.post(f"/api/providers/{NPI_A}/claim", headers=_h("user-a"))
    assert response.status_code == 409
    assert "onboarding" in response.json()["detail"]
    _no_ownership(pilot.store, "user-a")


def test_cross_account_reads_and_writes_cannot_escape_scope(pilot: Harness) -> None:
    scope_a = pilot.onboard("user-a", NPI_A)
    scope_b = pilot.onboard("user-b", NPI_B)
    client = pilot.client
    assert client.put(
        "/api/me/physician/profile/items/about",
        headers=_h("user-a"),
        json={"category": "about", "title": "A private summary"},
    ).status_code == 200
    session_a = client.post("/api/me/physician/training/sessions", headers=_h("user-a")).json()
    post_a = client.post(
        "/api/me/physician/posts",
        headers=_h("user-a"),
        json={"type": "other", "title": "A draft", "body": "A private body"},
    ).json()

    forged = {
        "physician_id": scope_a["physician_id"],
        "owner_scope_id": scope_a["id"],
        "storage_scope_id": scope_a["storage_scope_id"],
        "npi": NPI_A,
        "perspective": "lucy",
    }
    profile_b = client.get("/api/me/physician/profile", headers=_h("user-b"), params=forged)
    assert profile_b.status_code == 200
    assert profile_b.json()["physician"]["id"] == scope_b["physician_id"]
    assert "A private summary" not in profile_b.text
    assert NPI_A not in profile_b.text
    # Forged identifiers in a write body are ignored or rejected, never honored.
    client.put(
        "/api/me/physician/profile/items/about",
        headers={**_h("user-b"), "X-Physician-Npi": NPI_A},
        params=forged,
        json={"category": "about", "title": "B summary", **forged},
    )
    profile_a = client.get("/api/me/physician/profile", headers=_h("user-a")).json()
    assert [item["title"] for item in profile_a["items"]] == ["A private summary"]
    # Resource ids that belong to A are non-disclosing 404s for B.
    sid = session_a["id"]
    assert client.get(f"/api/me/physician/training/sessions/{sid}",
                      headers=_h("user-b")).status_code == 404
    assert client.post(f"/api/me/physician/training/sessions/{sid}/finish",
                       headers=_h("user-b")).status_code == 404
    assert client.put(f"/api/me/physician/posts/{post_a['id']}", headers=_h("user-b"),
                      json={"type": "other", "title": "x", "body": "y"}).status_code == 404
    claim_a = pilot.store.provider_claims("user-a")[0]
    assert client.put(f"/api/me/physician/selection/{claim_a['id']}",
                      headers=_h("user-b")).status_code == 404
    assert client.get("/api/me/physician/posts", headers=_h("user-b")).json() == []
    # B's admin-route probes are invisible.
    assert client.get("/api/internal/pilot-physicians", headers=_h("user-b")).status_code == 404
    assert client.post(f"/api/internal/pilot-physicians/{scope_a['id']}/reject",
                       headers=_h("user-b")).status_code == 404
    assert pilot.scope("user-a")["pilot_access_status"] == "approved"


# -------------------------------------------------------------------------- approval


def test_pending_physician_cannot_enter_any_private_route(pilot: Harness) -> None:
    pilot.onboard("user-a", NPI_A, approve=False)
    assert pilot.status("user-a")["status"] == "pilot_approval_pending"
    for path in PRIVATE_GET_ROUTES:
        response = pilot.client.get(path, headers=_h("user-a"))
        assert response.status_code == 403, path
        assert response.json()["detail"]["code"] == "pilot_approval_pending"
    for method, path, body in PRIVATE_WRITE_ROUTES:
        response = pilot.client.request(method, path, headers=_h("user-a"), json=body)
        assert response.status_code == 403, path
    scope = pilot.scope("user-a")
    assert pilot.store.profile_items(scope["storage_scope_id"], scope["physician_id"]) == []
    status = pilot.client.get("/api/me/physician/status", headers=_h("user-a")).json()
    assert status["pilot_access_status"] == "pending"
    assert not any(status["capabilities"].values())


def test_physician_cannot_approve_themselves(pilot: Harness, monkeypatch) -> None:
    pilot.onboard("user-a", NPI_A, approve=False)
    scope_id = pilot.scope("user-a")["id"]
    for path in (f"/api/internal/pilot-physicians/{scope_id}/approve",
                 "/api/internal/pilot-physicians"):
        assert pilot.client.post(path, headers=_h("user-a")).status_code in {404, 405}
    assert pilot.client.get("/api/internal/pilot-physicians",
                            headers=_h("user-a")).status_code == 404
    # Even an allow-listed admin cannot decide on their own account.
    monkeypatch.setenv("LAMINA_PILOT_ADMIN_USER_IDS", "admin,user-a")
    own = pilot.client.post(
        f"/api/internal/pilot-physicians/{scope_id}/approve", headers=_h("user-a")
    )
    assert own.status_code == 403
    assert own.json()["detail"]["code"] == "self_decision_forbidden"
    # With no allow-list configured, the internal API does not exist for anyone.
    monkeypatch.setenv("LAMINA_PILOT_ADMIN_USER_IDS", "")
    assert pilot.decide("user-a", "approve").status_code == 404
    assert pilot.scope("user-a")["pilot_access_status"] == "pending"


def test_admin_approval_activates_the_workspace_and_is_audited(pilot: Harness) -> None:
    pilot.onboard("user-a", NPI_A, approve=False)
    queue = pilot.client.get("/api/internal/pilot-physicians", headers=_h("admin")).json()
    assert [row["npi"] for row in queue] == [NPI_A]
    assert queue[0]["nppes_snapshot"]["display_name"] == "Jane Q Smith, M.D."
    assert queue[0]["identity_confirmed_at"]
    approved = pilot.decide("user-a", "approve", note="Called practice line")
    assert approved.status_code == 200
    assert approved.json()["pilot_access_decided_by"] == "user:admin"
    assert pilot.decide("user-a", "approve").status_code == 200, "approval is idempotent"
    status = pilot.status("user-a")
    assert status["status"] == "active" and status["workspace_available"] is True
    assert status["pilot_access"]["status"] == "approved"
    assert "decided_by" not in str(status), "approver identity is internal"
    assert pilot.client.get("/api/me/physician/profile", headers=_h("user-a")).status_code == 200
    events = pilot.store.onboarding_events("user-a")
    assert [e["event"] for e in events] == [
        "identity_selected", "identity_confirmed", "pilot_approved"
    ]
    assert events[-1]["actor"] == "user:admin"
    assert events[-1]["detail"] == {"note": "Called practice line"}


def test_disabled_and_rejected_physicians_lose_access(pilot: Harness) -> None:
    pilot.onboard("user-a", NPI_A)
    assert pilot.decide("user-a", "disable").status_code == 200
    blocked = pilot.client.get("/api/me/physician/profile", headers=_h("user-a"))
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "pilot_access_disabled"
    assert pilot.status("user-a")["status"] == "disabled"
    assert pilot.store.active_provider_claim(NPI_A)["auth_user_id"] == "user-a"

    assert pilot.decide("user-a", "approve").status_code == 200
    assert pilot.client.get("/api/me/physician/profile", headers=_h("user-a")).status_code == 200

    assert pilot.decide("user-a", "reject").status_code == 200
    rejected = pilot.client.get("/api/me/physician/profile", headers=_h("user-a"))
    assert rejected.status_code == 403
    assert pilot.status("user-a")["status"] == "rejected"
    assert pilot.lookup("user-a", NPI_A).status_code == 409
    assert pilot.store.active_provider_claim(NPI_A) is None, "rejection releases the NPI"
    assert pilot.decide("user-a", "approve").status_code == 409
    pilot.onboard("user-b", NPI_A)
    assert pilot.status("user-b")["status"] == "active"


# ------------------------------------------------------------------ demo separation


def test_demo_cookie_never_resolves_authenticated_pilot_state(pilot: Harness) -> None:
    scope = pilot.onboard("user-a", NPI_A)
    client = pilot.client
    client.put(
        "/api/me/physician/profile/items/about",
        headers=_h("user-a"),
        json={"category": "about", "title": "Pilot-only summary"},
    )
    # 1. A demo cookie forged as the pilot storage key gets a fresh demo workspace.
    demo = TestClient(app)
    demo.cookies.set("lamina_demo_workspace", scope["storage_scope_id"],
                     domain="testserver.local", path="/")
    profile = demo.get("/api/workspace/physician/profile")
    assert profile.status_code == 200
    assert "Pilot-only summary" not in profile.text
    issued = profile.cookies.get("lamina_demo_workspace")
    assert issued and issued != scope["storage_scope_id"]
    # 2. Demo routes cannot address the opaque pilot physician id as a persona.
    assert demo.get("/api/workspace/physician/profile",
                    params={"perspective": scope["physician_id"]}).status_code == 404
    assert demo.get("/api/workspace/physician/profile",
                    params={"npi": NPI_A}).status_code == 400
    # 3. A demo cookie without a bearer token never reaches /me.
    assert demo.get("/api/me/physician/profile").status_code == 401
    assert demo.get("/api/me/onboarding/status").status_code == 401
    # 4. Authenticated + demo cookie resolves only through the bearer account.
    both = demo.get("/api/me/physician/profile", headers=_h("user-a"))
    assert both.status_code == 200
    assert both.json()["physician"]["id"] == scope["physician_id"]
    assert "Saruhashi" not in both.text and "Lucy" not in both.text


def test_pilot_writes_never_touch_demo_rows_and_vice_versa(pilot: Harness) -> None:
    scope = pilot.onboard("user-a", NPI_A)
    demo = TestClient(app)
    demo.get("/api/workspace/physician/profile")
    demo_workspace = demo.cookies.get("lamina_demo_workspace")
    demo.put(
        "/api/workspace/physician/profile/items/about",
        headers={"Origin": "http://localhost:5173"},
        json={"category": "about", "title": "Demo-only summary"},
    )
    pilot.client.put(
        "/api/me/physician/profile/items/about",
        headers=_h("user-a"),
        json={"category": "about", "title": "Pilot-only summary"},
    )
    pilot_items = pilot.store.profile_items(scope["storage_scope_id"], scope["physician_id"])
    demo_items = pilot.store.profile_items(demo_workspace, "lucy")
    assert [item["title"] for item in pilot_items] == ["Pilot-only summary"]
    assert "Pilot-only summary" not in [item["title"] for item in demo_items]
    me = pilot.client.get("/api/me/physician/profile", headers=_h("user-a")).text
    assert "Demo-only summary" not in me


def test_signed_in_account_without_identity_never_falls_back_to_demo(pilot: Harness) -> None:
    for path in PRIVATE_GET_ROUTES:
        response = pilot.client.get(path, headers=_h("user-c"))
        assert response.status_code == 403, path
        assert response.json()["detail"]["code"] == "physician_identity_required"
        assert "Lucy" not in response.text and "Iain" not in response.text
    status = pilot.client.get("/api/me/physician/status", headers=_h("user-c")).json()
    assert status["has_claim"] is False and status["provider_identity"] is None


# ------------------------------------------------------------------------- database


def _raw(store: WorkflowStore) -> sqlite3.Connection:
    db = sqlite3.connect(store.path)
    db.row_factory = sqlite3.Row
    return db


def test_database_enforces_ownership_invariants(pilot: Harness) -> None:
    scope = pilot.onboard("user-a", NPI_A, approve=False)
    now = "2026-01-01T00:00:00+00:00"
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO provider_claims(auth_user_id, npi, status, claimed_at, updated_at)"
            " VALUES ('user-b', ?, 'claimed', ?, ?)", (NPI_A, now, now))
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="account"):
        db.execute(
            "INSERT INTO provider_claims(auth_user_id, npi, status, claimed_at, updated_at)"
            " VALUES ('user-a', ?, 'claimed', ?, ?)", (NPI_B, now, now))
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        db.execute("UPDATE provider_claims SET npi=? WHERE auth_user_id='user-a'", (NPI_B,))
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        db.execute("UPDATE physician_owner_scopes SET npi=? WHERE id=?", (NPI_B, scope["id"]))
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        db.execute("UPDATE physician_owner_scopes SET auth_user_id='user-b' WHERE id=?",
                   (scope["id"],))
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="match"):
        db.execute(
            """INSERT INTO physician_owner_scopes(id, provider_claim_id, auth_user_id, npi,
                 storage_scope_id, physician_id, provider_identity_json, created_at, updated_at)
               VALUES ('pos-x', ?, 'user-b', ?, 's-x', 'p-x', '{}', ?, ?)""",
            (scope["provider_claim_id"], NPI_A, now, now))
    # Approval without a confirmed identity is refused by the database itself.
    with _raw(pilot.store) as db:
        db.execute("UPDATE provider_claims SET identity_confirmed_at=NULL")
    with _raw(pilot.store) as db, pytest.raises(sqlite3.IntegrityError, match="confirmed"):
        db.execute("UPDATE physician_owner_scopes SET pilot_access_status='approved'")


def test_migration_from_previous_schema_keeps_legacy_claims_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript(
            """
            CREATE TABLE provider_claims (
              id INTEGER PRIMARY KEY AUTOINCREMENT, auth_user_id TEXT NOT NULL,
              npi TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN (
                'claimed', 'verification_pending', 'verified', 'rejected', 'revoked')),
              claimed_at TEXT NOT NULL, verification_submitted_at TEXT, verified_at TEXT,
              updated_at TEXT NOT NULL, verification_method TEXT
            );
            CREATE TABLE physician_owner_scopes (
              id TEXT PRIMARY KEY, provider_claim_id INTEGER NOT NULL UNIQUE,
              auth_user_id TEXT NOT NULL, npi TEXT NOT NULL,
              storage_scope_id TEXT NOT NULL UNIQUE, physician_id TEXT NOT NULL UNIQUE,
              provider_identity_json TEXT NOT NULL,
              publication_status TEXT NOT NULL DEFAULT 'private'
                CHECK(publication_status IN ('private', 'published', 'unpublished')),
              clinical_access INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              FOREIGN KEY(provider_claim_id) REFERENCES provider_claims(id)
            );
            INSERT INTO provider_claims VALUES
              (1, 'user-a', '1234567893', 'claimed', '2026-01-01', NULL, NULL, '2026-01-01', NULL);
            INSERT INTO physician_owner_scopes VALUES
              ('pos-legacy', 1, 'user-a', '1234567893', 'physician-owner-legacy',
               'claimed-physician-legacy', '{"display_name":"JANE SMITH, MD","npi":"1234567893"}',
               'private', 0, 1, '2026-01-01', '2026-01-01');
            """
        )
    store = WorkflowStore(path)
    WorkflowStore(path)  # Re-running the migration is a no-op.
    legacy = store.selected_physician_owner_scope("user-a")
    assert legacy["pilot_access_status"] == "pending"
    assert store.provider_claim(1)["identity_confirmed_at"] is None

    transport = FakeTransport()
    service = PhysicianOnboardingService(store, NppesIdentityResolver(transport, cache_seconds=0))
    monkeypatch.setattr(onboarding_api, "onboarding_service", service)
    network = ProviderNetwork(_empty_directory(tmp_path / "nppes.sqlite"), store, False)
    monkeypatch.setattr(sandbox_api, "sandbox_service", PhysicianSandboxService(store, network))
    monkeypatch.setenv("LAMINA_PILOT_ADMIN_USER_IDS", "admin")
    app.dependency_overrides[get_token_verifier] = lambda: FakeVerifier()
    try:
        client = TestClient(app)
        blocked = client.get("/api/me/physician/profile", headers=_h("user-a"))
        assert blocked.status_code == 403
        assert blocked.json()["detail"]["code"] == "physician_identity_required"
        status = client.get("/api/me/onboarding/status", headers=_h("user-a")).json()
        assert status["status"] == "identity_selected"
        assert status["selection"]["legacy_claim"] is True
        assert status["allowed_actions"] == ["confirm_identity"]
        # An unconfirmed legacy scope cannot be approved.
        assert client.post("/api/internal/pilot-physicians/pos-legacy/approve",
                           headers=_h("admin")).status_code == 409
        confirmed = client.post("/api/me/onboarding/identity/confirm", headers=_h("user-a"),
                                json={"npi": NPI_A})
        assert confirmed.json()["status"] == "pilot_approval_pending"
        upgraded = store.selected_physician_owner_scope("user-a")
        assert upgraded["id"] == "pos-legacy"
        assert upgraded["storage_scope_id"] == "physician-owner-legacy", "data continuity"
        assert upgraded["nppes_snapshot"]["npi"] == NPI_A
        assert store.provider_claim(1)["status"] == "verification_pending"
        assert client.post("/api/internal/pilot-physicians/pos-legacy/approve",
                           headers=_h("admin")).status_code == 200
        assert client.get("/api/me/physician/profile", headers=_h("user-a")).status_code == 200
    finally:
        app.dependency_overrides.clear()


# --------------------------------------------------------------------- normalization


def test_npi_checksum_and_record_normalization_edges() -> None:
    assert npi_checksum_valid("1234567893") and not npi_checksum_valid("1234567890")
    fetched = "2026-01-01T00:00:00+00:00"
    with pytest.raises(DirectoryMalformedResponseError):
        normalize_nppes_record({**RECORDS[NPI_A], "number": NPI_B}, NPI_A, fetched)
    with pytest.raises(DirectoryMalformedResponseError):
        normalize_nppes_record({**RECORDS[NPI_A], "taxonomies": "x"}, NPI_A, fetched)
    nameless = {**RECORDS[NPI_A], "basic": {"status": "A"}}
    with pytest.raises(DirectoryMalformedResponseError):
        normalize_nppes_record(nameless, NPI_A, fetched)
    no_taxonomy = normalize_nppes_record({**RECORDS[NPI_A], "taxonomies": []}, NPI_A, fetched)
    assert no_taxonomy.primary_specialty is None
    assert no_taxonomy.provider_identity()["specialty"] == "Physician"


def test_resolver_caches_successes_but_not_failures() -> None:
    transport = FakeTransport()
    resolver = NppesIdentityResolver(transport, cache_seconds=600)
    resolver.lookup(NPI_A)
    resolver.lookup(NPI_A)
    assert transport.calls == 1
    transport.mode = "down"
    with pytest.raises(Exception, match="not available"):
        resolver.lookup(NPI_B)
    transport.mode = "ok"
    resolver.lookup(NPI_B)
    assert transport.calls == 3
