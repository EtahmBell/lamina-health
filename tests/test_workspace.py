"""Offline checks for Lamina workflow recency and inspectable demo agent."""

import pytest
from fastapi.testclient import TestClient

from backend.agents import consult_network
from backend.api import consult as consult_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.synthetic_data import (
    MARIA_PATIENT_ID,
    MARIA_PHYSICIANS,
    PATIENTS,
    PHYSICIANS,
    PRIMARY_PATIENT_ID,
)
from backend.workflow import WorkflowStore


@pytest.fixture
def client(tmp_path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return TestClient(app)


def test_agent_profile_and_suggestion_provenance(client: TestClient):
    response = client.get("/api/workspace/agent")
    assert response.status_code == 200
    agent = response.json()
    assert agent["physician"] == "Dr. Lucy Saru"
    assert agent["status"] == "active"
    assert agent["synthetic"] is True
    assert agent["learnings"][0]["status"] == "suggested"
    assert "not confirmed" in agent["learnings"][0]["provenance"]
    assert agent["access"][-2]["detail"] == "Not connected"


def test_confirm_edit_and_reject_learning_are_local_and_inspectable(client: TestClient):
    confirmed = client.put("/api/workspace/agent/learnings/renal", json={"action": "confirm"})
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "confirmed"
    assert "Physician-confirmed" in confirmed.json()["provenance"]
    edited = client.put("/api/workspace/agent/learnings/renal", json={
        "action": "edit", "statement": "My corrected synthetic referral preference",
    })
    assert edited.json()["status"] == "suggested"
    assert edited.json()["statement"] == "My corrected synthetic referral preference"
    rejected = client.put("/api/workspace/agent/learnings/anaemia", json={"action": "reject"})
    assert rejected.json()["status"] == "rejected"
    assert {item["status"] for item in client.get("/api/workspace/agent").json()["learnings"]} == {
        "suggested", "rejected",
    }
    assert client.put("/api/workspace/agent/learnings/renal", json={
        "action": "edit", "statement": "",
    }).status_code == 422


def test_activity_and_saved_consultation_history(client: TestClient):
    initial = {item["patient_id"]: item for item in client.get("/api/workspace/activity").json()}
    assert initial[PRIMARY_PATIENT_ID]["consultation_count"] == 0
    assert initial[PRIMARY_PATIENT_ID]["last_opened"] is None
    assert client.get(f"/api/patients/{PRIMARY_PATIENT_ID}").status_code == 200
    opened = {item["patient_id"]: item for item in client.get("/api/workspace/activity").json()}
    assert opened[PRIMARY_PATIENT_ID]["last_opened"]
    assert not client.get("/api/workspace/consultations").json()

    jordan = client.post(f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={})
    maria = client.post(f"/api/patients/{MARIA_PATIENT_ID}/consultations", json={})
    assert jordan.status_code == maria.status_code == 200
    assert jordan.json()["recommended_physician"]["physician_name"] == "Dr. Iain Jung (synthetic)"
    assert jordan.json()["recommended_physician"]["specialty"] == "Nephrology"
    assert any("BMP" in item for item in jordan.json()["before_referral"])
    assert any("UPCR" in item for item in jordan.json()["before_referral"])
    assert maria.json()["recommended_physician"]["specialty"] == "Gastroenterology"
    records = client.get("/api/workspace/consultations").json()
    assert [item["patient_id"] for item in records] == [MARIA_PATIENT_ID, PRIMARY_PATIENT_ID]
    assert records[1]["result"]["consultation_id"] == jordan.json()["consultation_id"]
    assert client.get(f"/api/workspace/consultations/{records[1]['id']}").json()["result"] == jordan.json()
    assert client.get("/api/workspace/consultations/99999").status_code == 404
    final = {item["patient_id"]: item for item in client.get("/api/workspace/activity").json()}
    assert final[PRIMARY_PATIENT_ID]["consultation_count"] == 1
    assert final[PRIMARY_PATIENT_ID]["last_started"]
    assert final[MARIA_PATIENT_ID]["last_consultation"]


def test_synthetic_names_do_not_change_clinical_result():
    jordan = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)
    maria = consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS)
    assert jordan.recommended_physician.physician_name == "Dr. Iain Jung (synthetic)"
    assert "Matthew Onadeko" in jordan.alternatives[0].physician_name
    assert any("Celeste Bell" in item.physician_name for item in jordan.consultation)
    assert maria.recommended_physician.specialty == "Gastroenterology"
