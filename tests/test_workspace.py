"""Offline checks for Lamina workflow recency and inspectable demo agent."""

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
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
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
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
    assert final[PRIMARY_PATIENT_ID]["has_consultation"] is True
    assert final[PRIMARY_PATIENT_ID]["latest_consultation_id"] == records[1]["id"]
    assert final[PRIMARY_PATIENT_ID]["latest_consulted_at"] == records[1]["completed_at"]
    assert final[PRIMARY_PATIENT_ID]["latest_recommended_physician"].startswith("Dr. Iain Jung")
    assert final[PRIMARY_PATIENT_ID]["latest_recommended_specialty"] == "Nephrology"
    assert final[PRIMARY_PATIENT_ID]["last_started"]
    assert final[MARIA_PATIENT_ID]["last_consultation"]


def test_jordan_demo_reset_is_narrow_and_reconsultation_remains_append_only(
    client: TestClient,
):
    patient_before = client.get(f"/api/patients/{PRIMARY_PATIENT_ID}").json()
    client.post("/api/workspace/network/members", json={"npi": "9900000008"})
    client.put("/api/workspace/agent/learnings/renal", json={"action": "confirm"})

    first_jordan = client.post(f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={})
    maria = client.post(f"/api/patients/{MARIA_PATIENT_ID}/consultations", json={})
    second_jordan = client.post(f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={})
    assert first_jordan.status_code == maria.status_code == second_jordan.status_code == 200

    records_before = client.get("/api/workspace/consultations").json()
    jordan_records = [
        record for record in records_before if record["patient_id"] == PRIMARY_PATIENT_ID
    ]
    assert len(jordan_records) == 2, "a re-consult appends rather than overwrites"
    state_before = {
        item["patient_id"]: item for item in client.get("/api/workspace/activity").json()
    }
    assert state_before[PRIMARY_PATIENT_ID]["latest_consultation_id"] == jordan_records[0]["id"]

    reset = client.post("/api/workspace/demo/reset/jordan")
    assert reset.status_code == 200
    assert reset.json() == {
        "patient_id": PRIMARY_PATIENT_ID,
        "removed_consultations": 2,
        "remaining_consultations": 1,
        "reset_complete": True,
    }

    remaining = client.get("/api/workspace/consultations").json()
    assert [record["patient_id"] for record in remaining] == [MARIA_PATIENT_ID]
    state_after = {
        item["patient_id"]: item for item in client.get("/api/workspace/activity").json()
    }
    jordan_state = state_after[PRIMARY_PATIENT_ID]
    assert jordan_state["has_consultation"] is False
    assert jordan_state["consultation_count"] == 0
    assert jordan_state["latest_consultation_id"] is None
    assert jordan_state["latest_consulted_at"] is None
    assert jordan_state["latest_recommended_physician"] is None
    assert jordan_state["latest_recommended_specialty"] is None
    assert jordan_state["last_started"] is None
    assert state_after[MARIA_PATIENT_ID]["has_consultation"] is True

    assert client.get("/api/workspace/network/members").json()[0]["npi"] == "9900000008"
    renal = next(
        item for item in client.get("/api/workspace/agent").json()["learnings"]
        if item["key"] == "renal"
    )
    assert renal["status"] == "confirmed", "physician preferences are not case-derived"
    assert client.get(f"/api/patients/{PRIMARY_PATIENT_ID}").json() == patient_before

    rerun = client.post(f"/api/patients/{PRIMARY_PATIENT_ID}/consultations", json={})
    assert rerun.status_code == 200
    assert rerun.json()["recommended_physician"]["physician_name"].startswith("Dr. Iain Jung")
    rerun_state = {
        item["patient_id"]: item for item in client.get("/api/workspace/activity").json()
    }[PRIMARY_PATIENT_ID]
    assert rerun_state["has_consultation"] is True
    assert rerun_state["consultation_count"] == 1


def test_synthetic_names_do_not_change_clinical_result():
    jordan = consult_network(PATIENTS[PRIMARY_PATIENT_ID], PHYSICIANS)
    maria = consult_network(PATIENTS[MARIA_PATIENT_ID], MARIA_PHYSICIANS)
    assert jordan.recommended_physician.physician_name == "Dr. Iain Jung (synthetic)"
    assert "Matthew Onadeko" in jordan.alternatives[0].physician_name
    assert any("Celeste Bell" in item.physician_name for item in jordan.consultation)
    assert maria.recommended_physician.specialty == "Gastroenterology"
