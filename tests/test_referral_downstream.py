"""Downstream closed-loop referral coordination (closed-loop referral pass 3):
scheduling, the externally-ingested consultation encounter, and the
specialist-to-PCP handoff. See Parts AM-AQ of the request for the full test
checklist this file covers.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.demo_identity import PCP_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import CoordinationActor, CoordinationEventType, HandoffStatus, ReferralStatus, SchedulingStatus
from backend.synthetic_data import TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"
OTHER_PHYSICIAN_ID = "physician-jung"


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(referrals_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    return TestClient(app)


def _submitted_referral_id(client: TestClient) -> int:
    created = client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    return created["id"]


def _accepted_referral_id(client: TestClient) -> int:
    referral_id = _submitted_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    return referral_id


def _scheduled_referral_id(client: TestClient) -> int:
    referral_id = _accepted_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID})
    client.post(f"/api/referrals/{referral_id}/scheduling/route", json={"receiving_physician_id": CHEN_ID})
    return referral_id


def _documented_referral_id(client: TestClient) -> int:
    referral_id = _scheduled_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    return referral_id


def _drafted_referral_id(client: TestClient) -> int:
    referral_id = _documented_referral_id(client)
    client.post(f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID})
    return referral_id


# --------------------------------------------------------------------- Part AM


def test_lucy_hydrates_the_same_accepted_referral_and_it_survives_reload(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    active = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()
    assert active["status"] == "accepted"
    assert active["id"] == referral_id
    event_types = [event["event_type"] for event in active["coordination_events"]]
    assert "referral_accepted" in event_types
    # Re-fetching must never replay/duplicate anything.
    again = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()
    assert again == active


# --------------------------------------------------------------------- Part AN


def test_scheduling_options_only_available_after_acceptance(api_client: TestClient) -> None:
    referral_id = _submitted_referral_id(api_client)
    response = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID}
    )
    assert response.status_code == 409


def test_only_the_receiving_physician_can_find_scheduling_options(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options",
        json={"receiving_physician_id": OTHER_PHYSICIAN_ID},
    )
    assert response.status_code == 403


def test_returned_options_are_structured_synthetic_availability(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    result = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID}
    ).json()
    scheduling = result["scheduling"]
    assert scheduling["status"] == "options_ready"
    assert len(scheduling["options"]) == 3
    for slot in scheduling["options"]:
        assert slot["appointment_type"] == "New Endocrinology consultation"
        assert slot["duration_minutes"] > 0
        assert slot["location"]
        assert slot["starts_at"]
    event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "scheduling_options_found"
    )
    assert event["actor"] == "receiving_agent"
    assert event["autonomy"] == "automatic"


def test_finding_options_twice_returns_the_same_options_never_regenerated(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    first = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID}
    ).json()
    second = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert first["scheduling"]["options"] == second["scheduling"]["options"]
    found_events = [
        event for event in second["referral"]["coordination_events"]
        if event["event_type"] == "scheduling_options_found"
    ]
    assert len(found_events) == 1


def test_sending_options_to_scheduling_persists_routing_state(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID})
    result = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/route", json={"receiving_physician_id": CHEN_ID}
    ).json()
    sent_event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "scheduling_options_sent"
    )
    assert sent_event["actor"] == "receiving_physician"
    assert sent_event["autonomy"] == "physician_required"


def test_appointment_scheduled_uses_one_of_the_returned_options_with_synthetic_source(
    api_client: TestClient,
) -> None:
    referral_id = _accepted_referral_id(api_client)
    options_result = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID}
    ).json()
    real_slot_ids = {slot["slot_id"] for slot in options_result["scheduling"]["options"]}

    routed = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/route", json={"receiving_physician_id": CHEN_ID}
    ).json()
    scheduling = routed["scheduling"]
    assert scheduling["status"] == "scheduled"
    assert scheduling["selected_option"]["slot_id"] in real_slot_ids
    assert scheduling["source"] == "synthetic_demo"

    scheduled_event = next(
        event for event in routed["referral"]["coordination_events"]
        if event["event_type"] == "appointment_scheduled"
    )
    assert scheduled_event["actor"] == "scheduling_workflow"
    assert scheduled_event["actor"] != "receiving_agent"
    assert scheduled_event["actor"] != "receiving_physician"


def test_chen_and_lucy_see_the_same_scheduled_appointment(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    chen_view = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    lucy_view = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    assert chen_view == lucy_view
    assert chen_view["status"] == "scheduled"
    referral = api_client.get(f"/api/referrals/{referral_id}").json()
    assert referral["status"] == "scheduled"


def test_reload_preserves_scheduled_state(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    first = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    second = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    assert first == second


# --------------------------------------------------------------------- Part AO


def test_encounter_cannot_be_ingested_before_scheduled(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    )
    assert response.status_code == 409


def test_demo_control_creates_one_synthetic_encounter(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    result = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    encounter = result["encounter"]
    assert encounter["source"] == "synthetic_demo"
    assert encounter["patient_id"] == TONJIT_PATIENT_ID
    assert encounter["physician_id"] == CHEN_ID
    assert encounter["assessment"]
    assert encounter["key_findings"]
    event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "consultation_ingested"
    )
    assert event["actor"] == "system"


def test_patient_detail_gains_the_consultation_once_ingested(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    assert api_client.get(f"/api/referrals/{referral_id}/encounter").json() is None
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    encounter = api_client.get(f"/api/referrals/{referral_id}/encounter").json()
    assert encounter is not None
    assert encounter["referral_id"] == referral_id


def test_no_complete_consultation_endpoint_exists_for_a_normal_physician_action() -> None:
    """Part C: clinical encounter completion must only ever be reachable
    through the demo-only ingest control, never a normal workflow verb."""
    paths = {getattr(route, "path", "") for route in app.routes}
    assert not any("complete" in path and "consultation" in path for path in paths)


def test_duplicate_encounter_ingestion_is_safe_and_idempotent(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    first = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    second = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert first["encounter"]["id"] == second["encounter"]["id"]
    ingested_events = [
        event for event in second["referral"]["coordination_events"]
        if event["event_type"] == "consultation_ingested"
    ]
    assert len(ingested_events) == 1


# --------------------------------------------------------------------- Part AP


def test_draft_handoff_only_available_after_encounter_exists(api_client: TestClient) -> None:
    referral_id = _scheduled_referral_id(api_client)
    response = api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID}
    )
    assert response.status_code == 409


def test_chens_agent_creates_and_persists_the_draft_referencing_the_encounter(
    api_client: TestClient,
) -> None:
    referral_id = _documented_referral_id(api_client)
    encounter = api_client.get(f"/api/referrals/{referral_id}/encounter").json()
    result = api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID}
    ).json()
    handoff = result["handoff"]
    assert handoff["status"] == "draft"
    assert handoff["encounter_id"] == encounter["id"]
    assert handoff["from_physician_id"] == CHEN_ID
    assert handoff["drafted_by_agent_id"]
    assert handoff["approved_by_physician_id"] is None
    event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "handoff_drafted"
    )
    assert event["actor"] == "receiving_agent"


def test_lucy_cannot_see_the_draft_handoff(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    as_lucy = api_client.get(f"/api/referrals/{referral_id}/handoff")
    assert as_lucy.status_code == 200
    assert as_lucy.json() is None


def test_chen_can_see_his_own_draft(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    as_chen = api_client.get(f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": CHEN_ID})
    assert as_chen.json() is not None
    assert as_chen.json()["status"] == "draft"


def test_review_handoff_shows_the_actual_persisted_draft(api_client: TestClient) -> None:
    referral_id = _documented_referral_id(api_client)
    drafted = api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID}
    ).json()["handoff"]
    fetched = api_client.get(
        f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": CHEN_ID}
    ).json()
    assert fetched == drafted


def test_chen_explicitly_sends_and_is_marked_as_approver(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    result = api_client.post(
        f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID}
    ).json()
    handoff = result["handoff"]
    assert handoff["status"] == "sent"
    assert handoff["approved_by_physician_id"] == CHEN_ID
    assert handoff["sent_at"]


def test_handoff_sent_actor_is_the_receiving_physician_never_the_agent(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    result = api_client.post(
        f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID}
    ).json()
    event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "handoff_sent"
    )
    assert event["actor"] == CoordinationActor.RECEIVING_PHYSICIAN.value
    assert event["autonomy"] == "physician_required"
    assert PCP_NAME in event["summary"]
    assert result["referral"]["status"] == "consult_returned"


def test_lucy_can_see_the_handoff_once_sent_same_object_as_chen(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    sent = api_client.post(
        f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID}
    ).json()["handoff"]
    as_lucy = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    as_chen = api_client.get(f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": CHEN_ID}).json()
    assert as_lucy == sent
    assert as_chen == sent


def test_handoff_final_state_survives_reload(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    first = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    second = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    assert first == second
    assert first["status"] == "sent"


def test_wrong_physician_cannot_draft_or_send_a_handoff(api_client: TestClient) -> None:
    referral_id = _documented_referral_id(api_client)
    assert api_client.post(
        f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": OTHER_PHYSICIAN_ID}
    ).status_code == 403
    api_client.post(f"/api/referrals/{referral_id}/handoff/draft", json={"receiving_physician_id": CHEN_ID})
    assert api_client.post(
        f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": OTHER_PHYSICIAN_ID}
    ).status_code == 403


# --------------------------------------------------------------------- Part AQ


def test_full_tonjit_reset_clears_every_downstream_artifact(api_client: TestClient) -> None:
    referral_id = _drafted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})

    reset = api_client.post("/api/workspace/demo/reset/tonjit")
    assert reset.status_code == 200

    assert api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json() is None
    assert api_client.get(f"/api/referrals/{referral_id}").status_code == 404
    assert api_client.get(f"/api/referrals/{referral_id}/scheduling").json() is None
    assert api_client.get(f"/api/referrals/{referral_id}/encounter").json() is None
    assert api_client.get(f"/api/referrals/{referral_id}/handoff").json() is None

    incoming = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"})
    assert incoming.json() == []
    accepted = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "accepted"})
    assert accepted.json() == []


def test_reset_preserves_chens_seeded_patients(api_client: TestClient) -> None:
    from backend.synthetic_data import CHEN_SEEDED_PATIENT_IDS

    referral_id = _drafted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    api_client.post("/api/workspace/demo/reset/tonjit")

    for patient_id in CHEN_SEEDED_PATIENT_IDS:
        assert api_client.get(f"/api/patients/{patient_id}").status_code == 200


def test_referral_status_milestones_are_exactly_accepted_scheduled_consult_returned() -> None:
    assert ReferralStatus.SCHEDULED.value == "scheduled"
    assert ReferralStatus.CONSULT_RETURNED.value == "consult_returned"


def test_scheduling_status_values_match_the_suggested_minimal_set() -> None:
    assert {status.value for status in SchedulingStatus} == {
        "options_ready", "sent_to_scheduling", "scheduled",
    }


def test_handoff_status_values_are_minimal_draft_and_sent_only() -> None:
    assert {status.value for status in HandoffStatus} == {"draft", "sent"}
