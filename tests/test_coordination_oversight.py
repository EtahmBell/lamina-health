"""Agent coordination oversight pass: both physicians can inspect what THEIR
OWN agent represented during a referral's coordination and correct it --
without the coordination record ever being rewritten, without either
physician editing the other's agent, and without a patient-specific
correction silently becoming a practice rule.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend import coordination_corrections as coordination_corrections_module
from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.demo_identity import LUCY_AGENT_ID
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    requirement_override_for_referral,
)
from backend.referrals.coordination_episode import infer_correction_scope
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PHYSICIAN_CHEN, TONJIT_PATIENT_ID
from backend.workflow import WorkflowStore

CHEN_ID = PHYSICIAN_CHEN.id
LUCY_CLARIFICATION = "Insulin has not yet been discussed; the regimen remains oral therapy, with one agent already added to metformin."
CHEN_RENAL_CORRECTION = "Actually, renal function is helpful but shouldn't block review in cases like this."
LUCY_DURABLE = "My agent should not describe oral medication escalation as exhausted treatment options unless at least two classes have been tried."
LUCY_EPISODE = "That statement is wrong for Tonjit specifically."
LUCY_AMBIGUOUS = "Primary care has tried metformin plus one additional oral agent; I would not describe this as exhausting oral treatment options."
PERMITTED_ITEM_KEYS = {
    "id", "stage", "title", "actor_kind", "actor_physician_id", "content_kind", "statement",
    "patient_facts", "occurred_at", "correctable", "corrections",
}

offline = ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False))


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    for module in (referral_preferences_api, referrals_api, consult_api, engagement_api, workspace_api, specialist_api, demo_workspace_module):
        monkeypatch.setattr(module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(referral_preferences_api, "referral_preference_interpretation_service", offline)
    monkeypatch.setattr(coordination_corrections_module, "referral_preference_interpretation_service", offline)
    return value


@pytest.fixture
def client(store: WorkflowStore) -> TestClient:
    value = TestClient(app)
    value.get("/api/patients")
    return value


def _workspace(client: TestClient) -> str:
    return client.cookies[DEFAULT_COOKIE_NAME]


def _submitted_referral(client: TestClient) -> dict:
    """The canonical Tonjit flow up to Chen's incoming request: consult the
    network, start the referral, run preflight (renal function is found
    and attached)."""
    client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={})
    created = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    return client.get(f"/api/referrals/{created['id']}").json()


def _accept(client: TestClient, referral: dict) -> dict:
    return client.post(f"/api/referrals/{referral['id']}/accept", json={"receiving_physician_id": CHEN_ID}).json()


def _episode(client: TestClient, referral_id: int, viewer: str) -> dict:
    response = client.get(f"/api/referrals/{referral_id}/coordination", params={"viewer_physician_id": viewer})
    assert response.status_code == 200, response.text
    return response.json()


def _item(episode: dict, title: str) -> dict:
    return next(item for item in episode["items"] if item["title"] == title)


def _interpret(client: TestClient, referral_id: int, item_id: str, physician: str, text: str, scope: str | None = None):
    return client.post(
        f"/api/referrals/{referral_id}/coordination/{item_id}/corrections/interpret",
        json={"physician_id": physician, "correction_text": text, "scope": scope},
    )


def _confirm(client: TestClient, referral_id: int, item_id: str, physician: str, text: str, scope: str):
    return client.post(
        f"/api/referrals/{referral_id}/coordination/{item_id}/corrections",
        json={"physician_id": physician, "correction_text": text, "scope": scope},
    )


# ------------------------------------------------------------- Z: Lucy oversight


def test_lucy_sees_a_structured_episode_grouped_by_stage(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], LUCY_AGENT_ID)
    assert episode["viewer_role"] == "referring"
    stages = [item["stage"] for item in episode["items"]]
    assert stages == sorted(stages, key=["routing", "clarification", "workup", "acceptance", "scheduling", "handoff"].index)
    titles = {item["title"] for item in episode["items"]}
    assert {"Case shared with the network", "Recommendation created", "Route selected", "Clarification requested",
            "Clarification resolved", "Requirement identified", "Record found", "Referral sent"} <= titles
    assert _item(episode, "Clarification resolved")["statement"] == LUCY_CLARIFICATION


def test_the_episode_is_structured_outputs_only_never_a_transcript_or_reasoning(client: TestClient) -> None:
    referral = _submitted_referral(client)
    for viewer in (LUCY_AGENT_ID, CHEN_ID):
        episode = _episode(client, referral["id"], viewer)
        for item in episode["items"]:
            assert set(item) == PERMITTED_ITEM_KEYS
        raw = json.dumps(episode).casefold()
        for forbidden in ("evidence", "prompt", "reasoning", "scratchpad", "chain_of_thought", "metadata", "sender_agent_id"):
            assert forbidden not in raw, forbidden


def test_other_candidates_exchanges_never_appear_in_coordination(client: TestClient) -> None:
    referral = _submitted_referral(client)
    raw = json.dumps(_episode(client, referral["id"], CHEN_ID))
    for name in ("Okonkwo", "Torres", "Ramanathan", "Jung"):
        assert name not in raw


def test_lucy_can_correct_only_her_own_agents_representations(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], LUCY_AGENT_ID)
    correctable = {item["title"] for item in episode["items"] if item["correctable"]}
    assert correctable == {"Case shared with the network", "Clarification resolved"}
    for item in episode["items"]:
        if item["actor_physician_id"] == CHEN_ID:
            assert not item["correctable"], item["title"]
        if item["content_kind"] in ("system_fact", "patient_fact"):
            assert not item["correctable"], item["title"]


def test_chart_facts_keep_their_provenance_and_are_never_correctable(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], LUCY_AGENT_ID)
    found = _item(episode, "Record found")
    assert found["content_kind"] == "patient_fact" and not found["correctable"]
    assert found["patient_facts"][0]["text"].startswith("Recent renal function:")
    assert "Patient record (synthetic)" in found["patient_facts"][0]["source"]
    clarification = _item(episode, "Clarification resolved")
    assert {fact["source"] for fact in clarification["patient_facts"]} == {"Patient record (synthetic)"}
    assert "Primary care has already escalated oral medication therapy" in {fact["text"] for fact in clarification["patient_facts"]}
    response = _confirm(client, referral["id"], found["id"], LUCY_AGENT_ID, "This lab is wrong.", "episode")
    assert response.status_code == 403


def test_interpreting_a_correction_changes_nothing(client: TestClient, store: WorkflowStore) -> None:
    referral = _submitted_referral(client)
    workspace = _workspace(client)
    clarification = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    version = representation_snapshot_id(store, workspace, "lucy")
    proposal = _interpret(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_DURABLE)
    assert proposal.status_code == 200
    body = proposal.json()
    assert body["original_representation"] == LUCY_CLARIFICATION
    assert body["suggested_scope"] == "future" and body["future_available"]
    # Cancel = simply never confirming.
    assert store.list_corrections(workspace, TONJIT_PATIENT_ID) == []
    assert representation_snapshot_id(store, workspace, "lucy") == version
    assert client.get(f"/api/referrals/{referral['id']}").json()["coordination_events"] == referral["coordination_events"]


def test_an_episode_only_correction_annotates_without_changing_representation(client: TestClient, store: WorkflowStore) -> None:
    referral = _submitted_referral(client)
    workspace = _workspace(client)
    clarification = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    version = representation_snapshot_id(store, workspace, "lucy")
    assert _interpret(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_EPISODE).json()["suggested_scope"] == "episode"
    saved = _confirm(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_EPISODE, "episode").json()
    assert saved["status"] == "episode_annotation" and saved["resulting_learning_id"] is None
    assert representation_snapshot_id(store, workspace, "lucy") == version
    assert store.proposed_learnings(workspace, "lucy") == []
    after = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    assert after["statement"] == LUCY_CLARIFICATION, "the original stays visible"
    assert [item["correction_text"] for item in after["corrections"]] == [LUCY_EPISODE]


def test_an_ambiguous_correction_asks_for_its_scope(client: TestClient) -> None:
    referral = _submitted_referral(client)
    clarification = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    proposal = _interpret(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_AMBIGUOUS).json()
    assert proposal["suggested_scope"] is None
    missing_scope = client.post(
        f"/api/referrals/{referral['id']}/coordination/{clarification['id']}/corrections",
        json={"physician_id": LUCY_AGENT_ID, "correction_text": LUCY_AMBIGUOUS},
    )
    assert missing_scope.status_code == 422


def test_a_durable_lucy_correction_becomes_a_confirmed_learning_with_a_new_version(client: TestClient, store: WorkflowStore) -> None:
    referral = _submitted_referral(client)
    workspace = _workspace(client)
    clarification = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    version = representation_snapshot_id(store, workspace, "lucy")
    saved = _confirm(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_DURABLE, "future").json()
    assert saved["status"] == "confirmed" and saved["scope"] == "future"
    assert saved["resulting_learning_id"].startswith("learning-")
    assert saved["resulting_representation_version"] == representation_snapshot_id(store, workspace, "lucy") != version
    learnings = store.proposed_learnings(workspace, "lucy")
    assert [(item["statement"], item["status"], item["source_type"]) for item in learnings] == [(LUCY_DURABLE, "confirmed", "coordination_correction")]
    representation = client.get("/api/workspace/physician/agent-representation", params={"perspective": "lucy"}).json()
    assert LUCY_DURABLE in json.dumps(representation["sections"]["confirmed_learnings"])
    # Provenance of the correction itself.
    for key in ("source_item_id", "physician_id", "created_at", "original_representation", "correction_text", "scope"):
        assert saved[key]
    assert saved["source_item_id"] == clarification["id"] and saved["original_representation"] == LUCY_CLARIFICATION


def test_the_original_coordination_record_is_never_rewritten(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], LUCY_AGENT_ID)
    clarification = _item(episode, "Clarification resolved")
    _confirm(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_DURABLE, "both")
    assert client.get(f"/api/referrals/{referral['id']}").json()["coordination_events"] == referral["coordination_events"]
    after = _episode(client, referral["id"], LUCY_AGENT_ID)
    assert [(item["id"], item["statement"]) for item in after["items"]] == [(item["id"], item["statement"]) for item in episode["items"]]


# ------------------------------------------------------------- AA: Chen oversight


def test_chen_sees_the_same_episode_before_and_after_accepting(client: TestClient) -> None:
    referral = _submitted_referral(client)
    before = _episode(client, referral["id"], CHEN_ID)
    assert before["viewer_role"] == "receiving"
    _accept(client, referral)
    after = _episode(client, referral["id"], CHEN_ID)
    before_items = [(item["id"], item["statement"]) for item in before["items"]]
    assert [(item["id"], item["statement"]) for item in after["items"]][: len(before_items)] == before_items
    assert {"Referral accepted", "Appointment scheduled"} <= {item["title"] for item in after["items"]}
    # One episode powers both sides: identical entries, different controls.
    lucy = _episode(client, referral["id"], LUCY_AGENT_ID)
    assert [(item["id"], item["statement"]) for item in lucy["items"]] == [(item["id"], item["statement"]) for item in after["items"]]


def test_chen_can_correct_only_his_own_agents_representations(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], CHEN_ID)
    correctable = [item for item in episode["items"] if item["correctable"]]
    assert {item["title"] for item in correctable} == {
        "Practice fit returned", "Clarification requested", "Receiving response", "Requirement identified", "Requirement satisfied",
    }
    assert all(item["actor_physician_id"] == CHEN_ID for item in correctable)
    assert len([item for item in correctable if item["title"] == "Requirement satisfied"]) == 1, "only the requirement the agent asked for"
    assert not _item(episode, "Clarification resolved")["correctable"], "Lucy's agent is read-only for Chen"
    assert not _item(episode, "Case shared with the network")["correctable"]


def test_chens_durable_requirement_correction_updates_his_representation_and_future_referrals(client: TestClient, store: WorkflowStore) -> None:
    referral = _submitted_referral(client)
    workspace = _workspace(client)
    requirement = _item(_episode(client, referral["id"], CHEN_ID), "Requirement identified")
    proposal = _interpret(client, referral["id"], requirement["id"], CHEN_ID, CHEN_RENAL_CORRECTION).json()
    assert proposal["suggested_scope"] == "future" and proposal["future_available"]
    assert "Recent renal function will no longer block review." in proposal["future_effect"]
    assert [item["key"] for item in proposal["future_preference"]["helpful"]] == ["recent_renal_function"]
    assert store.list_referral_preferences(workspace, CHEN_ID) == [], "interpreting writes nothing"

    saved = _confirm(client, referral["id"], requirement["id"], CHEN_ID, CHEN_RENAL_CORRECTION, "future").json()
    assert saved["status"] == "confirmed"
    learning = store.referral_preference(workspace, saved["resulting_learning_id"])
    assert learning["status"] == "confirmed" and learning["source"] == "coordination_correction"
    assert learning["representation_snapshot_id_at_confirmation"] == saved["resulting_representation_version"]
    history = client.get("/api/workspace/physician/chen/referral-preferences").json()
    assert [(item["source_text"], item["status"]) for item in history] == [(CHEN_RENAL_CORRECTION, "confirmed")]
    overview = client.get("/api/workspace/physician/agent-overview", params={"perspective": "chen"}).json()
    assert any("renal function" in item["summary"].casefold() for item in overview["recent_learnings"])

    # Future referral behavior uses the confirmed guidance.
    items = requirement_override_for_referral(store, workspace, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    renal = next(item for item in items if item.key == "recent_renal_function")
    assert renal.required is False
    store.reset_demo_case(workspace, TONJIT_PATIENT_ID)
    fresh = _submitted_referral(client)
    assert not any(
        event["event_type"] == "information_requested" and event["metadata"].get("requirement") == "recent_renal_function"
        for event in fresh["coordination_events"]
    )


def test_a_correction_that_teaches_nothing_new_cannot_become_durable(client: TestClient) -> None:
    referral = _submitted_referral(client)
    requirement = _item(_episode(client, referral["id"], CHEN_ID), "Requirement identified")
    _confirm(client, referral["id"], requirement["id"], CHEN_ID, CHEN_RENAL_CORRECTION, "future")
    again = _interpret(client, referral["id"], requirement["id"], CHEN_ID, CHEN_RENAL_CORRECTION).json()
    assert again["future_available"] is False and again["suggested_scope"] == "episode"
    assert _confirm(client, referral["id"], requirement["id"], CHEN_ID, CHEN_RENAL_CORRECTION, "future").status_code == 409
    vague = _interpret(client, referral["id"], requirement["id"], CHEN_ID, "Hmm, not quite right.").json()
    assert vague["future_available"] is False and vague["future_unavailable_reason"]


def test_each_physician_sees_only_their_own_corrections(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], CHEN_ID)
    requirement = _item(episode, "Requirement identified")
    _confirm(client, referral["id"], requirement["id"], CHEN_ID, "This referral was fine without it.", "episode")
    assert len(_item(_episode(client, referral["id"], CHEN_ID), "Requirement identified")["corrections"]) == 1
    assert _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Requirement identified")["corrections"] == []


# ------------------------------------------------------------- AB: security


def test_backend_refuses_cross_physician_and_immutable_corrections(client: TestClient) -> None:
    referral = _submitted_referral(client)
    episode = _episode(client, referral["id"], LUCY_AGENT_ID)
    chen_item = _item(episode, "Requirement identified")
    lucy_item = _item(episode, "Clarification resolved")
    system_item = _item(episode, "Referral sent")
    assert _interpret(client, referral["id"], chen_item["id"], LUCY_AGENT_ID, "x").status_code == 403
    assert _confirm(client, referral["id"], chen_item["id"], LUCY_AGENT_ID, "x", "episode").status_code == 403
    assert _interpret(client, referral["id"], lucy_item["id"], CHEN_ID, "x").status_code == 403
    assert _confirm(client, referral["id"], lucy_item["id"], CHEN_ID, "x", "episode").status_code == 403
    for physician in (LUCY_AGENT_ID, CHEN_ID):
        assert _confirm(client, referral["id"], system_item["id"], physician, "x", "episode").status_code == 403
    assert _confirm(client, referral["id"], lucy_item["id"], "physician-jung", "x", "episode").status_code == 403
    assert _confirm(client, referral["id"], "event-999", LUCY_AGENT_ID, "x", "episode").status_code == 404


def test_only_the_two_referral_parties_can_view_the_episode(client: TestClient) -> None:
    referral = _submitted_referral(client)
    response = client.get(f"/api/referrals/{referral['id']}/coordination", params={"viewer_physician_id": "physician-jung"})
    assert response.status_code == 403


@pytest.mark.parametrize(("text", "scope"), [
    (LUCY_EPISODE, "episode"),
    ("For this patient the regimen was metformin plus one agent.", "episode"),
    (CHEN_RENAL_CORRECTION, "future"),
    (LUCY_DURABLE, "future"),
    ("For Tonjit this was wrong, and going forward don't describe it this way.", "both"),
    (LUCY_AMBIGUOUS, None),
])
def test_scope_inference_never_generalizes_a_patient_specific_correction(text: str, scope: str | None) -> None:
    assert infer_correction_scope(text, "Tonjit") == scope


# ------------------------------------------------------------- AC/AD: regression


def test_matching_result_is_unchanged(client: TestClient) -> None:
    result = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
    assert result["recommended_physician"]["physician_id"] == CHEN_ID
    chen_fit = next(fit for fit in result["physician_fits"] if fit["physician_id"] == CHEN_ID)
    assert chen_fit["similar_case_patterns"], "similar-patient reasoning still feeds the canonical explanation"


def test_canonical_tonjit_flow_still_creates_once_and_resolves_renal_coordination(client: TestClient) -> None:
    referral = _submitted_referral(client)
    again = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
    assert again["id"] == referral["id"]
    assert any(event["event_type"] == "record_found" for event in referral["coordination_events"])
    assert referral["status"] == "submitted"
    accepted = _accept(client, referral)
    assert accepted["status"] in ("accepted", "scheduled")
    # Viewing coordination never mutates the referral.
    _episode(client, referral["id"], CHEN_ID)
    assert client.get(f"/api/referrals/{referral['id']}").json()["coordination_events"] == accepted["coordination_events"]


def test_the_tonjit_reset_clears_coordination_corrections_and_their_learnings(client: TestClient, store: WorkflowStore) -> None:
    referral = _submitted_referral(client)
    workspace = _workspace(client)
    clarification = _item(_episode(client, referral["id"], LUCY_AGENT_ID), "Clarification resolved")
    _confirm(client, referral["id"], clarification["id"], LUCY_AGENT_ID, LUCY_DURABLE, "future")
    client.post("/api/workspace/demo/reset/tonjit")
    assert store.list_corrections(workspace, TONJIT_PATIENT_ID) == []
    assert store.proposed_learnings(workspace, "lucy") == []
