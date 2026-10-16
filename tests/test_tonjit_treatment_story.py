"""Tonjit demo-story pass: the documented Endocrinology encounter must
actually change Tonjit's clinical record (not just the handoff/modal), the
handoff must be derived from the same structured facts, and Dr. Chen's
Dashboard must surface Tonjit the moment he has an outstanding handoff to
review. See Parts D-V of the request for the full checklist.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.synthetic_data import TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(referrals_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    return TestClient(app)


def _scheduled_referral_id(client: TestClient) -> int:
    created = client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{created['id']}/scheduling/options", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{created['id']}/scheduling/route", json={"receiving_physician_id": CHEN_ID})
    return created["id"]


def _documented_referral_id(client: TestClient) -> int:
    referral_id = _scheduled_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    return referral_id


# --------------------------------------------------------------- Part Q: pre/post


def test_before_the_encounter_current_medications_are_exactly_the_original_fixture(
    api_client: TestClient,
) -> None:
    patient = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    assert patient["medications"] == ["Metformin", "Sitagliptin"]
    assert patient["recent_medication_changes"] == []


def test_after_the_encounter_current_medications_reflect_the_documented_treatment_change(
    api_client: TestClient,
) -> None:
    _documented_referral_id(api_client)
    patient = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    assert patient["medications"] == ["Metformin", "Semaglutide"]
    assert "Sitagliptin" not in patient["medications"]


def test_semaglutide_carries_endocrinology_provenance(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    patient = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    semaglutide = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Semaglutide")
    assert semaglutide["action"] == "start"
    assert semaglutide["medication_class"] == "GLP-1 receptor agonist"
    assert semaglutide["specialty"] == "Endocrinology"


def test_sitagliptin_discontinuation_is_recorded_with_provenance(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    patient = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    sitagliptin = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Sitagliptin")
    assert sitagliptin["action"] == "discontinue"
    assert sitagliptin["specialty"] == "Endocrinology"


def test_metformin_is_recorded_as_continued_and_remains_current(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    patient = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    assert "Metformin" in patient["medications"]
    metformin = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Metformin")
    assert metformin["action"] == "continue"


def test_other_patients_are_entirely_unaffected_by_tonjits_encounter(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    jordan = api_client.get("/api/patients/patient-ckd-htn-001").json()
    assert jordan["recent_medication_changes"] == []


# ------------------------------------------------------------- Part O: handoff


def test_handoff_recommendations_and_medication_changes_match_the_encounter_exactly(
    api_client: TestClient,
) -> None:
    referral_id = _documented_referral_id(api_client)
    encounter = api_client.get(f"/api/referrals/{referral_id}/encounter").json()
    client_handoff = api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID}
    ).json()
    handoff = client_handoff["handoff"]
    assert handoff["recommendations"] == encounter["plan"]
    assert handoff["medication_changes"] == encounter["medication_changes"]
    assert handoff["follow_up"] == encounter["follow_up"]


def test_handoff_mentions_the_same_specific_drugs_as_the_clinical_record(api_client: TestClient) -> None:
    referral_id = _documented_referral_id(api_client)
    client_handoff = api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID}
    ).json()
    handoff = client_handoff["handoff"]
    assert "semaglutide" in handoff["recommendations"].lower()
    assert "sitagliptin" in handoff["recommendations"].lower()
    assert "metformin" in handoff["recommendations"].lower()
    assert "ozempic" not in handoff["recommendations"].lower()
    assert "wegovy" not in handoff["recommendations"].lower()


# ------------------------------------------------------------- Part R: reset


def test_reset_restores_the_original_pre_consult_medication_state(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    pre_reset = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    assert pre_reset["medications"] == ["Metformin", "Semaglutide"]

    api_client.post("/api/workspace/demo/reset/tonjit")

    post_reset = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}").json()
    assert post_reset["medications"] == ["Metformin", "Sitagliptin"]
    assert post_reset["recent_medication_changes"] == []
    assert api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json() is None


def test_reset_does_not_alter_unrelated_patients(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    api_client.post("/api/workspace/demo/reset/tonjit")
    jordan = api_client.get("/api/patients/patient-ckd-htn-001").json()
    assert jordan["medications"]


# ------------------------------------------------- Part S/T: future re-consult


def test_a_fresh_network_consultation_is_handed_the_current_patient_record_including_semaglutide(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Part S/T: `create_consultation` must pass consult_network the SAME
    derived current-medication state GET /api/patients/{id} already applies,
    never the frozen base fixture -- otherwise a future re-consult would
    silently reason from Tonjit's pre-consult regimen. Spies on the actual
    PatientRecord handed to consult_network rather than asserting on
    display-only fact text, which this demo's simple fact-extraction never
    promised to echo medication names into."""
    _documented_referral_id(api_client)
    captured: dict = {}
    real_consult_network = consult_api.consult_network

    def spy(patient, physicians, pcp_guidance):
        captured["patient"] = patient
        return real_consult_network(patient, physicians, pcp_guidance)

    monkeypatch.setattr(consult_api, "consult_network", spy)
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={"pcp_guidance": None})
    assert captured["patient"].medications == ["Metformin", "Semaglutide"]
