"""Dr. Chen's pre-existing synthetic patient panel (closed-loop referral pass
2, Part C/D/E). These patients are lightweight, real fixture PatientRecords
that already belong to Chen at the start of the demo -- they never go
through the referral/consult-network domain. Tonjit is the one patient who
must NEVER appear in this static roster (Part E): he only ever becomes
Chen's patient through the real accept_referral flow (see
test_referral_workflow.py for that side of the invariant).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.referrals import build_referral, run_preflight
from backend.synthetic_data import (
    CHEN_AISHA_PATIENT_ID,
    CHEN_DANIEL_PATIENT_ID,
    CHEN_ELENA_PATIENT_ID,
    CHEN_MAYA_PATIENT_ID,
    CHEN_PETER_PATIENT_ID,
    CHEN_ROBERT_PATIENT_ID,
    CHEN_SEEDED_PATIENT_IDS,
    PATIENTS,
    TONJIT_PATIENT_ID,
)
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


def test_tonjit_is_never_part_of_chens_seeded_patient_panel() -> None:
    """Part E, the critical invariant: regression coverage proving Tonjit is
    never in the static seeded-patient list, no matter how the fixture data
    is refactored later."""
    assert TONJIT_PATIENT_ID not in CHEN_SEEDED_PATIENT_IDS
    assert len(CHEN_SEEDED_PATIENT_IDS) == 6


def test_chen_seeded_patient_panel_has_six_distinct_believable_patients() -> None:
    assert CHEN_SEEDED_PATIENT_IDS == [
        CHEN_ELENA_PATIENT_ID,
        CHEN_DANIEL_PATIENT_ID,
        CHEN_MAYA_PATIENT_ID,
        CHEN_ROBERT_PATIENT_ID,
        CHEN_AISHA_PATIENT_ID,
        CHEN_PETER_PATIENT_ID,
    ]
    assert len({PATIENTS[pid].display_name for pid in CHEN_SEEDED_PATIENT_IDS}) == 6


def test_each_seeded_patient_is_internally_coherent_synthetic_fixture_data() -> None:
    expected = {
        CHEN_ELENA_PATIENT_ID: ("Elena Martinez", 46),
        CHEN_DANIEL_PATIENT_ID: ("Daniel Cho", 61),
        CHEN_MAYA_PATIENT_ID: ("Maya Thompson", 34),
        CHEN_ROBERT_PATIENT_ID: ("Robert Greene", 58),
        CHEN_AISHA_PATIENT_ID: ("Aisha Khan", 29),
        CHEN_PETER_PATIENT_ID: ("Peter Wallace", 67),
    }
    for patient_id, (name, age) in expected.items():
        patient = PATIENTS[patient_id]
        assert patient.synthetic is True
        assert name in patient.display_name
        assert patient.age == age
        assert len(patient.diagnoses) > 0
        assert 0 <= patient.age <= 130
        # Lightweight by design (Part D) -- no referral_question, since these
        # patients never arrive via the referral workflow.
        assert patient.referral_question is None


def test_each_seeded_patient_opens_successfully_via_the_real_patient_api(
    api_client: TestClient,
) -> None:
    for patient_id in CHEN_SEEDED_PATIENT_IDS:
        response = api_client.get(f"/api/patients/{patient_id}")
        assert response.status_code == 200, f"{patient_id} should open successfully"
        payload = response.json()
        assert payload["id"] == patient_id
        assert payload["diagnoses"]


def test_seeded_patients_never_touch_the_referral_domain(api_client: TestClient) -> None:
    """None of Chen's pre-existing patients should have (or need) a referral
    object -- that mechanism is reserved for the real referral-acceptance
    flow (Tonjit), never the baseline panel."""
    for patient_id in CHEN_SEEDED_PATIENT_IDS:
        active = api_client.get(f"/api/patients/{patient_id}/referrals/active")
        assert active.status_code == 200
        assert active.json() is None


def test_resetting_tonjit_does_not_touch_chens_seeded_patients(api_client: TestClient) -> None:
    """Part N: seeded patients belong to Chen's baseline demo workspace, not
    the resettable referral workflow state -- they are plain fixture data,
    never written to the referrals table, so a Tonjit reset has nothing to
    remove for them."""
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    api_client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})

    reset = api_client.post("/api/workspace/demo/reset/tonjit")
    assert reset.status_code == 200

    for patient_id in CHEN_SEEDED_PATIENT_IDS:
        response = api_client.get(f"/api/patients/{patient_id}")
        assert response.status_code == 200
        active = api_client.get(f"/api/patients/{patient_id}/referrals/active")
        assert active.json() is None


def test_tonjit_accepted_patient_query_coexists_cleanly_with_the_seeded_panel(
    api_client: TestClient,
) -> None:
    """Part Q: before acceptance Tonjit is reachable only via the submitted
    query; after acceptance he is reachable via the accepted query -- the
    seeded panel (a pure frontend/static list, never backend-stored) is
    untouched either way, and the two id sets never collide."""
    patient = PATIENTS[TONJIT_PATIENT_ID]
    referral = build_referral(patient, CHEN_ID, "Endocrinology")
    preflighted = run_preflight(patient, referral)
    assert preflighted.status == "submitted"

    incoming = api_client.get(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active"
    )
    assert incoming.status_code == 200
    assert incoming.json() is None  # nothing persisted yet in this test -- pure domain object only

    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")

    before_accept = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "accepted"})
    assert before_accept.json() == []

    api_client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})
    after_accept = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "accepted"})
    assert [item["patient_id"] for item in after_accept.json()] == [TONJIT_PATIENT_ID]
    assert TONJIT_PATIENT_ID not in CHEN_SEEDED_PATIENT_IDS
