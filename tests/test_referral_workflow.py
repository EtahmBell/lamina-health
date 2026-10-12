import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.demo_identity import PCP_AGENT_ID
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import CoordinationEventType, ReferralStatus, RequirementStatus
from backend.referrals import build_referral, run_preflight
from backend.synthetic_data import PATIENTS, TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"


def tonjit_referral():
    patient = PATIENTS[TONJIT_PATIENT_ID]
    return patient, build_referral(patient, CHEN_ID, "Endocrinology")


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(referrals_api, "workflow_store", store)
    return TestClient(app)


# --------------------------------------------------------------------- PART U


def test_referral_can_be_created_for_tonjit_with_correct_parties_and_question() -> None:
    patient, referral = tonjit_referral()
    assert referral.patient_id == TONJIT_PATIENT_ID
    assert referral.referring_physician_id == PCP_AGENT_ID
    assert referral.receiving_physician_id == CHEN_ID
    assert referral.specialty == "Endocrinology"
    assert referral.referral_question == patient.referral_question
    assert "treatment intensification" in referral.referral_question.casefold()
    assert referral.urgency == "Routine outpatient referral"


def test_initial_status_transitions_are_valid_and_explicit() -> None:
    _, referral = tonjit_referral()
    assert referral.status == ReferralStatus.ASSEMBLING
    event_types = [event.event_type for event in referral.coordination_events]
    assert event_types == [
        CoordinationEventType.REFERRAL_CREATED,
        CoordinationEventType.PACKET_ASSEMBLED,
    ]


def test_initial_packet_contains_hba1c_medications_and_glucose_but_not_renal_function() -> None:
    _, referral = tonjit_referral()
    keys = {item.key for item in referral.packet.items}
    assert "recent_hba1c" in keys
    assert "current_medications" in keys
    assert "glucose_log" in keys
    assert "recent_renal_function" not in keys

    hba1c_item = referral.packet.item("recent_hba1c")
    assert "9.6%" in hba1c_item.value
    medications_item = referral.packet.item("current_medications")
    assert "Metformin" in medications_item.value and "Sitagliptin" in medications_item.value


def test_tonjits_underlying_chart_does_contain_renal_function_despite_initial_packet_omission() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    renal_labs = [lab for lab in patient.labs if lab.test in ("creatinine", "eGFR")]
    assert {lab.test for lab in renal_labs} == {"creatinine", "eGFR"}
    assert all(lab.date == "2026-07-20" for lab in renal_labs)
    creatinine = next(lab for lab in renal_labs if lab.test == "creatinine")
    egfr = next(lab for lab in renal_labs if lab.test == "eGFR")
    assert creatinine.value == 0.9
    assert egfr.value == 97


# --------------------------------------------------------------------- PART V


def test_receiving_rule_requires_recent_renal_function_within_freshness_window() -> None:
    _, referral = tonjit_referral()
    renal_requirement = next(item for item in referral.receiving_requirements if item.key == "recent_renal_function")
    assert renal_requirement.required is True
    assert renal_requirement.freshness_days == 180


def test_preflight_flags_renal_as_missing_from_packet_not_missing_from_chart() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    checked = [
        event
        for event in updated.coordination_events
        if event.event_type == CoordinationEventType.REQUIREMENT_CHECKED and event.metadata["requirement"] == "recent_renal_function"
    ]
    assert checked, "expected an initial requirement_checked event for renal function"
    assert checked[0].metadata["result"] == RequirementStatus.MISSING_FROM_PACKET.value
    assert "missing_from_chart" not in checked[0].metadata["result"]


def test_resolver_finds_and_attaches_the_real_renal_result_and_referral_becomes_ready() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)

    renal_item = updated.packet.item("recent_renal_function")
    assert renal_item is not None
    assert "0.9 mg/dL" in renal_item.value
    assert "97 mL/min/1.73m2" in renal_item.value
    assert renal_item.provenance.observed_date == "2026-07-20"
    assert renal_item.provenance.source == "patient_chart"
    assert renal_item.provenance.attached_during == "preflight"

    final_check = next(item for item in updated.requirement_results if item.key == "recent_renal_function")
    assert final_check.status == RequirementStatus.SATISFIED
    assert all(item.status != RequirementStatus.MISSING_FROM_PACKET for item in updated.requirement_results if item.required)
    assert updated.status == ReferralStatus.READY_FOR_REVIEW


def test_record_search_and_attachment_events_are_tagged_automatic_not_physician_required() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    search = next(e for e in updated.coordination_events if e.event_type == CoordinationEventType.RECORD_SEARCH_STARTED)
    found = next(e for e in updated.coordination_events if e.event_type == CoordinationEventType.RECORD_FOUND)
    attached = next(e for e in updated.coordination_events if e.event_type == CoordinationEventType.INFORMATION_ATTACHED)
    for event in (search, found, attached):
        assert event.autonomy.value == "automatic"
        assert event.actor.value == "referring_agent"


# --------------------------------------------------------------------- PART W


def test_coordination_log_proves_the_actual_workflow_occurred_in_order() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    event_types = [event.event_type for event in updated.coordination_events]
    assert event_types == [
        CoordinationEventType.REFERRAL_CREATED,
        CoordinationEventType.PACKET_ASSEMBLED,
        CoordinationEventType.PREFLIGHT_STARTED,
        CoordinationEventType.REQUIREMENT_CHECKED,
        CoordinationEventType.REQUIREMENT_CHECKED,
        CoordinationEventType.REQUIREMENT_CHECKED,
        CoordinationEventType.REQUIREMENT_CHECKED,
        CoordinationEventType.INFORMATION_REQUESTED,
        CoordinationEventType.RECORD_SEARCH_STARTED,
        CoordinationEventType.RECORD_FOUND,
        CoordinationEventType.INFORMATION_ATTACHED,
        CoordinationEventType.REQUIREMENT_RECHECKED,
        CoordinationEventType.REQUIREMENT_RECHECKED,
        CoordinationEventType.REQUIREMENT_RECHECKED,
        CoordinationEventType.REQUIREMENT_RECHECKED,
        CoordinationEventType.PREFLIGHT_COMPLETED,
        CoordinationEventType.REFERRAL_READY,
    ]
    assert [event.sequence for event in updated.coordination_events] == list(range(1, len(event_types) + 1))


def test_event_actors_are_distinguishable_and_provenance_points_to_the_real_result() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    actors = {event.actor for event in updated.coordination_events if event.actor is not None}
    assert {"referring_agent", "receiving_agent", "system"} <= {actor.value for actor in actors}

    renal_item = updated.packet.item("recent_renal_function")
    assert renal_item.provenance.attached_by == PCP_AGENT_ID
    assert renal_item.provenance.observed_date == "2026-07-20"


def test_rerunning_preflight_does_not_duplicate_the_packet_item_or_corrupt_state() -> None:
    patient, referral = tonjit_referral()
    once = run_preflight(patient, referral)
    assert once.status == ReferralStatus.READY_FOR_REVIEW
    renal_items = [item for item in once.packet.items if item.key == "recent_renal_function"]
    assert len(renal_items) == 1

    twice = run_preflight(patient, once)
    assert twice.status == ReferralStatus.READY_FOR_REVIEW
    renal_items_after_rerun = [item for item in twice.packet.items if item.key == "recent_renal_function"]
    assert len(renal_items_after_rerun) == 1
    assert len(twice.coordination_events) == len(once.coordination_events), "a ready referral is a safe no-op to re-run"


# --------------------------------------------------------------------- PART X


def test_resolver_does_not_invent_a_result_and_referral_stays_unready_when_chart_lacks_it() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    patient_without_renal_history = patient.model_copy(
        update={"labs": [lab for lab in patient.labs if lab.test not in ("creatinine", "eGFR")]}
    )
    referral = build_referral(patient_without_renal_history, CHEN_ID, "Endocrinology")
    updated = run_preflight(patient_without_renal_history, referral)

    assert updated.status != ReferralStatus.READY_FOR_REVIEW
    assert all(item.key != "recent_renal_function" for item in updated.packet.items)
    renal_check = next(item for item in updated.requirement_results if item.key == "recent_renal_function")
    assert renal_check.status == RequirementStatus.MISSING_FROM_PACKET
    assert any(
        event.event_type == CoordinationEventType.PHYSICIAN_ACTION_REQUIRED
        and event.autonomy.value == "physician_required"
        and event.metadata["requirement"] == "recent_renal_function"
        for event in updated.coordination_events
    )
    assert any(event.event_type == CoordinationEventType.RECORD_NOT_FOUND for event in updated.coordination_events)


# ----------------------------------------------------------------- API layer


def test_api_create_preflight_get_boundary_works_end_to_end(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    )
    assert created.status_code == 200
    payload = created.json()
    assert payload["status"] == "assembling"
    referral_id = payload["id"]

    preflight = api_client.post(f"/api/referrals/{referral_id}/preflight")
    assert preflight.status_code == 200
    assert preflight.json()["status"] == "ready_for_review"

    fetched = api_client.get(f"/api/referrals/{referral_id}")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "ready_for_review"
    assert len(fetched.json()["coordination_events"]) == 17


def test_api_404s_for_unknown_referral_and_unknown_physician(api_client: TestClient) -> None:
    missing_physician = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": "physician-does-not-exist"}
    )
    assert missing_physician.status_code == 404

    missing_referral = api_client.get("/api/referrals/999999")
    assert missing_referral.status_code == 404
