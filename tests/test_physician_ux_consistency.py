"""Physician UX consistency + NLP interpreter pass: every claimed physician's
Network is the same projection over their OWN roster, Ask the Network never
matches the asker, and the generic interpreter understands prior-treatment /
reason-discontinued preferences with the right strength -- additively, so
confirming one never removes the rest of a physician's representation.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import ReferralPacket
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
    deterministic_interpret,
    effective_confirmed_rules,
    requirement_override_for_referral,
)
from backend.referrals.requirements import evaluate_requirements
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PHYSICIAN_CHEN
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import document_chen_consultation, teach_and_confirm_chen_baseline

CHEN_ID = PHYSICIAN_CHEN.id
CHEN_NPI = "9900000005"
PREFERENCES = "/api/workspace/physician/chen/referral-preferences"
MEDICATION_HISTORY = (
    "If a patient has tried other diabetes medications before, I’d like the reason they were stopped "
    "included when it’s available."
)
THYROID = "For new thyroid referrals, I prefer the most recent TSH and free T4 available before review."
EXPECTED_HELPFUL = {
    ("prior_diabetes_medication_trials", "Prior diabetes medication trials"),
    ("diabetes_medication_discontinuation_reason", "Reason each diabetes medication was stopped, when known"),
}


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


def _sections(client: TestClient) -> dict:
    return client.get("/api/workspace/physician/agent-representation?perspective=chen").json()["sections"]


def _teach(client: TestClient, text: str, **extra) -> dict:
    draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": text, **extra}).json()
    confirmed = client.post(f"{PREFERENCES}/{draft['id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


# ------------------------------------------------------------------ NETWORK 1-7


def test_every_claimed_physician_gets_the_same_network_projection_over_their_own_roster(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        lucy = client.get("/api/workspace/network").json()
        chen = client.get("/api/workspace/network?perspective=chen").json()
        iain = client.get("/api/workspace/network?perspective=iain").json()
    for network in (lucy, chen, iain):
        assert set(network) >= {"center", "nodes", "edges", "members"}
    assert chen["center"]["name"] == "Dr. Noah Chen's Agent"
    # A physician never appears in their own Colleagues list.
    assert CHEN_NPI not in {node["npi"] for node in chen["nodes"]}
    assert "9900000001" not in {node["npi"] for node in iain["nodes"]}
    # Data differs by identity; shape does not.
    in_network = lambda network: {node["npi"] for node in network["nodes"] if node["in_network"]}  # noqa: E731
    assert in_network(chen) and in_network(chen) != in_network(lucy)


def test_adding_a_colleague_only_changes_that_physicians_roster(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        lucy_before = client.get("/api/workspace/network/members").json()
        added = client.post("/api/workspace/network/members?perspective=chen", json={"npi": "9900000001"})
        chen_after = client.get("/api/workspace/network/members?perspective=chen").json()
        lucy_after = client.get("/api/workspace/network/members").json()
        removed = client.delete("/api/workspace/network/members/9900000001?perspective=chen")
        unknown = client.get("/api/workspace/network?perspective=nobody")
    assert added.status_code == 201
    assert "9900000001" in {member["npi"] for member in chen_after}
    assert lucy_after == lucy_before
    assert removed.status_code == 204
    assert unknown.status_code == 404


def test_each_physicians_feed_follows_their_own_roster(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        before = client.get("/api/workspace/network/feed?perspective=chen").json()["items"]
        client.post("/api/workspace/network/members?perspective=chen", json={"npi": "9900000001"})  # Iain
        after = client.get("/api/workspace/network/feed?perspective=chen").json()["items"]
    assert "iain" not in {item["physician"]["id"] for item in before}
    assert "iain" in {item["physician"]["id"] for item in after}


def test_ask_the_network_never_matches_the_asking_physician(store: WorkflowStore) -> None:
    question = "Who can help with a complex type 2 diabetes referral?"
    with TestClient(app) as client:
        _bootstrap(client)
        as_lucy = client.post("/api/workspace/network/ask", json={"question": question}).json()
        as_chen = client.post("/api/workspace/network/ask", json={"question": question, "perspective": "chen"}).json()
        ckd = client.post("/api/workspace/network/ask", json={"question": "Who is a good fit for CKD with resistant hypertension?", "perspective": "chen"}).json()
    assert CHEN_ID in {match["physician_id"] for match in as_lucy["physician_agents"]}
    assert CHEN_ID not in {match["physician_id"] for match in as_chen["physician_agents"]}
    assert ckd["physician_agents"][0]["physician_id"] == "physician-jung"


# ----------------------------------------------------------------------- NLP 16-28


def test_the_reported_sentence_is_interpreted_as_helpful_prior_treatment_history() -> None:
    rules = deterministic_interpret(MEDICATION_HISTORY, CHEN_SEED_CASE_FAMILY)
    assert {(item.key, item.label) for item in rules.helpful} == EXPECTED_HELPFUL
    assert rules.required == []
    assert all(item.required is False for item in rules.helpful)


@pytest.mark.parametrize("text", [
    "If they've tried diabetes medications before, I'd like to know why they were stopped when available.",
    "Prior diabetes medication failures and reasons for stopping are helpful when known.",
    "When available, include previous diabetes medications and why they were discontinued.",
])
def test_paraphrases_map_to_the_same_helpful_semantics(text: str) -> None:
    rules = deterministic_interpret(text, CHEN_SEED_CASE_FAMILY)
    assert {(item.key, item.label) for item in rules.helpful} == EXPECTED_HELPFUL
    assert rules.required == []


@pytest.mark.parametrize(("text", "subject"), [
    ("If they've tried antihypertensives before, I'd like to know why they were stopped when that information is available.", "antihypertensive"),
    ("For patients who've previously used GLP-1 medications, include why they discontinued them when known.", "GLP-1 medication"),
    ("If they've had prior biologic therapy, it helps to know why it was stopped.", "biologic therapy"),
])
def test_the_pattern_is_generic_across_therapy_classes(text: str, subject: str) -> None:
    rules = deterministic_interpret(text, CHEN_SEED_CASE_FAMILY)
    labels = [item.label for item in rules.helpful]
    assert labels[1] == f"Reason each {subject} was stopped, when known"
    assert rules.required == []


def test_intolerance_language_is_kept_and_stays_helpful() -> None:
    rules = deterministic_interpret("When available, I'd like prior medication failures and intolerance documented.", CHEN_SEED_CASE_FAMILY)
    assert [item.label for item in rules.helpful] == [
        "Prior medication trials", "Reason each medication was stopped (including intolerance or side effects), when known",
    ]


def test_explicit_requirement_language_is_required_and_hedges_stay_helpful() -> None:
    required = deterministic_interpret("I require documentation of prior diabetes medication trials and why they were stopped.", CHEN_SEED_CASE_FAMILY)
    assert [item.required for item in required.required] == [True, True] and required.helpful == []
    gate = deterministic_interpret("Don't send until the most recent A1c is attached.", CHEN_SEED_CASE_FAMILY)
    assert [item.key for item in gate.required] == ["recent_hba1c"]
    hedge = deterministic_interpret("If possible, I'd like a recent lipid panel.", CHEN_SEED_CASE_FAMILY)
    assert hedge.required == [] and [item.label for item in hedge.helpful] == ["Recent lipid panel"]
    # Unchanged behavior for the established statements.
    baseline = deterministic_interpret("For new diabetes referrals, I need a recent A1c, current diabetes medications, and recent kidney function.", CHEN_SEED_CASE_FAMILY)
    assert [item.key for item in baseline.required] == ["recent_hba1c", "current_medications", "recent_renal_function"]
    optional = deterministic_interpret("A lipid panel and urine albumin are useful when available, but aren't required.", CHEN_SEED_CASE_FAMILY)
    assert optional.required == [] and len(optional.helpful) == 2
    redirect = deterministic_interpret("I prefer to redirect uncomplicated hypertension back to primary care.", CHEN_SEED_CASE_FAMILY)
    assert redirect.redirect and redirect.helpful == []


def test_missing_helpful_information_never_blocks_referral_readiness() -> None:
    rules = deterministic_interpret(MEDICATION_HISTORY, CHEN_SEED_CASE_FAMILY)
    checks = evaluate_requirements(rules.helpful, ReferralPacket(items=[]), today=date(2026, 10, 1))
    assert {check.status.value for check in checks} == {"optional_not_present"}
    assert not any(check.required for check in checks)


def test_confirming_adds_to_the_representation_without_overwriting_anything(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        baseline = teach_and_confirm_chen_baseline(store, ws)
        document_chen_consultation(store, ws)
        card = clarification_opportunities(store, ws, CHEN_ID)[0]
        clarified = _teach(client, card["yes_statement"], clarifies="modality")
        _teach(client, THYROID)
        snapshot_before = representation_snapshot_id(store, ws, "chen")

        draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": MEDICATION_HISTORY}).json()
        assert draft["status"] == "draft"
        confirmed = client.post(f"{PREFERENCES}/{draft['id']}/confirm").json()
        sections = _sections(client)
        history = client.get(PREFERENCES).json()
        learnings = client.get("/api/workspace/physician/agent-overview?perspective=chen").json()["recent_learnings"]

    rules = confirmed["structured_rules"]
    # The learning holds only its own contribution (learning-history pass)...
    assert rules["required"] == [] and rules["modality_rules"] == []
    assert {(item["key"], item["label"]) for item in rules["helpful"]} == EXPECTED_HELPFUL
    # ...and the representation is every active learning layered together.
    effective = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert {item.key for item in effective.required} == {"recent_hba1c", "current_medications", "recent_renal_function"}
    assert [rule.model_dump() for rule in effective.modality_rules] == clarified["structured_rules"]["modality_rules"]
    assert effective.modality == clarified["structured_rules"]["modality"]
    # Operational behavior: renal function is still a requirement.
    operational = requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert {item.key for item in operational if item.required} >= {"recent_renal_function", "recent_hba1c"}
    assert {item.key for item in operational if not item.required} >= {key for key, _ in EXPECTED_HELPFUL}
    # Overview representation.
    assert "Recent kidney function" in sections["referral_requirements"]
    assert {"Prior diabetes medication trials", "Most recent TSH", "Free T4"} <= set(sections["preferred_workup"])
    assert sections["modality_preference"]
    # Learning history + version + learned this week.
    statuses = {item["source_text"]: item["status"] for item in history if item["source_text"] == MEDICATION_HISTORY}
    assert statuses == {MEDICATION_HISTORY: "confirmed"}
    # Additive: no earlier learning was superseded.
    for earlier in (baseline, clarified):
        assert store.referral_preference(ws, earlier["id"])["status"] == "confirmed"
    assert confirmed["representation_snapshot_id_at_confirmation"] != snapshot_before
    assert any("Prior diabetes medication trials" in item["summary"] for item in learnings)


def test_a_first_helpful_only_teaching_keeps_the_footprint_requirements(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        _teach(client, MEDICATION_HISTORY)
        sections = _sections(client)
    operational = requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert {item.key for item in operational if item.required} == {"recent_hba1c", "current_medications", "recent_renal_function"}
    assert "Recent renal function" in sections["referral_requirements"]
    assert "Prior diabetes medication trials" in sections["preferred_workup"]


def test_the_confirmed_learning_is_editable_through_the_versioned_flow(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        learned = _teach(client, MEDICATION_HISTORY)
        edit = client.post(f"{PREFERENCES}/interpret", json={
            "source_text": "If a patient has tried other diabetes medications before, I require the reason they were stopped.",
            "revises": learned["id"],
        }).json()
        assert edit["supersedes_id"] == learned["id"]
        edited = client.post(f"{PREFERENCES}/{edit['id']}/confirm").json()
    assert "diabetes_medication_discontinuation_reason" in {item["key"] for item in edited["structured_rules"]["required"]}
    effective = effective_confirmed_rules(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    required = {item.key for item in effective.required}
    helpful = {item.key for item in effective.helpful}
    # The edit moves THIS learning's items to required; the baseline survives.
    assert {"diabetes_medication_discontinuation_reason", "recent_renal_function"} <= required
    assert "diabetes_medication_discontinuation_reason" not in helpful
    assert store.referral_preference(ws, learned["id"])["status"] == "superseded"


def test_no_exact_string_special_case_exists() -> None:
    source = (Path(__file__).resolve().parents[1] / "backend" / "referral_preferences.py").read_text(encoding="utf-8")
    for fragment in ("tried other diabetes medications", "reason they were stopped", "when it’s available"):
        assert fragment not in source
    # No drug class is enumerated in any pattern -- only generic therapy words.
    patterns = [line for line in source.splitlines() if "re.compile" in line or line.lstrip().startswith('r"')]
    assert not any(name in line.casefold() for line in patterns for name in ("glp", "metformin", "insulin", "sglt", "antihypertensive", "biologic"))


def test_an_uninterpretable_statement_can_never_be_confirmed(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        empty = client.post(f"{PREFERENCES}/interpret", json={"source_text": "Please be nice."}).json()
        refused = client.post(f"{PREFERENCES}/{empty['id']}/confirm")
        # With a confirmed preference, a no-op teaching is refused too.
        teach_and_confirm_chen_baseline(store, ws)
        noop = client.post(f"{PREFERENCES}/interpret", json={"source_text": "Please be nice."}).json()
        refused_noop = client.post(f"{PREFERENCES}/{noop['id']}/confirm")
    assert refused.status_code == 409
    assert refused_noop.status_code == 409
    assert store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)["id"] != noop["id"]
