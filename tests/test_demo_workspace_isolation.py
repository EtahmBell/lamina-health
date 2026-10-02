"""Two independent visitors share source facts and identity, never mutable demo state."""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.synthetic_data import PRIMARY_PATIENT_ID
from backend.workflow import WorkflowStore

JUNG_NPI = "9900000001"


@pytest.fixture
def isolated_app(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return store


def test_two_visitors_are_isolated_end_to_end(isolated_app: WorkflowStore) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        facts_a = visitor_a.get(f"/api/patients/{PRIMARY_PATIENT_ID}")
        facts_b = visitor_b.get(f"/api/patients/{PRIMARY_PATIENT_ID}")
        assert facts_a.json() == facts_b.json(), "clinical source facts are shared and immutable"
        assert visitor_a.cookies.get("lamina_demo_workspace")
        assert visitor_b.cookies.get("lamina_demo_workspace")
        assert visitor_a.cookies.get("lamina_demo_workspace") != visitor_b.cookies.get(
            "lamina_demo_workspace"
        )

        consultation_a = visitor_a.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={}
        )
        assert consultation_a.status_code == 200
        record_a = visitor_a.get("/api/workspace/consultations").json()[0]
        assert visitor_b.get("/api/workspace/consultations").json() == []
        assert visitor_b.get(
            f"/api/workspace/consultations/{record_a['id']}"
        ).status_code == 404

        assert visitor_a.post(
            "/api/workspace/network/members", json={"npi": JUNG_NPI}
        ).status_code == 201
        assert visitor_a.put(
            "/api/workspace/agent/learnings/renal", json={"action": "confirm"}
        ).status_code == 200
        assert visitor_b.get("/api/workspace/network/members").json() == []
        renal_b = next(
            item
            for item in visitor_b.get("/api/workspace/agent").json()["learnings"]
            if item["key"] == "renal"
        )
        assert renal_b["status"] == "suggested"
        assert visitor_b.get("/api/workspace/network").json()["record_count"] == 0

        assert visitor_b.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={}
        ).status_code == 200
        assert visitor_a.post("/api/workspace/demo/reset/jordan").json()[
            "remaining_consultations"
        ] == 0
        assert visitor_a.get("/api/workspace/consultations").json() == []
        assert len(visitor_b.get("/api/workspace/consultations").json()) == 1


def test_cookie_loss_creates_fresh_workspace_without_touching_identity(
    isolated_app: WorkflowStore,
) -> None:
    claim, conflict = isolated_app.claim_provider("auth-user-a", JUNG_NPI)
    assert conflict is False
    isolated_app.save_provider_agent_preferences(JUNG_NPI, True, {"notes": "global"})

    with TestClient(app) as client:
        first = client.get("/api/patients")
        first_cookie = client.cookies.get("lamina_demo_workspace")
        assert "HttpOnly" in first.headers["set-cookie"]
        assert "SameSite=lax" in first.headers["set-cookie"]
        client.post(f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={})
        client.cookies.clear()
        second = client.get("/api/patients")
        assert second.status_code == 200
        assert client.cookies.get("lamina_demo_workspace") != first_cookie
        assert client.get("/api/workspace/consultations").json() == []

    assert isolated_app.active_provider_claim(JUNG_NPI)["id"] == claim["id"]
    assert isolated_app.provider_agent_state(JUNG_NPI)["preferences"]["notes"] == "global"


def test_valid_cookie_is_reused_and_invalid_cookie_is_replaced(
    isolated_app: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        client.get("/api/patients")
        workspace_id = client.cookies.get("lamina_demo_workspace")
        assert workspace_id
        second = client.get("/api/patients")
        assert client.cookies.get("lamina_demo_workspace") == workspace_id
        assert "set-cookie" not in second.headers

    with TestClient(app) as invalid_client:
        invalid_client.cookies.set(
            "lamina_demo_workspace",
            "caller-controlled-invalid",
            domain="testserver.local",
            path="/",
        )
        response = invalid_client.get("/api/patients")
        assert response.status_code == 200
        replacement = invalid_client.cookies.get(
            "lamina_demo_workspace", domain="testserver.local", path="/"
        )
        assert replacement != "caller-controlled-invalid"
        assert len(replacement) >= 40


def test_cross_origin_demo_mutation_is_rejected(isolated_app: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations",
            json={},
            headers={"Origin": "https://attacker.invalid"},
        )
        assert response.status_code == 403
        assert client.get("/api/workspace/consultations").json() == []
        assert client.get(
            f"/api/patients/{PRIMARY_PATIENT_ID}",
            headers={"Sec-Fetch-Site": "cross-site"},
        ).status_code == 403


def test_explicitly_allowed_origin_can_mutate_across_sites(
    isolated_app: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        response = client.post(
            f"/api/patients/{PRIMARY_PATIENT_ID}/consultations",
            json={},
            headers={
                "Origin": "http://localhost:5173",
                "Sec-Fetch-Site": "cross-site",
            },
        )
        assert response.status_code == 200


def test_credentialed_cors_is_explicit(isolated_app: WorkflowStore) -> None:
    with TestClient(app) as client:
        allowed = client.options(
            "/api/workspace/activity",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert allowed.headers["access-control-allow-credentials"] == "true"

        denied = client.options(
            "/api/workspace/activity",
            headers={
                "Origin": "https://attacker.invalid",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert denied.status_code == 400
        assert denied.headers.get("access-control-allow-origin") is None


def test_production_cookie_is_secure_and_cross_site_capable(
    isolated_app: WorkflowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LAMINA_DEMO_COOKIE_SECURE", "true")
    monkeypatch.setenv("LAMINA_DEMO_COOKIE_SAMESITE", "none")
    with TestClient(app, base_url="https://api.lamina.test") as client:
        cookie = client.get("/api/patients").headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=none" in cookie


def test_expired_workspace_cleanup_removes_only_demo_state(
    isolated_app: WorkflowStore,
) -> None:
    workspace_id, _ = isolated_app.resolve_demo_workspace(None, 3600)
    isolated_app.add_network_member(workspace_id, JUNG_NPI)
    claim, _ = isolated_app.claim_provider("auth-user-a", JUNG_NPI)
    with sqlite3.connect(isolated_app.path) as database:
        database.execute(
            "UPDATE demo_workspaces SET expires_at=? WHERE workspace_id=?",
            ("2000-01-01T00:00:00+00:00", workspace_id),
        )

    assert isolated_app.cleanup_expired_demo_workspaces() == 1
    assert isolated_app.network_members(workspace_id) == []
    assert isolated_app.active_provider_claim(JUNG_NPI)["id"] == claim["id"]
