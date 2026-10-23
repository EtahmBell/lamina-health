"""Routing + learning consolidation pass.

Three distinct routing computations -- patient need, physician-case fit,
route fit -- with similar-patient history as a first-class, privacy-safe
fit signal; modality-specific capacity; no displacement of booked patients;
and clarification cards that arise from work and still require physician
confirmation before anything becomes operational.
"""

from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.agents import build_care_routing, build_physician_fits, compare_routes, consult_network, patient_need
from backend.agents.care_routing import PHYSICIAN_ACCESS_PROFILES, resolve_econsult_policy
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.clinical import build_patient_context
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import ModalityViability, PhysicianCaseFit
from backend.physicians import assess_physician_case_fit
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
)
from backend.referrals import accept_referral, build_referral, find_scheduling_options
from backend.referrals.scheduling import open_slots, synthetic_chen_availability
from backend.synthetic_data import PATIENTS, PHYSICIAN_CHEN, PHYSICIANS_BY_PATIENT, TONJIT_PATIENT_ID, resolve_case_rules
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import teach_and_confirm_chen_baseline

CHEN_ID = PHYSICIAN_CHEN.id
MAYA_ID = "physician-ramanathan"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    for module in (referral_preferences_api, referrals_api, consult_api, engagement_api, workspace_api, specialist_api, demo_workspace_module):
        monkeypatch.setattr(module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(
        referral_preferences_api,
        "referral_preference_interpretation_service",
        ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False)),
    )
    return value


def _bootstrap(client: TestClient) -> str:
    client.get("/api/patients")
    return client.cookies[DEFAULT_COOKIE_NAME]


def _context():
    return build_patient_context(PATIENTS[TONJIT_PATIENT_ID])


def _tonjit():
    return consult_network(PATIENTS[TONJIT_PATIENT_ID], PHYSICIANS_BY_PATIENT[TONJIT_PATIENT_ID])


def _fit(physician_id: str, **update) -> PhysicianCaseFit:
    fit = next(item for item in build_physician_fits(_context()) if item.physician_id == physician_id)
    return fit.model_copy(update=update)


def _focused_question_need():
    """A focused medication-management question with complete data: the
    patient need itself makes BOTH modalities clinically viable."""
    return patient_need(_context()).model_copy(update={
        "suggested_priority": "routine",
        "modality_viability": ModalityViability(
            visit="viable", econsult="viable", basis="Focused medication question with complete recent data."
        ),
    })


# ------------------------------------------------------------------ ROUTING 1-10


def test_patient_need_and_physician_fit_are_distinct_computations() -> None:
    """Patient need never reads any physician's preference: its modality
    viability and priority are identical whatever Chen has confirmed."""
    context = _context()
    viabilities = {
        build_care_routing(context, confirmed).modality_viability.model_dump_json()
        for confirmed in (None, "in_person", "econsult", "either")
    }
    priorities = {build_care_routing(context, confirmed).suggested_priority for confirmed in (None, "econsult")}
    assert len(viabilities) == 1
    assert priorities == {"soon"}
    need_fields = set(patient_need(context).model_dump())
    assert not need_fields & {"receiving_fit", "econsult_policy", "similar_case_patterns", "physician_id"}


def test_patient_need_can_mark_both_visit_and_econsult_viable() -> None:
    need = _focused_question_need()
    assert need.modality_viability.visit == "viable"
    assert need.modality_viability.econsult == "viable"
    tonjit = patient_need(_context()).modality_viability
    assert (tonjit.visit, tonjit.econsult) == ("viable", "conditional")


def test_physician_modality_policy_narrows_viable_routes() -> None:
    need = _focused_question_need()
    for policy in ("not_offered", "unknown"):
        routes = compare_routes(need, [_fit(CHEN_ID, econsult_policy=policy)])
        assert {route.modality for route in routes} == {"in_person"}, policy
    routes = compare_routes(need, [_fit(CHEN_ID, econsult_policy="acceptable")])
    assert {route.modality for route in routes} == {"in_person", "econsult"}


def test_route_fit_compares_physician_and_modality_combinations() -> None:
    routes = [route for route in _tonjit().candidate_routes if route.network_participation != "external_directory"]
    assert {(route.physician_id, route.modality) for route in routes} == {
        (CHEN_ID, "in_person"), (CHEN_ID, "econsult"), (MAYA_ID, "in_person"),
    }
    assert [(route.physician_id, route.modality) for route in routes if route.recommended] == [(CHEN_ID, "in_person")]


def test_access_lowers_route_utility_without_changing_clinical_fit() -> None:
    """Part C: a 35-day visit wait moves the recommendation to a comparably
    suitable physician with timely access -- Chen's fit is untouched."""
    need = patient_need(_context())
    fits = build_physician_fits(_context())
    busy = {**PHYSICIAN_ACCESS_PROFILES, CHEN_ID: PHYSICIAN_ACCESS_PROFILES[CHEN_ID].model_copy(
        update={"in_person_wait_days": 35, "in_person_wait_label": "Approximately 35 days"}
    )}
    normal = compare_routes(need, fits)
    crowded = compare_routes(need, fits, access_profiles=busy)
    assert next(route for route in normal if route.recommended).physician_id == CHEN_ID
    assert next(route for route in crowded if route.recommended).physician_id == MAYA_ID
    assert {route.fit_label for route in crowded if route.physician_id == CHEN_ID} == {"strong"}
    assert build_physician_fits(_context()) == fits  # fit is computed without access at all


def test_similar_patient_history_materially_contributes_to_physician_fit() -> None:
    context = _context()
    with_history = resolve_case_rules(PHYSICIAN_CHEN, context)
    without_history = with_history.model_copy(update={"historical_cases": []})
    strong = assess_physician_case_fit(context, "Endocrinology", PHYSICIAN_CHEN, with_history)
    weaker = assess_physician_case_fit(context, "Endocrinology", PHYSICIAN_CHEN, without_history)
    assert strong.receiving_fit == "strong"
    assert weaker.receiving_fit == "moderate"
    assert strong.similar_case_patterns and not weaker.similar_case_patterns
    # ...and it decides between otherwise-identical physicians.
    twin = strong.model_copy(update={"physician_id": MAYA_ID, "physician_name": "Dr. Twin", "receiving_fit": "moderate", "similar_case_patterns": []})
    equal_access = {CHEN_ID: PHYSICIAN_ACCESS_PROFILES[CHEN_ID], MAYA_ID: PHYSICIAN_ACCESS_PROFILES[CHEN_ID]}
    routes = compare_routes(patient_need(context), [twin, strong], access_profiles=equal_access)
    assert next(route for route in routes if route.recommended).physician_id == CHEN_ID


def test_similar_case_patterns_only_count_when_every_feature_matches() -> None:
    """A focused-medication-question pattern shares the diagnosis but is not
    comparable to worsening disease despite escalation."""
    fit = _fit(CHEN_ID)
    assert all("focused" not in pattern.casefold() for pattern in fit.similar_case_patterns)
    assert len(fit.similar_case_patterns) == 2


def test_no_prior_patient_identity_or_counts_appear_in_match_explanations() -> None:
    result = _tonjit()
    blob = json.dumps([
        *[fit.model_dump() for fit in result.physician_fits],
        *[route.model_dump(mode="json") for route in result.candidate_routes],
    ])
    for patient in PATIENTS.values():
        assert patient.id not in blob
        assert patient.display_name.replace(" (synthetic)", "") not in blob
    for seeded_name in ("Elena Martinez", "Daniel Cho", "Maya Thompson", "Robert Greene", "Aisha Khan", "Peter Wallace"):
        assert seeded_name not in blob
    assert not re.search(r"\d+\s+(similar|comparable)", blob)
    chen = next(fit for fit in result.physician_fits if fit.physician_id == CHEN_ID)
    history = next(item for item in chen.evidence if item.category == "similar_case_experience")
    assert "privacy-preserving" in history.source


def test_case_interest_is_useful_but_not_the_only_fit_signal() -> None:
    plain = build_physician_fits(_context())
    with_interest = build_physician_fits(
        _context(), case_interest_titles_by_physician={CHEN_ID: ["Complex type 2 diabetes"]}
    )
    chen_plain = next(fit for fit in plain if fit.physician_id == CHEN_ID)
    chen_interest = next(fit for fit in with_interest if fit.physician_id == CHEN_ID)
    assert chen_plain.receiving_fit == "strong"  # without any case interest
    assert {item.category for item in chen_plain.evidence} >= {"specialty_scope", "similar_case_experience", "referral_preference"}
    assert any(item.category == "case_interest" for item in chen_interest.evidence)
    assert (chen_interest.clinical_fit, chen_interest.receiving_fit) == (chen_plain.clinical_fit, chen_plain.receiving_fit)


def test_tonjit_why_chen_includes_similar_patient_evidence(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        result = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
    chen = next(fit for fit in result["physician_fits"] if fit["physician_id"] == CHEN_ID)
    categories = [item["category"] for item in chen["evidence"]]
    assert "similar_case_experience" in categories
    history = next(item for item in chen["evidence"] if item["category"] == "similar_case_experience")
    assert "comparable patients" in history["summary"]
    assert "worsening" in history["summary"] or "despite oral medication escalation" in history["summary"]
    recommended = next(route for route in result["candidate_routes"] if route["recommended"])
    assert (recommended["physician_id"], recommended["modality"]) == (CHEN_ID, "in_person")
    access = next(item for item in recommended["route_evidence"] if item["category"] == "access_capacity")
    assert "~10 days" in access["summary"]


def test_no_numeric_physician_value_is_required_or_exposed() -> None:
    result = _tonjit()
    for fit in result.physician_fits:
        dumped = fit.model_dump()
        assert not any(isinstance(value, (int, float)) and not isinstance(value, bool) for value in dumped.values())
    assert "score" not in result.model_dump_json().lower()


def test_maya_has_no_fabricated_similar_case_history() -> None:
    maya = _fit(MAYA_ID)
    assert maya.similar_case_patterns == []
    assert maya.receiving_fit == "unknown"
    history = next(item for item in maya.evidence if item.category == "similar_case_experience")
    assert history.summary.startswith("No similar-case history")


# ------------------------------------------------------------- MODALITY / RESOURCES


def test_econsult_is_preferred_only_when_appropriate_and_consistent_with_policy() -> None:
    need = _focused_question_need()
    routes = compare_routes(need, [_fit(CHEN_ID, econsult_policy="acceptable")])
    recommended = next(route for route in routes if route.recommended)
    assert recommended.modality == "econsult"
    visit = next(route for route in routes if route.modality == "in_person")
    assert "examination" in visit.rationale  # e-consult is never a dead end
    # Tonjit: worsening despite escalation + Chen prefers in-person -> visit,
    # even though e-consult is faster.
    tonjit = next(route for route in _tonjit().candidate_routes if route.recommended)
    assert tonjit.modality == "in_person"


def test_confirmed_either_keeps_the_in_person_boundary_for_worsening_disease() -> None:
    policy, _source = resolve_econsult_policy(CHEN_ID, _context(), "either")
    assert policy == "possible_not_preferred"
    assert build_care_routing(_context(), "either").recommended_modality == "in_person"
    assert build_care_routing(_context(), "econsult").recommended_modality == "econsult"


def test_visit_and_econsult_capacity_stay_separate_resources() -> None:
    routes = [route for route in _tonjit().candidate_routes if route.physician_id == CHEN_ID]
    sources = {route.modality: next(item.source for item in route.route_evidence if item.category == "access_capacity") for route in routes}
    assert sources["in_person"].startswith("Visit capacity")
    assert sources["econsult"].startswith("E-consult capacity")
    access = PHYSICIAN_ACCESS_PROFILES[CHEN_ID]
    assert (access.in_person_wait_days, access.econsult_response_days) == (10, 2)


# ---------------------------------------------------------- PRIORITY / DISPLACEMENT


def test_tonjit_soon_is_protocol_grounded_and_only_a_suggestion() -> None:
    routing = _tonjit().care_routing
    assert routing.suggested_priority == "soon"
    assert "Protocol-grounded" in routing.priority_basis
    assert "referring clinician" in routing.priority_basis


def test_higher_priority_incoming_demand_never_displaces_a_booked_appointment() -> None:
    slots = synthetic_chen_availability()
    booked = frozenset({slots[0].slot_id})
    assert [slot.slot_id for slot in open_slots(slots, booked)] == [slot.slot_id for slot in slots[1:]]

    patient = PATIENTS[TONJIT_PATIENT_ID]
    referral = build_referral(patient, CHEN_ID, "Endocrinology", priority="urgent")
    referral.id = 99
    referral.status = "submitted"
    accepted = accept_referral(referral, CHEN_ID, "Dr. Noah Chen")
    options = find_scheduling_options(accepted, CHEN_ID, "Dr. Noah Chen", None, booked)
    assert slots[0].slot_id not in {slot.slot_id for slot in options.options}

    everything_booked = frozenset(slot.slot_id for slot in slots)
    with pytest.raises(ValueError, match="No booked appointment is displaced"):
        find_scheduling_options(accepted, CHEN_ID, "Dr. Noah Chen", None, everything_booked)


# --------------------------------------------------------------------- DEMO 39


def test_renal_coordination_works_with_no_manual_training(store: WorkflowStore) -> None:
    """Part Y: Chen's agent requires recent renal function and Lucy's agent
    attaches the existing result -- before Chen has taught anything."""
    with TestClient(app) as client:
        _bootstrap(client)
        created = client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals",
            json={"receiving_physician_id": CHEN_ID, "priority": "soon"},
        ).json()
        assert any(item["key"] == "recent_renal_function" for item in created["receiving_requirements"])
        ready = client.post(f"/api/referrals/{created['id']}/preflight").json()
    renal = next(check for check in ready["requirement_results"] if check["key"] == "recent_renal_function")
    assert renal["status"] == "satisfied"
    assert ready["priority"] == "soon"


# -------------------------------------------------------------------- LEARNING


def test_clarification_cards_carry_source_and_reason(store: WorkflowStore) -> None:
    card = clarification_opportunities(store, "ws-card", CHEN_ID)[0]
    for key in ("source", "source_label", "reason", "yes_statement", "no_statement", "depends_prompt"):
        assert card[key]
    assert card["response_type"] == "yes_no_depends"


def test_a_clarification_draft_is_not_operational_until_confirmed_and_keeps_requirements(store: WorkflowStore) -> None:
    url = "/api/workspace/physician/chen/referral-preferences"
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        card = clarification_opportunities(store, ws, CHEN_ID)[0]
        draft = client.post(f"{url}/interpret", json={"source_text": card["yes_statement"], "clarifies": "modality"}).json()
        assert draft["status"] == "draft"
        # Merged onto the confirmed preference: requirements are carried over.
        assert {item["key"] for item in draft["structured_rules"]["required"]} >= {"recent_renal_function"}
        assert {rule["modality"] for rule in draft["structured_rules"]["modality_rules"]} == {"econsult", "in_person"}
        # A draft changes nothing.
        assert len(clarification_opportunities(store, ws, CHEN_ID)) == 1
        consult = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
        chen_econsult = next(r for r in consult["candidate_routes"] if r["physician_id"] == CHEN_ID and r["modality"] == "econsult")
        assert chen_econsult["recommended"] is False

        client.post(f"{url}/{draft['id']}/confirm")
        assert clarification_opportunities(store, ws, CHEN_ID) == []
        confirmed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert "recent_renal_function" in confirmed["structured_rules_json"]


def test_a_modality_only_clarification_never_drops_the_requirement_baseline(store: WorkflowStore) -> None:
    url = "/api/workspace/physician/chen/referral-preferences"
    with TestClient(app) as client:
        ws = _bootstrap(client)
        card = clarification_opportunities(store, ws, CHEN_ID)[0]
        draft = client.post(f"{url}/interpret", json={"source_text": card["no_statement"], "clarifies": "modality"}).json()
        client.post(f"{url}/{draft['id']}/confirm")
        referral = client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
        ).json()
    assert any(item["key"] == "recent_renal_function" for item in referral["receiving_requirements"])


def test_running_test_never_mutates_the_practice_representation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        before = client.get("/api/workspace/physician/agent-representation?perspective=chen").json()
        client.post(
            "/api/workspace/physician/agent-chat?perspective=chen",
            json={"mode": "synthetic_case", "message": "How would I handle this?",
                  "controlled_test_case_id": "chen-test-worsening-escalation", "origin": "synthetic_demo"},
        )
        after = client.get("/api/workspace/physician/agent-representation?perspective=chen").json()
    assert before["sections"] == after["sections"]
