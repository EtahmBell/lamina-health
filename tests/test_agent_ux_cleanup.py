"""My Agent + Network UX cleanup pass: safe editing of confirmed learnings,
representation-only "learned this week", network activity separated from
learning, generic NLP teaching (thyroid), and structured Ask the Network
results grounded only in directly relevant posts.
"""

from __future__ import annotations

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
from backend.network_query import ask_network
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
    recent_representation_learnings,
    requirement_override_for_referral,
)
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PHYSICIAN_CHEN, TONJIT_PATIENT_ID
from backend.synthetic_data.fixtures import SYNTHETIC_AUTO_ROUTED_REQUESTS
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import document_chen_consultation, teach_and_confirm_chen_baseline

CHEN_ID = PHYSICIAN_CHEN.id
PREFERENCES = "/api/workspace/physician/chen/referral-preferences"
THYROID = "For new thyroid referrals, I prefer the most recent TSH and free T4 available before review."


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


def _overview(client: TestClient) -> dict:
    return client.get("/api/workspace/physician/agent-overview?perspective=chen").json()


def _sections(client: TestClient) -> dict:
    return client.get("/api/workspace/physician/agent-representation?perspective=chen").json()["sections"]


def _confirm_clarification(client: TestClient, store: WorkflowStore, ws: str) -> dict:
    document_chen_consultation(store, ws)
    card = clarification_opportunities(store, ws, CHEN_ID)[0]
    draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": card["yes_statement"], "clarifies": "modality"}).json()
    return client.post(f"{PREFERENCES}/{draft['id']}/confirm").json()


# ------------------------------------------------------------------ EDITING 7-10


def test_editing_a_confirmed_learning_is_a_draft_until_confirmed_then_supersedes(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        original = teach_and_confirm_chen_baseline(store, ws)
        snapshot_before = representation_snapshot_id(store, ws, "chen")
        operational_before = requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)

        edited_text = "For diabetes referrals, I usually need a recent A1c and current diabetes medications."
        draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": edited_text, "revises": original["id"]}).json()
        assert draft["status"] == "draft"
        assert draft["supersedes_id"] == original["id"]
        assert draft["case_family"] == original["case_family"]

        # Closing the modal without confirming: nothing operational changed.
        assert store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)["id"] == original["id"]
        assert requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY) == operational_before
        assert representation_snapshot_id(store, ws, "chen") == snapshot_before

        client.post(f"{PREFERENCES}/{draft['id']}/confirm")
        assert store.referral_preference(ws, original["id"])["status"] == "superseded"  # history kept
        assert store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)["id"] == draft["id"]
        keys = {item.key for item in requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)}
        assert "recent_renal_function" not in keys
        assert representation_snapshot_id(store, ws, "chen") != snapshot_before


def test_only_the_currently_confirmed_version_can_be_edited(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        original = teach_and_confirm_chen_baseline(store, ws)
        newer = client.post(f"{PREFERENCES}/interpret", json={"source_text": "I usually need a recent A1c.", "revises": original["id"]}).json()
        client.post(f"{PREFERENCES}/{newer['id']}/confirm")
        stale = client.post(f"{PREFERENCES}/interpret", json={"source_text": "Anything.", "revises": original["id"]})
    assert stale.status_code == 409


def test_editing_a_clarification_never_drops_carried_over_requirements(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        clarified = _confirm_clarification(client, store, ws)
        draft = client.post(f"{PREFERENCES}/interpret", json={
            "source_text": "E-consult is fine when the question is focused and the recent A1c is available.",
            "revises": clarified["id"],
        }).json()
    rules = draft["structured_rules"]
    assert {item["key"] for item in rules["required"]} >= {"recent_renal_function", "recent_hba1c"}
    assert [rule["modality"] for rule in rules["modality_rules"]] == ["econsult"]


# ------------------------------------------------------------- LEARNED THIS WEEK 13-15


def test_learned_this_week_shows_the_clarification_as_representation_learning(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        before = {item["summary"] for item in _overview(client)["recent_learnings"]}
        _confirm_clarification(client, store, ws)
        learnings = _overview(client)["recent_learnings"]
    new = [item for item in learnings if item["summary"] not in before]
    summaries = " ".join(item["summary"] for item in new)
    assert "Clarified that e-consult can be appropriate when" in summaries
    assert "Confirmed that in-person evaluation is preferred when" in summaries
    assert "required before review" not in summaries, "carried-over requirements are not this week's learning"
    assert all(item["preference_id"] for item in learnings), "every learning is backed by an editable artifact"


def test_tonjit_workflow_events_are_never_classified_as_learning(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        referral = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
        client.post(f"/api/referrals/{referral['id']}/preflight")
        client.post(f"/api/referrals/{referral['id']}/accept", json={"receiving_physician_id": CHEN_ID})
        overview = _overview(client)
    assert overview["recent_learnings"] == []
    assert recent_representation_learnings(store, ws, CHEN_ID) == []
    coordination = next(item for item in overview["network_activity"] if item["kind"] == "coordination")
    assert "renal" in " ".join(coordination["outcomes"]).casefold()


# ------------------------------------------------------------- NETWORK ACTIVITY 16-18


def test_network_activity_reflects_the_demo_and_resets_deterministically(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        baseline = _overview(client)["network_activity"]
        assert [item["kind"] for item in baseline] == ["routing"]
        routed = baseline[0]
        assert routed["synthetic_fixture"] is True
        assert routed["title"] == f"{len(SYNTHETIC_AUTO_ROUTED_REQUESTS)} requests routed automatically"
        assert "2 visits · 1 e-consult" in routed["detail"]
        assert routed["patient_ids"] == [item["patient_id"] for item in SYNTHETIC_AUTO_ROUTED_REQUESTS]

        referral = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
        client.post(f"/api/referrals/{referral['id']}/preflight")
        client.post(f"/api/referrals/{referral['id']}/accept", json={"receiving_physician_id": CHEN_ID})
        after = _overview(client)["network_activity"]
        coordination = after[0]
        assert coordination["title"] == "Coordinated with Dr. Lucy Saruhashi's agent"
        assert coordination["detail"] == "Tonjit Askarov · Endocrinology referral"
        assert "Recent renal function found and attached automatically" in coordination["outcomes"]
        assert coordination["synthetic_fixture"] is False
        tasks = next(item for item in after if item["kind"] == "tasks")
        assert tasks["title"].endswith("coordination tasks handled")

        client.post("/api/workspace/demo/reset/tonjit")
        assert _overview(client)["network_activity"] == baseline


def test_lucy_has_no_receiving_network_activity(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        assert client.get("/api/workspace/physician/agent-overview?perspective=lucy").json()["network_activity"] == []


# ------------------------------------------------------------------- NLP 27-30


def test_a_distinct_teaching_statement_is_interpreted_generically_and_updates_representation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        snapshot_before = representation_snapshot_id(store, ws, "chen")
        draft = client.post(f"{PREFERENCES}/interpret", json={"source_text": THYROID}).json()
        assert draft["case_family"] == "thyroid"
        assert [item["label"] for item in draft["structured_rules"]["helpful"]] == ["Most recent TSH", "Free T4"]
        client.post(f"{PREFERENCES}/{draft['id']}/confirm")
        sections = _sections(client)
        history = client.get(PREFERENCES).json()
        learnings = _overview(client)["recent_learnings"]
    assert {"Most recent TSH", "Free T4"} <= set(sections["preferred_workup"])
    # The diabetes baseline used by the Tonjit demo is untouched.
    assert "Recent renal function" in sections["referral_requirements"]
    assert requirement_override_for_referral(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY) is None
    assert any(item["status"] == "confirmed" and item["source_text"] == THYROID for item in history)
    assert any("Most recent TSH" in item["summary"] for item in learnings)
    assert representation_snapshot_id(store, ws, "chen") != snapshot_before


def test_the_interpreter_has_no_special_case_for_the_demo_sentence() -> None:
    from backend.referral_preferences import deterministic_interpret

    source = (Path(__file__).resolve().parents[1] / "backend" / "referral_preferences.py").read_text(encoding="utf-8")
    assert "free T4 available before review" not in source
    other = deterministic_interpret("For thyroid nodule referrals, I need a recent TSH.", "thyroid")
    assert [item.key for item in other.required] == ["recent_tsh"]


def test_a_modality_only_confirmation_keeps_the_footprint_visible(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        _confirm_clarification(client, store, ws)
        sections = _sections(client)
    assert "Recent renal function" in sections["referral_requirements"]
    assert sections["modality_preference"]


# ------------------------------------------------------------- ASK THE NETWORK 19-26


def test_ask_network_returns_structured_reasons_and_only_directly_relevant_grounding(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "w.sqlite")
    result = ask_network(store, "ws", "Who handles progressive CKD with resistant hypertension?")
    by_id = {item["physician_id"]: item for item in result["physician_agents"]}
    iain, matthew = by_id["physician-jung"], by_id["physician-onadeko"]

    assert iain["strength"] == "strong"
    assert {"specialty", "similar_history", "practice_focus", "case_interest", "before_referral"} <= {r["kind"] for r in iain["match_reasons"]}
    assert "BMP" in next(r["detail"] for r in iain["match_reasons"] if r["kind"] == "before_referral")
    assert [post["post_id"] for post in iain["grounded_in"]] == ["fixture-iain-workup-guidance"]

    assert matthew["strength"] == "relevant"
    assert "case_interest" not in {r["kind"] for r in matthew["match_reasons"]}, "only supported reasons"
    grounded = [post["post_id"] for match in result["physician_agents"] for post in match["grounded_in"]]
    assert "fixture-maya-osteoporosis" not in grounded
    assert "physician-ramanathan" not in by_id
    from backend.engagement import PERSONA_BY_PHYSICIAN_ID

    for match in result["physician_agents"]:
        # Only physicians with a real Lamina agent persona are askable results.
        assert match["physician_id"] in PERSONA_BY_PHYSICIAN_ID
        assert not any(isinstance(value, (int, float)) and not isinstance(value, bool) for value in match.values())
