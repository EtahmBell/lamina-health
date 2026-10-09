from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.specialist_projection import project_specialist_case_summary
from backend.synthetic_data import MARIA_PATIENT_ID, PRIMARY_PATIENT_ID
from backend.workflow import WorkflowStore

IAIN_NPI = "9900000001"
ONADEKO_NPI = "9900000002"
ROSSI_NPI = "9900000004"


@pytest.fixture
def specialist_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(specialist_api, "workflow_store", store)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return store


def _run_case(client: TestClient, patient_id: str) -> dict:
    response = client.post(f"/api/patients/{patient_id}/consultations", json={})
    assert response.status_code == 200
    return response.json()


def test_cases_require_canonical_agent_participation(
    specialist_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        assert client.get("/api/workspace/specialist/cases").json() == []

        # Directory presence and a manually recorded network relationship are not cases.
        assert client.post(
            "/api/workspace/network/members", json={"npi": IAIN_NPI}
        ).status_code == 201
        assert client.get("/api/workspace/specialist/cases").json() == []

        _run_case(client, MARIA_PATIENT_ID)
        assert client.get("/api/workspace/specialist/cases").json() == []

        jordan = _run_case(client, PRIMARY_PATIENT_ID)
        cases = client.get("/api/workspace/specialist/cases").json()

    assert len(cases) == 1
    assert cases[0]["consultation_id"] == jordan["consultation_id"]
    assert cases[0]["patient_name"] == "Jordan Lee"
    assert cases[0]["specialist_outcome"] == "recommended"
    assert cases[0]["reviewed"] is False


def test_jordan_iain_case_detail_is_a_projection_of_canonical_events(
    specialist_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        jordan = _run_case(client, PRIMARY_PATIENT_ID)
        canonical_record = client.get("/api/workspace/consultations").json()[0]
        case = client.get(
            f"/api/workspace/specialist/cases/{canonical_record['id']}"
        ).json()

    assert case["consultation_id"] == jordan["consultation_id"]
    assert case["consultation_record_id"] == canonical_record["id"]
    assert case["case_context"]["patient"] == {
        "id": PRIMARY_PATIENT_ID,
        "name": "Jordan Lee",
        "age": 62,
        "location": "Oakland, CA",
        "synthetic": True,
    }
    assert case["case_context"]["referring_physician"]["name"] == "Dr. Lucy Saruhashi"
    assert case["case_context"]["referring_physician"]["specialty"] == "Primary Care"
    assert case["recommendation_physician"] == "Dr. Iain Jung"
    assert case["recommendation_specialty"] == "Nephrology"
    assert case["network_outcome"]["specialist_outcome"] == "recommended"
    assert case["network_outcome"]["was_recommended"] is True
    assert "BMP" in " ".join(case["agent_response"]["required_workup"])
    assert "UPCR" in " ".join(case["agent_response"]["required_workup"])
    assert case["agent_response"]["access"] == "Approximately 8 days"

    canonical_ids = {message["id"] for message in jordan["messages"]}
    interaction_ids = {
        interaction["event_id"] for interaction in case["agent_response"]["interactions"]
    }
    assert interaction_ids <= canonical_ids
    assert not any("reasoning" in key.casefold() for key in case)


def test_non_winning_participants_have_descriptive_outcomes(
    specialist_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _run_case(client, PRIMARY_PATIENT_ID)
        record = client.get("/api/workspace/consultations").json()[0]

    onadeko = project_specialist_case_summary(record, ONADEKO_NPI, {})
    rossi = project_specialist_case_summary(record, ROSSI_NPI, {})
    assert onadeko is not None
    assert onadeko["specialist_outcome"] == "alternative"
    assert onadeko["was_recommended"] is False
    assert onadeko["clarification_count"] == 2
    assert rossi is not None
    assert rossi["specialist_outcome"] == "redirected"
    assert rossi["was_recommended"] is False


def test_review_and_calibration_are_workspace_local_and_not_provider_state(
    specialist_store: WorkflowStore,
) -> None:
    specialist_store.save_provider_agent_preferences(
        IAIN_NPI, True, {"notes": "global state must remain unchanged"}
    )
    before = specialist_store.provider_agent_state(IAIN_NPI)

    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        _run_case(visitor_a, PRIMARY_PATIENT_ID)
        _run_case(visitor_b, PRIMARY_PATIENT_ID)
        case_a = visitor_a.get("/api/workspace/specialist/cases").json()[0]
        case_b = visitor_b.get("/api/workspace/specialist/cases").json()[0]

        assert case_a["reviewed"] is False
        assert case_b["reviewed"] is False
        reviewed = visitor_a.put(
            f"/api/workspace/specialist/cases/{case_a['consultation_record_id']}/review"
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["reviewed"] is True

        calibration = visitor_a.put(
            f"/api/workspace/specialist/cases/{case_a['consultation_record_id']}"
            "/calibrations/case-practice-response",
            json={"action": "edit", "statement": "Require BMP and UPCR before review."},
        )
        assert calibration.status_code == 200
        assert calibration.json()["status"] == "suggested"
        assert calibration.json()["key"] == "case-practice-response"
        assert calibration.json()["question"] == "Does this reflect how you would practice?"

        refreshed_a = visitor_a.get(
            f"/api/workspace/specialist/cases/{case_a['consultation_record_id']}"
        ).json()
        refreshed_b = visitor_b.get(
            f"/api/workspace/specialist/cases/{case_b['consultation_record_id']}"
        ).json()

    assert refreshed_a["reviewed"] is True
    assert refreshed_a["calibration"]["statement"] == "Require BMP and UPCR before review."
    assert refreshed_b["reviewed"] is False
    assert refreshed_b["calibration"]["status"] == "suggested"
    assert refreshed_b["calibration"]["statement"] != refreshed_a["calibration"]["statement"]
    assert specialist_store.provider_agent_state(IAIN_NPI) == before


def test_two_workspace_isolation_with_pristine_second_workspace(
    specialist_store: WorkflowStore,
) -> None:
    with TestClient(app) as visitor_a, TestClient(app) as visitor_b:
        _run_case(visitor_a, PRIMARY_PATIENT_ID)
        case_a = visitor_a.get("/api/workspace/specialist/cases").json()[0]
        assert visitor_b.get("/api/workspace/specialist/cases").json() == []

        visitor_a.put(
            f"/api/workspace/specialist/cases/{case_a['consultation_record_id']}/review"
        )
        assert visitor_b.get("/api/workspace/specialist/cases").json() == []
        assert visitor_b.get(
            f"/api/workspace/specialist/cases/{case_a['consultation_record_id']}"
        ).status_code == 404


def test_specialist_perspective_is_server_controlled(
    specialist_store: WorkflowStore,
) -> None:
    specialist_store.claim_provider("real-auth-user", IAIN_NPI)
    with TestClient(app) as client:
        assert client.get(
            "/api/workspace/specialist?npi=9900000002"
        ).status_code == 400
        assert client.get(
            "/api/workspace/specialist/cases",
            headers={"X-Specialist-NPI": "9900000002"},
        ).status_code == 400
        assert client.get(
            "/api/workspace/specialist/9900000002/cases"
        ).status_code == 404
        workspace = client.get("/api/workspace/specialist").json()

    assert workspace["physician"]["npi"] == IAIN_NPI
    assert workspace["physician"]["synthetic"] is True
    assert workspace["case_count"] == 0


def test_reset_and_expiry_cleanup_remove_only_specialist_workspace_overlays(
    specialist_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _run_case(client, PRIMARY_PATIENT_ID)
        case = client.get("/api/workspace/specialist/cases").json()[0]
        client.put(
            f"/api/workspace/specialist/cases/{case['consultation_record_id']}/review"
        )
        client.put(
            f"/api/workspace/specialist/cases/{case['consultation_record_id']}"
            "/calibrations/case-practice-response",
            json={"action": "confirm"},
        )
        workspace_id = client.cookies.get("lamina_demo_workspace")
        assert client.post("/api/workspace/demo/reset/jordan").status_code == 200

    with sqlite3.connect(specialist_store.path) as database:
        review_count = database.execute(
            "SELECT COUNT(*) FROM specialist_case_reviews WHERE workspace_id=?",
            (workspace_id,),
        ).fetchone()[0]
        calibration_count = database.execute(
            "SELECT COUNT(*) FROM specialist_calibrations WHERE workspace_id=?",
            (workspace_id,),
        ).fetchone()[0]
    assert review_count == 0
    assert calibration_count == 0
    assert specialist_store.provider_agent_state(IAIN_NPI) is None

