"""Tonjit demo-story pass + bug-fix pass: the documented Endocrinology
encounter must actually change Tonjit's clinical record (not just the
handoff/modal), the handoff must be derived from the same structured facts,
Dr. Chen's Dashboard must surface Tonjit the moment he has an outstanding
handoff to review, and -- the bug-fix pass's core correction -- Lucy must
NOT see Chen's specialist-authored treatment change until Chen actually
sends the handoff. The encounter remains the one source of clinical truth
throughout; only VISIBILITY to the referring physician is gated on the
handoff's sent status. See Parts D-V (demo-story) and A/B/L/M (bug-fix).
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
    """Encounter exists, but no handoff has been sent yet -- the window
    where Chen can see the treatment change but Lucy must not."""
    referral_id = _scheduled_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    return referral_id


def _sent_referral_id(client: TestClient) -> int:
    referral_id = _documented_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    return referral_id


def _patient_as(client: TestClient, as_physician_id: str | None = None) -> dict:
    url = f"/api/patients/{TONJIT_PATIENT_ID}"
    if as_physician_id is not None:
        url += f"?as_physician_id={as_physician_id}"
    return client.get(url).json()


# --------------------------------------------------------------- Part Q: pre/post


def test_before_the_encounter_current_medications_are_exactly_the_original_fixture(
    api_client: TestClient,
) -> None:
    patient = _patient_as(api_client)
    assert patient["medications"] == ["Metformin", "Sitagliptin"]
    assert patient["recent_medication_changes"] == []


# ------------------------------------------------- bug-fix pass, Part A/L: Chen
# can see the treatment change the moment the encounter is documented, no
# handoff required.


def test_chen_sees_the_documented_treatment_change_immediately_no_handoff_required(
    api_client: TestClient,
) -> None:
    _documented_referral_id(api_client)
    patient = _patient_as(api_client, CHEN_ID)
    assert patient["medications"] == ["Metformin", "Semaglutide"]
    semaglutide = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Semaglutide")
    assert semaglutide["action"] == "start"
    assert semaglutide["medication_class"] == "GLP-1 receptor agonist"
    assert semaglutide["specialty"] == "Endocrinology"


# -------------------------------------------- bug-fix pass, Part A/L: Lucy must
# NOT see it yet, even though the encounter already exists.


def test_lucy_does_not_see_the_treatment_change_before_the_handoff_is_sent(api_client: TestClient) -> None:
    _documented_referral_id(api_client)
    patient = _patient_as(api_client)  # no as_physician_id -- the default, referring-physician-safe view
    assert patient["medications"] == ["Metformin", "Sitagliptin"]
    assert patient["recent_medication_changes"] == []


def test_lucy_does_not_see_it_even_while_the_handoff_is_a_draft(api_client: TestClient) -> None:
    referral_id = _documented_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID})
    patient = _patient_as(api_client)
    assert patient["medications"] == ["Metformin", "Sitagliptin"]
    assert patient["recent_medication_changes"] == []


def test_explicitly_asking_as_the_referring_physicians_own_id_is_still_gated_same_as_no_identity(
    api_client: TestClient,
) -> None:
    referral_id = _documented_referral_id(api_client)
    referral = api_client.get(f"/api/referrals/{referral_id}").json()
    patient = _patient_as(api_client, referral["referring_physician_id"])
    assert patient["medications"] == ["Metformin", "Sitagliptin"]


# ---------------------------------------- bug-fix pass, Part A/L: once sent,
# Lucy gains visibility.


def test_lucy_sees_the_treatment_change_once_the_handoff_is_sent(api_client: TestClient) -> None:
    _sent_referral_id(api_client)
    patient = _patient_as(api_client)
    assert patient["medications"] == ["Metformin", "Semaglutide"]
    assert "Sitagliptin" not in patient["medications"]
    semaglutide = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Semaglutide")
    assert semaglutide["specialty"] == "Endocrinology"
    sitagliptin = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Sitagliptin")
    assert sitagliptin["action"] == "discontinue"


def test_metformin_is_recorded_as_continued_and_remains_current_for_both_viewers(api_client: TestClient) -> None:
    _sent_referral_id(api_client)
    for viewer in (None, CHEN_ID):
        patient = _patient_as(api_client, viewer)
        assert "Metformin" in patient["medications"]
        metformin = next(item for item in patient["recent_medication_changes"] if item["medication"] == "Metformin")
        assert metformin["action"] == "continue"


def test_chen_still_sees_the_same_state_after_send_as_before(api_client: TestClient) -> None:
    _sent_referral_id(api_client)
    patient = _patient_as(api_client, CHEN_ID)
    assert patient["medications"] == ["Metformin", "Semaglutide"]


def test_other_patients_are_entirely_unaffected_by_tonjits_encounter(api_client: TestClient) -> None:
    _sent_referral_id(api_client)
    jordan = api_client.get("/api/patients/patient-ckd-htn-001").json()
    assert jordan["recent_medication_changes"] == []


# ---------------------------------------------- bug-fix pass, Part M: source of
# truth / no duplicate medication model.


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
    _sent_referral_id(api_client)
    pre_reset = _patient_as(api_client)
    assert pre_reset["medications"] == ["Metformin", "Semaglutide"]

    api_client.post("/api/workspace/demo/reset/tonjit")

    post_reset = _patient_as(api_client)
    assert post_reset["medications"] == ["Metformin", "Sitagliptin"]
    assert post_reset["recent_medication_changes"] == []
    assert api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json() is None


def test_reset_does_not_alter_unrelated_patients(api_client: TestClient) -> None:
    _sent_referral_id(api_client)
    api_client.post("/api/workspace/demo/reset/tonjit")
    jordan = api_client.get("/api/patients/patient-ckd-htn-001").json()
    assert jordan["medications"]


# ------------------------------------------------- Part S/T: future re-consult


def test_a_fresh_network_consultation_is_handed_lucys_own_visible_state_only_after_send(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Part S/T + bug-fix Part A: a future re-consult reasons as Lucy's own
    agent, so it must see exactly what's visible to her -- nothing before
    the handoff is sent, the real current state after. Spies on the actual
    PatientRecord handed to consult_network rather than asserting on
    display-only fact text, which this demo's simple fact-extraction never
    promised to echo medication names into."""
    captured: list = []
    real_consult_network = consult_api.consult_network

    def spy(patient, physicians, pcp_guidance, **kwargs):
        captured.append(patient)
        return real_consult_network(patient, physicians, pcp_guidance, **kwargs)

    monkeypatch.setattr(consult_api, "consult_network", spy)

    _documented_referral_id(api_client)
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={"pcp_guidance": None})
    assert captured[-1].medications == ["Metformin", "Sitagliptin"]

    api_client.post(
        f"/api/referrals/{api_client.get(f'/api/patients/{TONJIT_PATIENT_ID}/referrals/active').json()['id']}"
        "/handoff/draft",
        json={"receiving_physician_id": CHEN_ID},
    )
    referral_id = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()["id"]
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={"pcp_guidance": None})
    assert captured[-1].medications == ["Metformin", "Semaglutide"]
