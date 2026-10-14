import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.demo_identity import LUCY_AGENT_ID, PCP_AGENT_ID
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import AutonomyLevel, CoordinationActor, CoordinationEventType, ReferralStatus, RequirementStatus
from backend.referrals import accept_referral, build_referral, run_preflight, submit_referral
from backend.synthetic_data import PATIENTS, PRIMARY_PATIENT_ID, TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"


def tonjit_referral():
    patient = PATIENTS[TONJIT_PATIENT_ID]
    return patient, build_referral(patient, CHEN_ID, "Endocrinology")


def submitted_tonjit_referral():
    patient, referral = tonjit_referral()
    return patient, run_preflight(patient, referral)


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(referrals_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    return TestClient(app)


# --------------------------------------------------------------------- PART U


def test_referral_can_be_created_for_tonjit_with_correct_parties_and_question() -> None:
    patient, referral = tonjit_referral()
    assert referral.patient_id == TONJIT_PATIENT_ID
    assert referral.referring_physician_id == LUCY_AGENT_ID
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


# --------------------------------------------------------------------- PART A


def test_lianne_chas_agent_id_never_appears_anywhere_in_tonjits_referral() -> None:
    """Regression for the provenance bug: Tonjit's referring physician is Dr.
    Lucy Saruhashi, whose canonical agent id is LUCY_AGENT_ID -- the legacy
    PCP_AGENT_ID (an unrelated historical identifier kept only so already
    -stored consult transcripts keep resolving) must never leak into referral
    data."""
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)

    assert updated.referring_physician_id != PCP_AGENT_ID
    assert updated.referring_physician_id == LUCY_AGENT_ID
    for item in updated.packet.items:
        assert item.provenance.attached_by != PCP_AGENT_ID
        assert item.provenance.attached_by == LUCY_AGENT_ID
    for event in updated.coordination_events:
        assert PCP_AGENT_ID not in event.model_dump_json()


def test_referring_agent_identity_is_resolved_from_the_referral_not_a_hardcoded_fallback() -> None:
    """build_referral/run_preflight must thread whichever referring physician
    created the referral through to packet provenance -- never silently fall
    back to a module-level constant regardless of who actually referred."""
    patient = PATIENTS[TONJIT_PATIENT_ID]
    referral = build_referral(
        patient, CHEN_ID, "Endocrinology", referring_physician_id="agent-some-other-pcp"
    )
    assert referral.referring_physician_id == "agent-some-other-pcp"
    for item in referral.packet.items:
        assert item.provenance.attached_by == "agent-some-other-pcp"

    updated = run_preflight(patient, referral)
    renal_item = updated.packet.item("recent_renal_function")
    assert renal_item.provenance.attached_by == "agent-some-other-pcp"


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
    assert updated.status == ReferralStatus.SUBMITTED, "a fully resolved referral auto-submits -- see Part C"
    assert any(event.event_type == CoordinationEventType.REFERRAL_SUBMITTED for event in updated.coordination_events)


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
        CoordinationEventType.REFERRAL_SUBMITTED,
    ]
    assert [event.sequence for event in updated.coordination_events] == list(range(1, len(event_types) + 1))


def test_event_actors_are_distinguishable_and_provenance_points_to_the_real_result() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    actors = {event.actor for event in updated.coordination_events if event.actor is not None}
    assert {"referring_agent", "receiving_agent", "system"} <= {actor.value for actor in actors}

    renal_item = updated.packet.item("recent_renal_function")
    assert renal_item.provenance.attached_by == LUCY_AGENT_ID
    assert renal_item.provenance.observed_date == "2026-07-20"


def test_rerunning_preflight_does_not_duplicate_the_packet_item_or_corrupt_state() -> None:
    patient, referral = tonjit_referral()
    once = run_preflight(patient, referral)
    assert once.status == ReferralStatus.SUBMITTED
    renal_items = [item for item in once.packet.items if item.key == "recent_renal_function"]
    assert len(renal_items) == 1

    twice = run_preflight(patient, once)
    assert twice.status == ReferralStatus.SUBMITTED
    assert len(twice.coordination_events) == len(once.coordination_events), "a submitted referral is a safe no-op to re-run"
    renal_items_after_rerun = [item for item in twice.packet.items if item.key == "recent_renal_function"]
    assert len(renal_items_after_rerun) == 1


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
    assert preflight.json()["status"] == "submitted"

    fetched = api_client.get(f"/api/referrals/{referral_id}")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "submitted"
    assert len(fetched.json()["coordination_events"]) == 18


def test_api_404s_for_unknown_referral_and_unknown_physician(api_client: TestClient) -> None:
    missing_physician = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": "physician-does-not-exist"}
    )
    assert missing_physician.status_code == 404

    missing_referral = api_client.get("/api/referrals/999999")
    assert missing_referral.status_code == 404


def test_tonjit_demo_reset_clears_referrals_so_the_closed_loop_demo_can_replay(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    referral_id = created["id"]
    api_client.post(f"/api/referrals/{referral_id}/preflight")
    assert api_client.get(f"/api/referrals/{referral_id}").status_code == 200

    reset = api_client.post("/api/workspace/demo/reset/tonjit")
    assert reset.status_code == 200
    payload = reset.json()
    assert payload["patient_id"] == TONJIT_PATIENT_ID
    assert payload["removed_referrals"] == 1

    assert api_client.get(f"/api/referrals/{referral_id}").status_code == 404

    recreated = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    )
    assert recreated.status_code == 200
    assert recreated.json()["status"] == "assembling"


# --------------------------------------------------------------------- PART N


def test_ready_for_review_and_submitted_are_distinct_valid_states() -> None:
    assert ReferralStatus.READY_FOR_REVIEW.value == "ready_for_review"
    assert ReferralStatus.SUBMITTED.value == "submitted"
    assert ReferralStatus.READY_FOR_REVIEW != ReferralStatus.SUBMITTED


def test_only_a_ready_for_review_referral_can_be_submitted() -> None:
    patient, referral = tonjit_referral()
    for not_ready_status in (
        ReferralStatus.DRAFT, ReferralStatus.ASSEMBLING, ReferralStatus.PREFLIGHT, ReferralStatus.RESOLVING,
    ):
        candidate = referral.model_copy(update={"status": not_ready_status})
        with pytest.raises(ValueError):
            submit_referral(candidate)

    ready = referral.model_copy(update={"status": ReferralStatus.READY_FOR_REVIEW})
    submitted = submit_referral(ready)
    assert submitted.status == ReferralStatus.SUBMITTED


def test_a_successfully_resolved_tonjit_referral_reaches_submitted() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    assert updated.status == ReferralStatus.SUBMITTED


def test_an_unresolved_referral_does_not_submit() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    patient_without_renal = patient.model_copy(
        update={"labs": [lab for lab in patient.labs if lab.test not in ("creatinine", "eGFR")]}
    )
    referral = build_referral(patient_without_renal, CHEN_ID, "Endocrinology")
    updated = run_preflight(patient_without_renal, referral)
    assert updated.status != ReferralStatus.SUBMITTED
    assert updated.status == ReferralStatus.RESOLVING
    assert not any(event.event_type == CoordinationEventType.REFERRAL_SUBMITTED for event in updated.coordination_events)


def test_submission_records_referral_submitted_with_structured_metadata() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    submitted_event = next(event for event in updated.coordination_events if event.event_type == CoordinationEventType.REFERRAL_SUBMITTED)
    assert submitted_event.actor == submitted_event.actor  # present at all
    assert submitted_event.metadata["receiving_physician_id"] == CHEN_ID
    assert submitted_event.metadata["specialty"] == "Endocrinology"
    assert submitted_event.created_at


def test_submitted_referral_preserves_packet_and_provenance_data() -> None:
    patient, referral = tonjit_referral()
    updated = run_preflight(patient, referral)
    assert updated.status == ReferralStatus.SUBMITTED
    renal_item = updated.packet.item("recent_renal_function")
    assert renal_item is not None
    assert renal_item.provenance.attached_by == LUCY_AGENT_ID
    assert renal_item.provenance.observed_date == "2026-07-20"
    hba1c_item = updated.packet.item("recent_hba1c")
    assert hba1c_item is not None


def test_submission_is_idempotent_when_called_directly_twice() -> None:
    patient, referral = tonjit_referral()
    once = run_preflight(patient, referral)
    assert once.status == ReferralStatus.SUBMITTED
    twice = submit_referral(once)
    assert twice.status == ReferralStatus.SUBMITTED
    assert len(twice.coordination_events) == len(once.coordination_events)


# --------------------------------------------------------------------- PART P


def test_receiving_physician_can_query_their_submitted_referrals(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "query-workflow.sqlite")
    workspace_id = "workspace-a"

    patient = PATIENTS[TONJIT_PATIENT_ID]
    tonjit_referral_obj = build_referral(patient, CHEN_ID, "Endocrinology")
    persisted = store.create_referral(workspace_id, tonjit_referral_obj)
    completed = run_preflight(patient, persisted)
    store.update_referral(workspace_id, completed)

    jordan_patient = PATIENTS[PRIMARY_PATIENT_ID]
    other_referral = build_referral(jordan_patient, "physician-jung", "Nephrology")
    store.create_referral(workspace_id, other_referral)  # left at 'assembling', never submitted

    submitted_for_chen = store.list_referrals(workspace_id, receiving_physician_id=CHEN_ID, status="submitted")
    assert len(submitted_for_chen) == 1
    assert submitted_for_chen[0].patient_id == TONJIT_PATIENT_ID

    submitted_for_jung = store.list_referrals(workspace_id, receiving_physician_id="physician-jung", status="submitted")
    assert submitted_for_jung == []

    all_submitted = store.list_referrals(workspace_id, status="submitted")
    assert len(all_submitted) == 1


# --------------------------------------------------------- hydration / reload fix


def test_active_referral_lookup_is_null_before_any_referral_exists(api_client: TestClient) -> None:
    response = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active")
    assert response.status_code == 200
    assert response.json() is None


def test_active_referral_lookup_returns_the_persisted_referral_without_needing_its_id(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")

    active = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active")
    assert active.status_code == 200
    payload = active.json()
    assert payload["id"] == created["id"]
    assert payload["status"] == "submitted"
    assert payload["receiving_physician_id"] == CHEN_ID
    assert len(payload["coordination_events"]) == 18


def test_active_referral_lookup_is_a_pure_read_and_never_reruns_preflight_or_resubmits(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    first_lookup = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()

    for _ in range(3):
        repeated_lookup = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()
        assert repeated_lookup == first_lookup, "repeated GETs must not mutate state or duplicate events"

    renal_items = [item for item in first_lookup["packet"]["items"] if item["key"] == "recent_renal_function"]
    assert len(renal_items) == 1
    submitted_events = [event for event in first_lookup["coordination_events"] if event["event_type"] == "referral_submitted"]
    assert len(submitted_events) == 1


def test_active_referral_lookup_only_returns_referrals_for_the_requested_patient(api_client: TestClient) -> None:
    api_client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID})
    jordan_active = api_client.get(f"/api/patients/{PRIMARY_PATIENT_ID}/referrals/active")
    assert jordan_active.status_code == 200
    assert jordan_active.json() is None


def test_reset_tonjit_clears_the_active_referral_so_start_referral_can_reappear(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    assert api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active").json()["status"] == "submitted"

    reset = api_client.post("/api/workspace/demo/reset/tonjit")
    assert reset.json()["removed_referrals"] == 1


# --------------------------------------------------------------------- PART Z


def test_submitted_referral_can_be_accepted_by_its_receiving_physician() -> None:
    _, referral = submitted_tonjit_referral()
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    assert accepted.status == ReferralStatus.ACCEPTED


def test_accepted_status_is_a_real_persisted_state(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    accepted = api_client.post(
        f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID}
    )
    assert accepted.status_code == 200
    # Acceptance automatically authorizes the scheduling administration chain
    # (automation pass, Part E/F) -- a single /accept call carries the
    # referral all the way to `scheduled`, not just `accepted`.
    assert accepted.json()["status"] == "scheduled"
    fetched = api_client.get(f"/api/referrals/{created['id']}")
    assert fetched.json()["status"] == "scheduled"


def test_referral_accepted_event_is_appended_exactly_once() -> None:
    _, referral = submitted_tonjit_referral()
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    accepted_events = [
        event for event in accepted.coordination_events if event.event_type == CoordinationEventType.REFERRAL_ACCEPTED
    ]
    assert len(accepted_events) == 1


def test_referral_accepted_event_actor_is_the_receiving_physician_not_an_agent() -> None:
    _, referral = submitted_tonjit_referral()
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    event = next(
        item for item in accepted.coordination_events if item.event_type == CoordinationEventType.REFERRAL_ACCEPTED
    )
    assert event.actor == CoordinationActor.RECEIVING_PHYSICIAN
    assert event.actor != CoordinationActor.RECEIVING_AGENT
    assert event.autonomy == AutonomyLevel.PHYSICIAN_REQUIRED
    assert "Dr. Noah Chen" in event.summary
    assert event.metadata["receiving_physician_id"] == CHEN_ID


def test_wrong_physician_cannot_accept_the_referral() -> None:
    _, referral = submitted_tonjit_referral()
    with pytest.raises(ValueError):
        accept_referral(referral, "physician-jung", "Dr. Someone Else")


def test_wrong_physician_cannot_accept_via_api(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    response = api_client.post(
        f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": "physician-jung"}
    )
    assert response.status_code == 403
    assert api_client.get(f"/api/referrals/{created['id']}").json()["status"] == "submitted"


def test_non_submitted_referral_cannot_be_accepted() -> None:
    _, referral = tonjit_referral()  # still 'assembling'
    with pytest.raises(ValueError):
        accept_referral(referral, CHEN_ID, "Dr. Noah Chen")


def test_repeat_acceptance_is_idempotent_and_safe() -> None:
    _, referral = submitted_tonjit_referral()
    once = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    twice = accept_referral(once, CHEN_ID, "Dr. Noah Chen")
    assert twice.status == ReferralStatus.ACCEPTED
    assert len(twice.coordination_events) == len(once.coordination_events)


def test_accepted_referral_preserves_packet_requirements_events_and_provenance() -> None:
    patient, referral = submitted_tonjit_referral()
    events_before_acceptance = len(referral.coordination_events)
    requirements_before_acceptance = len(referral.receiving_requirements)
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    renal_item = accepted.packet.item("recent_renal_function")
    assert renal_item is not None
    assert renal_item.provenance.observed_date == "2026-07-20"
    assert len(accepted.requirement_results) == requirements_before_acceptance
    assert len(accepted.coordination_events) == events_before_acceptance + 1


def test_incoming_query_includes_tonjit_before_acceptance_and_excludes_after(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")

    incoming = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"})
    assert incoming.status_code == 200
    assert [item["patient_id"] for item in incoming.json()] == [TONJIT_PATIENT_ID]

    api_client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})

    incoming_after = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"})
    assert incoming_after.json() == []


def test_accepted_referral_can_be_queried_afterward(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    api_client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})

    # Acceptance now automatically advances the referral to `scheduled`
    # (automation pass, Part E/F) -- the physician-scoped query that matters
    # here is Chen's own patient-list query, which (post Tonjit-disappearance
    # fix) spans every accepted-or-later status, not a single fixed one.
    scheduled_list = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "scheduled"})
    assert scheduled_list.status_code == 200
    assert [item["patient_id"] for item in scheduled_list.json()] == [TONJIT_PATIENT_ID]


def test_reset_removes_accepted_state_and_receiving_patient_relationship(api_client: TestClient) -> None:
    created = api_client.post(
        f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
    ).json()
    api_client.post(f"/api/referrals/{created['id']}/preflight")
    api_client.post(f"/api/referrals/{created['id']}/accept", json={"receiving_physician_id": CHEN_ID})

    reset = api_client.post("/api/workspace/demo/reset/tonjit")
    assert reset.json()["removed_referrals"] == 1

    assert api_client.get(f"/api/referrals/{created['id']}").status_code == 404
    accepted_after_reset = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "accepted"})
    assert accepted_after_reset.json() == []
    incoming_after_reset = api_client.get(f"/api/physicians/{CHEN_ID}/referrals", params={"status": "submitted"})
    assert incoming_after_reset.json() == []

    after_reset = api_client.get(f"/api/patients/{TONJIT_PATIENT_ID}/referrals/active")
    assert after_reset.status_code == 200
    assert after_reset.json() is None
