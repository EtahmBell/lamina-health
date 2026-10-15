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
from backend.models import (
    AutonomyLevel,
    CoordinationActor,
    CoordinationEventType,
    HandoffStatus,
    ReferralStatus,
    SchedulingStatus,
)
from backend.referrals import (
    accept_referral,
    build_referral,
    find_scheduling_options,
    ingest_consultation_encounter,
    route_options_to_scheduling,
    run_preflight,
)
from backend.synthetic_data import PATIENTS, TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"
OTHER_PHYSICIAN_ID = "physician-jung"


def _accepted_tonjit_referral():
    """Pure-domain accepted referral, stopped exactly at `accepted` -- the
    HTTP /accept endpoint now auto-chains the scheduling administration
    immediately (automation pass, Part E/F), so there is no longer a way to
    observe an "accepted but not yet scheduled" referral through the public
    API. This bypasses that endpoint to unit-test find_scheduling_options /
    route_options_to_scheduling / ingest_consultation_encounter's OWN guards
    and behavior in isolation; the endpoint's orchestration of them has its
    own dedicated integration tests further down this file."""
    patient = PATIENTS[TONJIT_PATIENT_ID]
    referral = run_preflight(patient, build_referral(patient, CHEN_ID, "Endocrinology"))
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    return patient, accepted


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
    # Acceptance automatically authorizes the scheduling administration chain
    # (automation pass, Part E/F) -- by the time this is fetched, the SAME
    # referral Lucy hydrates has already progressed to `scheduled`, not just
    # `accepted`.
    assert active["status"] == "scheduled"
    assert active["id"] == referral_id
    event_types = [event["event_type"] for event in active["coordination_events"]]
    assert "referral_accepted" in event_types
    assert "appointment_scheduled" in event_types
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


def test_returned_options_are_structured_synthetic_availability() -> None:
    """Unit-level (Part AN): find_scheduling_options's own behavior, tested
    against a pure accepted-but-not-yet-scheduled referral -- see
    _accepted_tonjit_referral's docstring for why this bypasses HTTP."""
    _, referral = _accepted_tonjit_referral()
    scheduling = find_scheduling_options(referral, CHEN_ID, "Dr. Noah Chen", None)
    assert scheduling.status == SchedulingStatus.OPTIONS_READY
    assert len(scheduling.options) == 3
    for slot in scheduling.options:
        assert slot.appointment_type == "New Endocrinology consultation"
        assert slot.duration_minutes > 0
        assert slot.location
        assert slot.starts_at
    event = next(
        event for event in referral.coordination_events
        if event.event_type == CoordinationEventType.SCHEDULING_OPTIONS_FOUND
    )
    assert event.actor == CoordinationActor.RECEIVING_AGENT
    assert event.autonomy == AutonomyLevel.AUTOMATIC


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


def test_sending_options_to_scheduling_persists_routing_state() -> None:
    """Unit-level (Part AN): routing is now administrative agent-workflow
    work, never a physician decision (automation pass, Part E/F/L) -- actor
    changed from receiving_physician/physician_required to
    receiving_agent/automatic."""
    _, referral = _accepted_tonjit_referral()
    scheduling = find_scheduling_options(referral, CHEN_ID, "Dr. Noah Chen", None)
    route_options_to_scheduling(referral, scheduling, CHEN_ID, "Dr. Noah Chen")
    sent_event = next(
        event for event in referral.coordination_events
        if event.event_type == CoordinationEventType.SCHEDULING_OPTIONS_SENT
    )
    assert sent_event.actor == CoordinationActor.RECEIVING_AGENT
    assert sent_event.autonomy == AutonomyLevel.AUTOMATIC


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


def test_the_confirmed_synthetic_appointment_is_a_reasonable_daytime_clinic_hour(
    api_client: TestClient,
) -> None:
    """Bug-fix pass, Part B/U: the confirmed appointment (always options[0],
    see confirm_synthetic_appointment) must read as a normal outpatient
    clinic hour everywhere it's displayed, not an unrealistic hour like
    3:30 AM. The root cause was storing a clinic-local wall-clock time but
    tagging it as UTC, which the frontend then silently shifted when
    converting to the viewing browser's own local timezone. The fix stores a
    naive (no UTC offset) datetime instead, so every consumer -- Lucy, Chen,
    scheduling details, history -- parses and displays the exact same
    structured hour/minute with no hidden conversion."""
    referral_id = _accepted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/scheduling/options", json={"receiving_physician_id": CHEN_ID})
    routed = api_client.post(
        f"/api/referrals/{referral_id}/scheduling/route", json={"receiving_physician_id": CHEN_ID}
    ).json()
    starts_at = routed["scheduling"]["selected_option"]["starts_at"]
    assert starts_at.endswith("15:30"), f"expected a 3:30 PM clinic time, got {starts_at!r}"
    assert "+" not in starts_at and "Z" not in starts_at, (
        "starts_at must carry no UTC offset -- a naive clinic-local wall-clock time, "
        "so the frontend never silently reinterprets it in the viewer's own timezone"
    )
    hour = int(starts_at.split("T")[1].split(":")[0])
    assert 7 <= hour <= 18, f"expected a normal outpatient clinic hour, got hour={hour}"


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


def test_encounter_cannot_be_ingested_before_scheduled() -> None:
    """Unit-level (Part AO): ingest_consultation_encounter's own guard --
    the HTTP /accept endpoint auto-schedules immediately now, so an
    accepted-but-not-yet-scheduled referral can no longer be reached through
    the public API; this still exercises the defensive guard directly."""
    _, referral = _accepted_tonjit_referral()
    with pytest.raises(ValueError):
        ingest_consultation_encounter(referral, CHEN_ID, None)


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


# ------------------------------------------------------- Automation pass (Parts E-T)
#
# Product principle: automate coordination, preserve physician decisions.
# Acceptance and encounter-ingestion each now authorize an automatic
# administrative chain that used to require extra physician clicks (Part L:
# the only remaining meaningful physician actions in this whole closed loop
# are choosing/starting a referral, accepting it, and reviewing+sending the
# clinical handoff).


def test_accepting_a_referral_automatically_runs_the_entire_scheduling_chain_with_no_manual_clicks(
    api_client: TestClient,
) -> None:
    """Part S: no manual "Find appointment options"/"Send to scheduling"
    step is required -- a single POST /accept reaches `scheduled` directly."""
    referral_id = _submitted_referral_id(api_client)
    response = api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    assert response.status_code == 200
    referral = response.json()
    assert referral["status"] == "scheduled"

    scheduling = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    assert scheduling is not None
    assert scheduling["status"] == "scheduled"
    assert scheduling["selected_option"] is not None
    assert scheduling["source"] == "synthetic_demo"

    event_types = [event["event_type"] for event in referral["coordination_events"]]
    assert event_types.index("referral_accepted") < event_types.index("scheduling_options_found")
    assert event_types.index("scheduling_options_found") < event_types.index("scheduling_options_sent")
    assert event_types.index("scheduling_options_sent") < event_types.index("appointment_scheduled")


def test_automatic_scheduling_events_carry_the_correct_actor_and_autonomy_provenance(
    api_client: TestClient,
) -> None:
    """Part F/S: finding and routing options are administrative agent
    work, never attributed to the physician; confirmation is attributed to
    the synthetic scheduling workflow, never the agent or physician."""
    referral_id = _submitted_referral_id(api_client)
    referral = api_client.post(
        f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID}
    ).json()
    events_by_type = {event["event_type"]: event for event in referral["coordination_events"]}

    found = events_by_type["scheduling_options_found"]
    assert found["actor"] == "receiving_agent"
    assert found["autonomy"] == "automatic"

    sent = events_by_type["scheduling_options_sent"]
    assert sent["actor"] == "receiving_agent"
    assert sent["autonomy"] == "automatic"

    scheduled = events_by_type["appointment_scheduled"]
    assert scheduled["actor"] == "scheduling_workflow"
    assert scheduled["autonomy"] == "automatic"

    accepted_event = events_by_type["referral_accepted"]
    assert accepted_event["actor"] == "receiving_physician"
    assert accepted_event["autonomy"] == "physician_required"


def test_accepting_an_already_scheduled_referral_again_is_a_safe_no_op(api_client: TestClient) -> None:
    """Part N/S: a rerun/retry of /accept (e.g. a reload racing a real
    response, or a defensive client retry) must never duplicate scheduling
    options or coordination events."""
    referral_id = _submitted_referral_id(api_client)
    first = api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID}).json()
    second = api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID}).json()

    assert second["status"] == "scheduled"
    assert first["coordination_events"] == second["coordination_events"]

    first_scheduling = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    second_scheduling = api_client.get(f"/api/referrals/{referral_id}/scheduling").json()
    assert first_scheduling == second_scheduling
    assert len(first_scheduling["options"]) == 3


def test_chen_remains_in_his_active_patient_query_through_automatic_scheduling(api_client: TestClient) -> None:
    """Part S: the Tonjit-disappearance fix and the scheduling automation
    must compose correctly -- Chen's active-patient query still finds the
    patient immediately after accept, now at `scheduled` rather than
    `accepted`."""
    referral_id = _submitted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/accept", json={"receiving_physician_id": CHEN_ID})
    all_referrals = api_client.get(f"/api/physicians/{CHEN_ID}/referrals").json()
    assert [item["patient_id"] for item in all_referrals] == [TONJIT_PATIENT_ID]
    assert all_referrals[0]["status"] == "scheduled"


def test_encounter_ingestion_automatically_drafts_the_handoff_with_no_manual_click(
    api_client: TestClient,
) -> None:
    """Part T: no manual "Draft handoff" step is required -- a single POST
    /encounter/ingest produces both the encounter and a draft handoff."""
    referral_id = _scheduled_referral_id(api_client)
    assert api_client.get(f"/api/referrals/{referral_id}/handoff").status_code == 200
    assert api_client.get(f"/api/referrals/{referral_id}/handoff").json() is None

    result = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    encounter = result["encounter"]

    handoff = api_client.get(
        f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": CHEN_ID}
    ).json()
    assert handoff is not None
    assert handoff["status"] == "draft"
    assert handoff["encounter_id"] == encounter["id"]
    assert handoff["drafted_by_agent_id"]

    event_types = [event["event_type"] for event in result["referral"]["coordination_events"]]
    assert "consultation_ingested" in event_types
    assert "handoff_drafted" in event_types
    assert event_types.index("consultation_ingested") < event_types.index("handoff_drafted")


def test_auto_drafted_handoff_event_is_attributed_to_the_receiving_agent_automatically(
    api_client: TestClient,
) -> None:
    """Part K: handoff_drafted is always actor=receiving agent,
    autonomy=automatic -- never the physician, who has not reviewed
    anything yet at this point."""
    referral_id = _scheduled_referral_id(api_client)
    result = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    drafted_event = next(
        event for event in result["referral"]["coordination_events"]
        if event["event_type"] == "handoff_drafted"
    )
    assert drafted_event["actor"] == "receiving_agent"
    assert drafted_event["autonomy"] == "automatic"


def test_lucy_cannot_see_the_auto_drafted_handoff_before_chen_sends_it(api_client: TestClient) -> None:
    """Part T: automatic drafting must never weaken the existing access
    gate -- the referring side still cannot see a draft, only a sent one."""
    referral_id = _scheduled_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})

    as_nobody = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    assert as_nobody is None
    as_other_physician = api_client.get(
        f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": OTHER_PHYSICIAN_ID}
    ).json()
    assert as_other_physician is None

    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    now_visible = api_client.get(f"/api/referrals/{referral_id}/handoff").json()
    assert now_visible is not None
    assert now_visible["status"] == "sent"


def test_re_ingesting_an_encounter_does_not_re_draft_the_handoff(api_client: TestClient) -> None:
    """Part N/T: a reload/rerun of the encounter-ingest demo control must
    never produce a second draft or a second handoff_drafted event."""
    referral_id = _scheduled_referral_id(api_client)
    first = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    second = api_client.post(
        f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID}
    ).json()
    assert first["encounter"] == second["encounter"]

    drafted_events = [
        event for event in second["referral"]["coordination_events"]
        if event["event_type"] == "handoff_drafted"
    ]
    assert len(drafted_events) == 1

    handoff = api_client.get(f"/api/referrals/{referral_id}/handoff", params={"as_physician_id": CHEN_ID}).json()
    assert handoff is not None
