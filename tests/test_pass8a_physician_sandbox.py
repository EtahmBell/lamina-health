from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

from backend.api import physician_sandbox as sandbox_api
from backend.auth import AuthenticatedUser, AuthenticationError, get_token_verifier
from backend.main import app
from backend.physician_sandbox import PhysicianSandboxService
from backend.professional_services import profile_enrichment_service
from backend.provider_network import api as provider_api
from backend.provider_network.directory import NppesDirectory
from backend.provider_network.service import ProviderNetwork
from backend.workflow import WorkflowStore


class FakeVerifier:
    users: ClassVar = {"token-user-a": "user-a", "token-user-b": "user-b"}

    def verify(self, token: str) -> AuthenticatedUser:
        if user := self.users.get(token):
            return AuthenticatedUser(id=user)
        raise AuthenticationError("invalid")


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
            INSERT INTO physicians VALUES
              ('1234567890', 'JANE SMITH, MD', 'Nephrology Physician',
               '207RN0300X', 'Bay Kidney Group', 'PALO ALTO', 'CA',
               '6505550100', 1, 'NPPES', 'JANE', 'SMITH'),
              ('1234567891', 'JOHN DOE, MD', 'Cardiology Physician',
               '207RC0000X', 'Bay Heart Group', 'OAKLAND', 'CA',
               '5105550100', 1, 'NPPES', 'JOHN', 'DOE');
            INSERT INTO agents VALUES ('1234567890', 'reserved'), ('1234567891', 'reserved');
            INSERT INTO physician_fts VALUES
              ('1234567890', 'JANE SMITH, MD', 'Nephrology Physician', 'PALO ALTO', 'CA'),
              ('1234567891', 'JOHN DOE, MD', 'Cardiology Physician', 'OAKLAND', 'CA');
            """
        )
    return NppesDirectory(path)


@pytest.fixture
def sandbox_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    network = ProviderNetwork(_directory(tmp_path / "providers.sqlite"), store, False)
    service = PhysicianSandboxService(store, network)
    monkeypatch.setattr(provider_api, "provider_network", network)
    monkeypatch.setattr(sandbox_api, "sandbox_service", service)
    app.dependency_overrides[get_token_verifier] = lambda: FakeVerifier()
    try:
        yield TestClient(app), store
    finally:
        app.dependency_overrides.clear()


def test_auth_no_claim_and_claim_bootstrap_are_private_and_idempotent(sandbox_client) -> None:
    client, store = sandbox_client
    assert client.get("/api/me/physician/status").status_code == 401
    no_claim = client.get("/api/me/physician/status", headers=_headers("user-a"))
    assert no_claim.json()["has_claim"] is False

    first = client.post("/api/providers/1234567890/claim", headers=_headers("user-a"))
    repeat = client.post("/api/providers/1234567890/claim", headers=_headers("user-a"))
    assert first.json()["id"] == repeat.json()["id"]
    assert len(store.physician_owner_scopes("user-a")) == 1
    conflict = client.post("/api/providers/1234567890/claim", headers=_headers("user-b"))
    assert conflict.status_code == 409
    assert "user-a" not in conflict.text

    status = client.get("/api/me/physician/status", headers=_headers("user-a")).json()
    assert status["publication_status"] == "private"
    assert status["clinical_access_status"] == "unavailable"
    assert status["capabilities"]["can_train_agent"] is True
    assert status["capabilities"]["can_publish_posts"] is False
    assert status["provider_identity"]["display_name"] == "JANE SMITH, MD"


def test_owner_profile_training_chat_and_drafts_persist_and_are_isolated(sandbox_client) -> None:
    client, store = sandbox_client
    client.post("/api/providers/1234567890/claim", headers=_headers("user-a"))
    client.post("/api/providers/1234567891/claim", headers=_headers("user-b"))

    profile_item = {
        "category": "about",
        "title": "Kidney specialist",
        "detail": "Physician-confirmed professional summary.",
        "shareable": True,
    }
    assert (
        client.put(
            "/api/me/physician/profile/items/about-me",
            headers=_headers("user-a"),
            json=profile_item,
        ).status_code
        == 200
    )
    interest = {
        "interest_type": "case_interest",
        "title": "Progressive kidney disease",
        "detail": "Professional preference, not an acceptance rule.",
        "confirmed": True,
        "shareable": True,
    }
    client.post("/api/me/physician/interests", headers=_headers("user-a"), json=interest)
    assert client.get("/api/me/physician/profile", headers=_headers("user-b")).json()["items"] == []
    assert client.get("/api/me/physician/interests", headers=_headers("user-b")).json() == []

    session = client.post(
        "/api/me/physician/training/sessions",
        headers=_headers("user-a"),
        json={"mode": "initialization"},
    ).json()
    assert session["answer_target"] == 10
    assert len(session["questions"]) == 10
    for question in session["questions"]:
        response = client.put(
            f"/api/me/physician/training/sessions/{session['id']}/responses/{question['id']}",
            headers=_headers("user-a"),
            json={"answer": "Yes"},
        )
        assert response.status_code == 200
    status = client.get("/api/me/physician/status", headers=_headers("user-a")).json()
    assert status["initialized"] is True

    projection = client.get("/api/me/physician/training", headers=_headers("user-a")).json()
    assert projection["state"] == "review_pending"
    scope_a = store.selected_physician_owner_scope("user-a")
    scope_b = store.selected_physician_owner_scope("user-b")
    assert scope_a["storage_scope_id"] != scope_b["storage_scope_id"]
    assert store.training_sessions(scope_b["storage_scope_id"], scope_b["physician_id"]) == []

    learning = store.proposed_learnings(scope_a["storage_scope_id"], scope_a["physician_id"])[0]
    client.put(
        f"/api/me/physician/training/learnings/{learning['id']}",
        headers=_headers("user-a"),
        json={"action": "confirm"},
    )
    representation = client.get(
        "/api/me/physician/practice-representation", headers=_headers("user-a")
    ).json()
    assert representation["sections"]["confirmed_learnings"]

    chat = client.post(
        "/api/me/physician/agent-chat",
        headers=_headers("user-a"),
        json={
            "mode": "synthetic_case",
            "message": "How would I handle this?",
            "controlled_test_case_id": "owner-test-fit",
            "origin": "synthetic_demo",
        },
    ).json()
    feedback = client.post(
        f"/api/me/physician/agent-chat/{chat['response_id']}/feedback",
        headers=_headers("user-a"),
        json={"feedback": "not_quite"},
    ).json()
    assert feedback["focused_training_seed"]["status"] == "pending"
    focused = client.post(
        "/api/me/physician/training/focused",
        headers=_headers("user-a"),
        json={"seed_id": feedback["focused_training_seed"]["seed_id"], "answer_target": 10},
    ).json()
    focused_answer = client.put(
        f"/api/me/physician/training/sessions/{focused['id']}/responses/{focused['questions'][0]['id']}",
        headers=_headers("user-a"),
        json={"answer": "Yes"},
    ).json()
    assert focused_answer["questions_complete"] is True

    post = client.post(
        "/api/me/physician/posts/draft",
        headers=_headers("user-a"),
        json={
            "type": "referral_guidance",
            "source_material": {"guidance": "Please include relevant trends."},
        },
    ).json()
    assert post["status"] == "draft"
    assert post["authored_by"] == "physician"
    assert post["drafted_by"] == "lamina_agent"
    assert post["physician_approved"] is False
    assert post["visibility"] == "private"
    publish = client.post(
        f"/api/me/physician/posts/{post['id']}/publish", headers=_headers("user-a")
    )
    assert publish.status_code == 409
    assert (
        store.practice_updates(scope_a["storage_scope_id"], scope_a["physician_id"], "published")
        == []
    )


def test_owner_sandbox_rejects_patient_data_and_arbitrary_cross_owner_ids(sandbox_client) -> None:
    client, store = sandbox_client
    claim_a = client.post("/api/providers/1234567890/claim", headers=_headers("user-a")).json()
    claim_b = client.post("/api/providers/1234567891/claim", headers=_headers("user-b")).json()
    assert (
        client.put(
            f"/api/me/physician/selection/{claim_b['id']}", headers=_headers("user-a")
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/me/physician/selection/{claim_a['id']}", headers=_headers("user-a")
        ).status_code
        == 200
    )
    rejected = client.post(
        "/api/me/physician/agent-chat",
        headers=_headers("user-a"),
        json={
            "mode": "practice_question",
            "message": "Patient DOB is 1/2/1980",
            "origin": "real_patient",
        },
    )
    assert rejected.status_code == 422
    assert "patient" in rejected.text.casefold()
    tables = {
        row[0]
        for row in sqlite3.connect(store.path).execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    assert "physician_owner_scopes" in tables


def test_verified_real_claim_remains_private_until_separate_publication(
    sandbox_client,
) -> None:
    client, store = sandbox_client
    claim = client.post("/api/providers/1234567890/claim", headers=_headers("user-a")).json()
    store.submit_provider_verification(claim["id"], "user-a")
    store.verify_provider_claim(claim["id"], "user-a", "manual_test")
    activation = client.post(
        f"/api/provider-claims/{claim['id']}/activate-agent",
        headers=_headers("user-a"),
    )
    assert activation.status_code == 409
    assert "private" in activation.text.casefold()
    state = client.get("/api/me/physician/status", headers=_headers("user-a")).json()
    assert state["verification_status"] == "verified"
    assert state["publication_status"] == "private"
    assert state["clinical_access_status"] == "unavailable"


def test_real_enrichment_is_review_first_and_preserves_provenance(
    sandbox_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = sandbox_client
    client.post("/api/providers/1234567890/claim", headers=_headers("user-a"))
    monkeypatch.setattr(profile_enrichment_service.client, "enabled", True)
    monkeypatch.setattr(profile_enrichment_service.client, "model", "test-model")
    monkeypatch.setattr(profile_enrichment_service.client, "api_key", "test-only")
    monkeypatch.setattr(
        profile_enrichment_service,
        "public_candidates",
        lambda identity: [
            {
                "candidate_id": "public-1",
                "category": "teaching",
                "proposed_title": "Public teaching role",
                "proposed_detail": "Candidate only.",
                "source_type": "public_web",
                "source_title": "Institution directory",
                "source_url": "https://example.test/faculty",
                "retrieved_at": "2026-10-07T00:00:00+00:00",
                "model_generated_summary": True,
                "confidence": "high",
            }
        ],
    )
    enriched = client.post("/api/me/physician/profile/enrich", headers=_headers("user-a")).json()
    assert enriched["candidates"][0]["review_status"] == "suggested"
    before = client.get("/api/me/physician/profile", headers=_headers("user-a")).json()
    assert before["sections"]["teaching"] == []
    reviewed = client.put(
        "/api/me/physician/profile/enrichment/candidates/public-1",
        headers=_headers("user-a"),
        json={"action": "confirm", "shareable": True},
    ).json()
    assert reviewed["candidate"]["source_title"] == "Institution directory"
    assert reviewed["profile_item"]["provenance"].startswith("confirmed_enrichment:")
