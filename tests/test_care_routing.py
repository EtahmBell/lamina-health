"""Care routing / match explainability demo pass. Lamina decides the
appropriate CARE NEED (specialty + modality + priority) before merely
ranking doctors; network participation (integrated/Lamina physician/
external directory) is an evidence-confidence label, never a quality tier;
access is modality-specific and never mutates physician fit; priority is
editable and strictly separate from referral readiness. See Parts A-W.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.agents import build_candidate_routes, build_care_routing, consult_network
from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.clinical import build_patient_context
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import NetworkParticipation
from backend.synthetic_data import PATIENTS, PHYSICIANS_BY_PATIENT, PRIMARY_PATIENT_ID, TONJIT_PATIENT_ID
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


def _tonjit_consultation():
    patient = PATIENTS[TONJIT_PATIENT_ID]
    return consult_network(patient, PHYSICIANS_BY_PATIENT[TONJIT_PATIENT_ID], None)


# --------------------------------------------------------------- Part C/Y.1/2


def test_tonjit_routing_result_is_in_person_endocrinology_with_soon_priority() -> None:
    result = _tonjit_consultation()
    assert result.care_routing is not None
    assert result.care_routing.specialty == "Endocrinology"
    assert result.care_routing.recommended_modality == "in_person"
    assert result.care_routing.suggested_priority == "soon"
    assert result.care_routing.in_person_need == "preferred"
    assert result.care_routing.econsult_suitability == "possible_not_preferred"
    assert "Endocrinology" in result.care_routing.rationale


def test_a_patient_without_this_pass_populated_case_family_gets_no_routing_data() -> None:
    """Part B/X: purely additive -- Jordan's existing flow renders exactly as
    before this pass."""
    patient = PATIENTS[PRIMARY_PATIENT_ID]
    result = consult_network(patient, PHYSICIANS_BY_PATIENT[PRIMARY_PATIENT_ID], None)
    assert result.care_routing is None
    assert result.candidate_routes == []


# ----------------------------------------------------------------- Part W


def test_no_numeric_match_score_is_exposed_anywhere_in_the_routing_data() -> None:
    result = _tonjit_consultation()
    dumped = result.model_dump_json()
    assert "match_score" not in dumped
    assert "score" not in dumped.lower()


# ------------------------------------------------------------- Part G/Y.6


def test_chen_is_integrated_network_with_high_evidence_confidence_and_strong_fit() -> None:
    result = _tonjit_consultation()
    chen_routes = [route for route in result.candidate_routes if route.physician_id == CHEN_ID]
    assert len(chen_routes) == 2  # in-person + e-consult (Part L)
    for route in chen_routes:
        assert route.network_participation == NetworkParticipation.INTEGRATED_NETWORK
        assert route.evidence_confidence == "high"
        assert route.fit_label == "strong"


def test_chens_in_person_route_is_the_recommended_one_and_his_econsult_route_is_not(
) -> None:
    result = _tonjit_consultation()
    in_person = next(r for r in result.candidate_routes if r.physician_id == CHEN_ID and r.modality == "in_person")
    econsult = next(r for r in result.candidate_routes if r.physician_id == CHEN_ID and r.modality == "econsult")
    assert in_person.recommended is True
    assert econsult.recommended is False
    # Part O: e-consult is an alternative modality, not a labeled fallback/backup
    assert "fallback" not in (econsult.rationale or "").lower()
    assert "backup" not in (econsult.rationale or "").lower()
    assert "second-best" not in (econsult.rationale or "").lower()


# ------------------------------------------------------------- Part H/Y.7


def test_maya_ramanathan_is_a_lamina_physician_strong_fit_alternative() -> None:
    result = _tonjit_consultation()
    maya = next(r for r in result.candidate_routes if r.physician_id == "physician-ramanathan")
    assert maya.network_participation == NetworkParticipation.LAMINA_PHYSICIAN
    assert maya.fit_label == "strong"
    assert maya.access.in_person_wait_days == 7
    assert "6" in maya.access.in_person_wait_label and "8" in maya.access.in_person_wait_label
    # only ONE route for Maya (in-person) -- no separate "Maya -- E-consult" row
    assert len([r for r in result.candidate_routes if r.physician_id == "physician-ramanathan"]) == 1


# --------------------------------------------------------- Part I/Y.8/9


def test_the_external_directory_candidate_is_low_information_with_no_invented_econsult_or_rationale() -> None:
    result = _tonjit_consultation()
    directory = next(
        r for r in result.candidate_routes if r.network_participation == NetworkParticipation.EXTERNAL_DIRECTORY
    )
    assert directory.fit_label == "potential"
    assert directory.evidence_confidence == "unverified"
    assert directory.rationale is None
    assert directory.access.econsult_available is None  # unknown, never assumed True
    assert directory.access.in_person_wait_days is None
    assert directory.access.access_confidence == "unverified"


# ------------------------------------------------------------- Part K/Y.10


def test_chen_has_separate_visit_and_econsult_access_values_from_one_shared_source() -> None:
    result = _tonjit_consultation()
    chen_access = next(r for r in result.candidate_routes if r.physician_id == CHEN_ID).access
    assert chen_access.in_person_wait_days == 10
    assert chen_access.econsult_response_days == 2


def test_build_care_routing_and_build_candidate_routes_agree_with_what_consult_network_attaches() -> None:
    """Confirms consult_network doesn't maintain a second, divergent copy of
    this data -- it calls the exact same functions tests exercise directly."""
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    assert build_care_routing(context) == _tonjit_consultation().care_routing
    assert build_candidate_routes(context) == _tonjit_consultation().candidate_routes


# ------------------------------------------------------------- Part V


def test_physician_fit_is_never_mutated_by_access_wait_time() -> None:
    result = _tonjit_consultation()
    chen_routes = [r for r in result.candidate_routes if r.physician_id == CHEN_ID]
    fits = {route.fit_label for route in chen_routes}
    assert fits == {"strong"}, "fit must be identical across Chen's in-person and e-consult routes despite different access"


# ---------------------------------------------------------- Part E/Y.3/4


def _scheduled_referral_id(client: TestClient, priority: str | None = None) -> int:
    body = {"receiving_physician_id": CHEN_ID}
    if priority is not None:
        body["priority"] = priority
    created = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json=body).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    return created["id"]


def test_referral_priority_defaults_to_routine_when_not_specified(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    referral = api_client.get(f"/api/referrals/{referral_id}").json()
    assert referral["priority"] == "routine"


def test_the_referring_physicians_selected_priority_persists_on_the_referral(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client, priority="soon")
    referral = api_client.get(f"/api/referrals/{referral_id}").json()
    assert referral["priority"] == "soon"


def test_priority_is_never_silently_upgraded_on_an_idempotent_repeat_create(api_client: TestClient) -> None:
    first = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID, "priority": "soon"}
    ).json()
    second = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID, "priority": "urgent"}
    ).json()
    assert first["id"] == second["id"]
    assert second["priority"] == "soon", "the existing referral's priority must not silently change on a repeat create call"


# --------------------------------------------------------------- Part F/U


def test_referral_readiness_progressing_through_preflight_never_changes_priority(
    api_client: TestClient,
) -> None:
    """Part F/U: readiness (status/requirement_results) and priority are
    orthogonal -- preflight resolving (or failing to resolve) a requirement
    must never touch `priority`, in either direction."""
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID, "priority": "soon"}
    ).json()
    referral_id = created["id"]
    assert created["priority"] == "soon"

    before_preflight = api_client.get(f"/api/referrals/{referral_id}").json()
    assert before_preflight["priority"] == "soon"

    api_client.post(f"/api/referrals/{referral_id}/preflight")
    after_preflight = api_client.get(f"/api/referrals/{referral_id}").json()
    assert after_preflight["priority"] == "soon", "preflight changing readiness/status must never change priority"
    assert after_preflight["status"] != before_preflight["status"], "preflight should have actually advanced readiness"


# -------------------------------------------------------------- Part R


def test_chen_capacity_endpoint_exposes_separate_visit_and_econsult_channels(api_client: TestClient) -> None:
    capacity = api_client.get(f"/api/physicians/{CHEN_ID}/capacity").json()
    assert capacity["in_person_wait_days"] == 10
    assert capacity["econsult_available"] is True
    assert capacity["econsult_response_days"] == 2


def test_capacity_endpoint_404s_for_a_physician_with_no_known_profile(api_client: TestClient) -> None:
    response = api_client.get("/api/physicians/physician-jung/capacity")
    assert response.status_code == 404
