from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from backend.auth import (
    AuthenticatedUser,
    AuthenticationError,
    SupabaseTokenVerifier,
    get_token_verifier,
)
from backend.main import app
from backend.provider_network import api as provider_api
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.lifecycle import project_lifecycle
from backend.provider_network.models import AgentStatus
from backend.provider_network.service import ProviderNetwork
from backend.synthetic_data import SYNTHETIC_PHYSICIAN_NPIS
from backend.workflow import WorkflowStore

REAL_NPI = "1234567890"
SYNTHETIC_NPI = SYNTHETIC_PHYSICIAN_NPIS["physician-jung"]


class FakeVerifier:
    users: ClassVar = {"token-user-a": "user-a", "token-user-b": "user-b"}

    def verify(self, token: str) -> AuthenticatedUser:
        user_id = self.users.get(token)
        if not user_id:
            raise AuthenticationError("invalid")
        return AuthenticatedUser(id=user_id)


def _headers(user: str) -> dict[str, str]:
    return {"Authorization": f"Bearer token-{user}"}


def _directory(path: Path) -> NppesDirectory:
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
            INSERT INTO physicians VALUES (
              '1234567890', 'JANE SMITH, MD', 'Nephrology Physician',
              '207RN0300X', 'Bay Kidney Group', 'PALO ALTO', 'CA',
              '6505550100', 1, 'NPPES', 'JANE', 'SMITH'
            );
            INSERT INTO agents VALUES ('1234567890', 'reserved');
            INSERT INTO physician_fts VALUES (
              '1234567890', 'JANE SMITH, MD', 'Nephrology Physician', 'PALO ALTO', 'CA'
            );
            """
        )
    return NppesDirectory(path)


@pytest.fixture
def claim_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    network = ProviderNetwork(_directory(tmp_path / "providers.sqlite"), store, False)
    monkeypatch.setattr(provider_api, "provider_network", network)
    app.dependency_overrides[get_token_verifier] = lambda: FakeVerifier()
    try:
        yield TestClient(app), network, store
    finally:
        app.dependency_overrides.clear()


def test_protected_claim_endpoint_requires_a_valid_token(claim_client) -> None:
    client, _, _ = claim_client
    assert client.post(f"/api/providers/{REAL_NPI}/claim").status_code == 401
    assert client.post(
        f"/api/providers/{REAL_NPI}/claim",
        headers={"Authorization": "Bearer invalid"},
    ).status_code == 401

    response = client.post(
        f"/api/providers/{REAL_NPI}/claim", headers=_headers("user-a")
    )
    assert response.status_code == 200
    assert response.json()["status"] == "claimed"


def test_claims_are_idempotent_unique_and_private(claim_client) -> None:
    client, _, _ = claim_client
    first = client.post(
        f"/api/providers/{REAL_NPI}/claim", headers=_headers("user-a")
    )
    repeat = client.post(
        f"/api/providers/{REAL_NPI}/claim", headers=_headers("user-a")
    )
    assert first.json()["id"] == repeat.json()["id"]

    conflict = client.post(
        f"/api/providers/{REAL_NPI}/claim", headers=_headers("user-b")
    )
    assert conflict.status_code == 409
    assert "user-a" not in conflict.text

    public = client.get(f"/api/providers/{REAL_NPI}/claim-state")
    assert public.json() == {
        "npi": REAL_NPI,
        "synthetic": False,
        "lifecycle_status": "claimed",
        "claimable": False,
        "agent_active": False,
        "claimed_by_me": False,
        "my_claim_id": None,
        "my_claim_status": None,
    }
    assert "auth_user_id" not in public.text
    assert "verification_method" not in public.text

    owner = client.get(
        f"/api/providers/{REAL_NPI}/claim-state", headers=_headers("user-a")
    ).json()
    assert owner["claimed_by_me"] is True
    assert owner["my_claim_id"] == first.json()["id"]
    assert client.get(
        "/api/me/provider-claims", headers=_headers("user-b")
    ).json() == []
    assert client.post(
        "/api/providers/0000000000/claim", headers=_headers("user-a")
    ).status_code == 404


def test_real_nppes_claim_stops_at_verification_pending(claim_client) -> None:
    client, network, _ = claim_client
    claim = client.post(
        f"/api/providers/{REAL_NPI}/claim", headers=_headers("user-a")
    ).json()
    path = f"/api/provider-claims/{claim['id']}"

    assert client.post(
        f"{path}/submit-verification", headers=_headers("user-b")
    ).status_code == 404
    submitted = client.post(
        f"{path}/submit-verification", headers=_headers("user-a")
    )
    assert submitted.json()["status"] == "verification_pending"
    assert submitted.json()["verification_submitted_at"]

    network.demo_verification_enabled = True
    rejected = client.post(f"{path}/verify-demo", headers=_headers("user-a"))
    assert rejected.status_code == 403
    assert "production physician verification" in rejected.json()["detail"]
    assert client.post(
        f"{path}/activate-agent", headers=_headers("user-a")
    ).status_code == 409


def test_synthetic_verification_flag_and_persistent_activation(claim_client) -> None:
    client, network, store = claim_client
    claim = client.post(
        f"/api/providers/{SYNTHETIC_NPI}/claim", headers=_headers("user-a")
    ).json()
    path = f"/api/provider-claims/{claim['id']}"

    assert client.post(
        f"{path}/activate-agent", headers=_headers("user-a")
    ).status_code == 409
    client.post(f"{path}/submit-verification", headers=_headers("user-a"))
    assert client.post(
        f"{path}/verify-demo", headers=_headers("user-a")
    ).status_code == 403

    network.demo_verification_enabled = True
    verified = client.post(f"{path}/verify-demo", headers=_headers("user-a"))
    assert verified.status_code == 200
    assert verified.json()["verification_method"] == "synthetic_demo"

    preferences = {
        "practice_confirmed": True,
        "areas_of_focus": ["Progressive CKD"],
        "cases_accepted": ["Stage 3–4 CKD"],
        "cases_redirected": [],
        "preferred_pre_referral_workup": ["BMP", "UPCR"],
        "notes": "Synthetic demo preference.",
    }
    assert client.put(
        f"/api/providers/{SYNTHETIC_NPI}/preferences",
        headers=_headers("user-b"),
        json=preferences,
    ).status_code == 404
    assert client.put(
        f"/api/providers/{SYNTHETIC_NPI}/preferences",
        headers=_headers("user-a"),
        json=preferences,
    ).status_code == 200

    assert client.post(
        f"{path}/activate-agent", headers=_headers("user-b")
    ).status_code == 404
    activated = client.post(f"{path}/activate-agent", headers=_headers("user-a"))
    assert activated.json()["lifecycle_status"] == "active"
    first_activated_at = store.provider_agent_state(SYNTHETIC_NPI)["activated_at"]
    assert client.post(
        f"{path}/activate-agent", headers=_headers("user-a")
    ).json()["lifecycle_status"] == "active"
    assert store.provider_agent_state(SYNTHETIC_NPI)["activated_at"] == first_activated_at

    restarted = ProviderNetwork(network.directory, WorkflowStore(store.path), True)
    assert restarted.get(SYNTHETIC_NPI).lifecycle_status == AgentStatus.ACTIVE
    assert restarted.get(SYNTHETIC_NPI).agent.preferences.areas_of_focus == [
        "Progressive CKD"
    ]
    monkeypatch_target = provider_api.provider_network
    provider_api.provider_network = restarted
    try:
        assert client.post(
            f"{path}/disable-agent", headers=_headers("user-b")
        ).status_code == 404
        disabled = client.post(f"{path}/disable-agent", headers=_headers("user-a"))
        assert disabled.json()["lifecycle_status"] == "disabled"
        assert ProviderNetwork(
            network.directory, WorkflowStore(store.path), True
        ).get(SYNTHETIC_NPI).lifecycle_status == AgentStatus.DISABLED
        reactivated = client.post(f"{path}/activate-agent", headers=_headers("user-a"))
        assert reactivated.json()["lifecycle_status"] == "active"
    finally:
        provider_api.provider_network = monkeypatch_target


def test_canonical_lifecycle_projection() -> None:
    assert project_lifecycle(None, None) == AgentStatus.RESERVED
    assert project_lifecycle({"status": "claimed"}, None) == AgentStatus.CLAIMED
    assert project_lifecycle(
        {"status": "verification_pending"}, None
    ) == AgentStatus.VERIFICATION_PENDING
    assert project_lifecycle({"status": "verified"}, None) == AgentStatus.VERIFIED
    assert project_lifecycle({"status": "verified"}, {"status": "active"}) == AgentStatus.ACTIVE
    assert project_lifecycle({"status": "verified"}, {"status": "disabled"}) == AgentStatus.DISABLED


def test_schema_upgrade_preserves_existing_workflow_rows(tmp_path: Path) -> None:
    database = tmp_path / "legacy-workflow.sqlite"
    with sqlite3.connect(database) as db:
        db.executescript(
            """
            CREATE TABLE patient_activity (
              patient_id TEXT PRIMARY KEY, last_opened TEXT,
              last_consultation TEXT, consultation_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE consultations (
              id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL,
              completed_at TEXT NOT NULL, result_json TEXT NOT NULL
            );
            CREATE TABLE agent_preferences (
              key TEXT PRIMARY KEY, statement TEXT NOT NULL,
              provenance TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE network_members (npi TEXT PRIMARY KEY, added_at TEXT NOT NULL);
            INSERT INTO network_members VALUES ('9900000008', '2026-01-01T00:00:00+00:00');
            INSERT INTO agent_preferences VALUES (
              'renal', 'Keep existing preference', 'fixture', 'confirmed',
              '2026-01-01T00:00:00+00:00'
            );
            """
        )

    store = WorkflowStore(database)
    assert store.network_members(store.LEGACY_WORKSPACE_ID)[0]["npi"] == "9900000008"
    assert store.preferences(store.LEGACY_WORKSPACE_ID)[0]["statement"] == "Keep existing preference"
    with sqlite3.connect(database) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"provider_claims", "provider_agent_state"} <= tables


def test_supabase_verifier_checks_signature_issuer_expiry_and_audience_offline() -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    public_jwk.update({"kid": "test-key", "alg": "RS256", "use": "sig"})
    calls = 0

    def load_jwks():
        nonlocal calls
        calls += 1
        return {"keys": [public_jwk]}

    verifier = SupabaseTokenVerifier(
        issuer="https://example.supabase.co/auth/v1",
        jwks_url="https://unused.invalid/jwks",
        audience="authenticated",
        jwks_loader=load_jwks,
    )
    now = datetime.now(UTC)
    payload = {
        "sub": "auth-user-123",
        "iss": "https://example.supabase.co/auth/v1",
        "aud": "authenticated",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    token = jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": "test-key"})
    assert verifier.verify(token).id == "auth-user-123"
    assert verifier.verify(token).id == "auth-user-123"
    assert calls == 1, "the JWKS document should be cached"

    invalid_claims = [
        {**payload, "aud": "wrong"},
        {**payload, "iss": "https://attacker.invalid"},
        {**payload, "exp": now - timedelta(seconds=1)},
    ]
    for invalid_payload in invalid_claims:
        invalid_token = jwt.encode(
            invalid_payload,
            private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        with pytest.raises(AuthenticationError):
            verifier.verify(invalid_token)

    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = jwt.encode(
        payload, other_key, algorithm="RS256", headers={"kid": "test-key"}
    )
    with pytest.raises(AuthenticationError):
        verifier.verify(forged)
