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
    "id", "stage", "title", "actor_kind", "actor_physician_id", "actor_name", "content_kind", "statement",
    "details", "patient_facts", "occurred_at", "correctable", "corrections",
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
    ("For my referrals, don't describe one medication addition as extensive treatment escalation.", "future"),
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


# ------------------------------------------------- Network consultation oversight
#
# The same ownership rule and correction flow, applied to the Network
# consultation itself -- before any physician is selected. Lucy's agent shares
# ONE case representation with every candidate agent; each candidate agent's
# response belongs to that candidate physician, selected or not.

OKONKWO_ID = "physician-okonkwo"
TORRES_ID = "physician-torres"
LUCY_CASE_EPISODE = "For Tonjit, one agent was added to metformin -- I would not call that extensive escalation."
LUCY_CASE_DURABLE = "For my referrals, don't describe one medication addition as extensive treatment escalation."


def _consult(client: TestClient) -> int:
    client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={})
    return client.get("/api/workspace/consultations").json()[0]["id"]


def _network(client: TestClient, record_id: int, viewer: str) -> dict:
    response = client.get(f"/api/consultations/{record_id}/coordination", params={"viewer_physician_id": viewer})
    assert response.status_code == 200, response.text
    return response.json()


def _network_item(episode: dict, title: str, owner: str | None = None) -> dict:
    return next(item for item in episode["items"] if item["title"] == title and (owner is None or item["actor_physician_id"] == owner))


def _network_interpret(client: TestClient, record_id: int, item_id: str, physician: str, text: str):
    return client.post(
        f"/api/consultations/{record_id}/coordination/{item_id}/corrections/interpret",
        json={"physician_id": physician, "correction_text": text},
    )


def _network_confirm(client: TestClient, record_id: int, item_id: str, physician: str, text: str, scope: str | None):
    return client.post(
        f"/api/consultations/{record_id}/coordination/{item_id}/corrections",
        json={"physician_id": physician, "correction_text": text, "scope": scope},
    )


def test_lucys_shared_case_representation_is_one_structured_correctable_item(client: TestClient) -> None:
    record_id = _consult(client)
    episode = _network(client, record_id, LUCY_AGENT_ID)
    shared = [item for item in episode["items"] if item["title"] == "Case shared with the network"]
    assert len(shared) == 1, "one outgoing representation, however many candidate agents received it"
    case = shared[0]
    assert case["actor_physician_id"] == LUCY_AGENT_ID and case["actor_kind"] == "agent" and case["correctable"]
    assert "despite escalating primary-care medication management" in case["statement"]
    assert case["details"] == [{"label": "Referral question", "text": "Treatment intensification for worsening type 2 diabetes despite medication escalation."}]
    assert any(fact["text"].startswith("HbA1c") for fact in case["patient_facts"])
    assert all(fact["source"] == "Patient record (synthetic)" for fact in case["patient_facts"])
    responders = {item["actor_physician_id"] for item in episode["items"] if item["title"] == "Practice fit returned"}
    assert responders == {CHEN_ID, OKONKWO_ID, TORRES_ID}


def test_lucy_can_correct_only_her_agent_during_the_network_consultation(client: TestClient) -> None:
    record_id = _consult(client)
    episode = _network(client, record_id, LUCY_AGENT_ID)
    correctable = [item for item in episode["items"] if item["correctable"]]
    assert {item["title"] for item in correctable} == {"Case shared with the network", "Clarification resolved"}
    assert all(item["actor_physician_id"] == LUCY_AGENT_ID for item in correctable)
    for owner in (CHEN_ID, OKONKWO_ID, TORRES_ID):
        assert not _network_item(episode, "Practice fit returned", owner)["correctable"]
    # Ranking, access and protocol priority are recorded facts, not her agent's.
    for item in episode["items"]:
        if item["title"] in ("Priority", "Recommended route", "Route evaluated", "Recommendation created"):
            assert item["content_kind"] == "system_fact" and not item["correctable"]
    assert _network_item(episode, "Priority")["statement"].startswith("Soon. Protocol-grounded")
    # Chart facts are shown only as provenance, never as their own correctable entry.
    assert not any(item["content_kind"] == "patient_fact" and item["correctable"] for item in episode["items"])


def test_lucy_can_correct_the_source_representation_before_any_physician_is_selected(client: TestClient, store: WorkflowStore) -> None:
    record_id = _consult(client)
    workspace = _workspace(client)
    assert store.list_referrals(workspace, patient_id=TONJIT_PATIENT_ID) == [], "no physician selected yet"
    recorded = client.get(f"/api/workspace/consultations/{record_id}").json()["result"]["messages"]
    before = _network(client, record_id, LUCY_AGENT_ID)
    case = _network_item(before, "Case shared with the network")
    version = representation_snapshot_id(store, workspace, "lucy")
    proposal = _network_interpret(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_EPISODE).json()
    assert proposal["suggested_scope"] == "episode"
    assert proposal["original_representation"].endswith("Referral question: Treatment intensification for worsening type 2 diabetes despite medication escalation.")
    assert store.list_corrections(workspace, TONJIT_PATIENT_ID) == [], "interpreting (or cancelling) writes nothing"

    saved = _network_confirm(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_EPISODE, "episode").json()
    assert saved["status"] == "episode_annotation" and saved["referral_id"] is None
    assert saved["consultation_record_id"] == record_id and saved["source_item_id"] == case["id"]
    assert representation_snapshot_id(store, workspace, "lucy") == version, "consultation-only never changes her agent"
    assert store.proposed_learnings(workspace, "lucy") == []

    after = _network(client, record_id, LUCY_AGENT_ID)
    corrected = _network_item(after, "Case shared with the network")
    assert [item["correction_text"] for item in corrected["corrections"]] == [LUCY_CASE_EPISODE], "corrected once, not per candidate"
    assert corrected["statement"] == case["statement"], "the original outgoing representation stays audit-visible"
    # Candidate responses already recorded are never rewritten or recomputed.
    strip = lambda episode: [(item["id"], item["statement"]) for item in episode["items"]]  # noqa: E731
    assert strip(after) == strip(before)
    assert client.get(f"/api/workspace/consultations/{record_id}").json()["result"]["messages"] == recorded
    assert all(item["corrections"] == [] for item in after["items"] if item["id"] != case["id"])


def test_a_network_correction_stays_coherent_once_the_referral_starts(client: TestClient) -> None:
    record_id = _consult(client)
    case = _network_item(_network(client, record_id, LUCY_AGENT_ID), "Case shared with the network")
    _network_confirm(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_EPISODE, "episode")
    created = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}).json()
    client.post(f"/api/referrals/{created['id']}/preflight")
    # The same entry, the same correction, in Agent coordination.
    lucy_view = _item(_episode(client, created["id"], LUCY_AGENT_ID), "Case shared with the network")
    assert lucy_view["id"] == case["id"] and lucy_view["statement"] == case["statement"]
    assert [item["correction_text"] for item in lucy_view["corrections"]] == [LUCY_CASE_EPISODE]
    assert _item(_episode(client, created["id"], CHEN_ID), "Case shared with the network")["corrections"] == []
    # And Lucy can still correct the historical consultation after Chen was selected.
    clarification = _network_item(_network(client, record_id, LUCY_AGENT_ID), "Clarification resolved")
    assert _network_confirm(client, record_id, clarification["id"], LUCY_AGENT_ID, LUCY_EPISODE, "episode").status_code == 200
    # Selected-referral corrections keep working normally for both physicians.
    requirement = _item(_episode(client, created["id"], CHEN_ID), "Requirement identified")
    assert _confirm(client, created["id"], requirement["id"], CHEN_ID, "This referral was fine without it.", "episode").status_code == 200
    assert _confirm(client, created["id"], lucy_view["id"], LUCY_AGENT_ID, LUCY_EPISODE, "episode").status_code == 200


def test_the_server_enforces_agent_ownership_in_the_network_consultation(client: TestClient) -> None:
    record_id = _consult(client)
    episode = _network(client, record_id, LUCY_AGENT_ID)
    case = _network_item(episode, "Case shared with the network")
    for owner in (CHEN_ID, OKONKWO_ID, TORRES_ID):
        candidate = _network_item(episode, "Practice fit returned", owner)
        assert _network_interpret(client, record_id, candidate["id"], LUCY_AGENT_ID, "x").status_code == 403
        assert _network_confirm(client, record_id, candidate["id"], LUCY_AGENT_ID, "x", "episode").status_code == 403
        assert _network_confirm(client, record_id, case["id"], owner, "x", "episode").status_code == 403, "nobody else edits Lucy's agent"
    for title in ("Priority", "Recommended route", "Recommendation created"):
        assert _network_confirm(client, record_id, _network_item(episode, title)["id"], LUCY_AGENT_ID, "x", "episode").status_code == 403
    assert _network_confirm(client, record_id, case["id"], LUCY_AGENT_ID, "x", None).status_code == 422
    assert _network_confirm(client, record_id, "consult-999-1", LUCY_AGENT_ID, "x", "episode").status_code == 404
    # A physician whose agent took no part can neither view nor correct.
    assert client.get(f"/api/consultations/{record_id}/coordination", params={"viewer_physician_id": "physician-jung"}).status_code == 403
    assert _network_confirm(client, record_id, case["id"], "physician-jung", "x", "episode").status_code == 403


def test_candidate_ownership_does_not_depend_on_selection(client: TestClient) -> None:
    record_id = _consult(client)
    # Chen is recommended -- and later selected -- yet Okonkwo still owns her
    # own agent's response, and Chen owns his before he was ever selected.
    chen_response = _network_item(_network(client, record_id, CHEN_ID), "Practice fit returned", CHEN_ID)
    assert chen_response["correctable"]
    client.post(f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID})
    okonkwo = _network(client, record_id, OKONKWO_ID)
    own = [item for item in okonkwo["items"] if item["correctable"]]
    assert [(item["title"], item["actor_physician_id"]) for item in own] == [("Practice fit returned", OKONKWO_ID)]
    assert not _network_item(okonkwo, "Case shared with the network")["correctable"]
    proposal = _network_interpret(client, record_id, own[0]["id"], OKONKWO_ID, "For this patient my access was closer to three weeks.").json()
    assert proposal["future_available"] is False, "no agent representation to version for this physician in the demo"
    saved = _network_confirm(client, record_id, own[0]["id"], OKONKWO_ID, "For this patient my access was closer to three weeks.", "episode")
    assert saved.status_code == 200 and saved.json()["physician_id"] == OKONKWO_ID
    # Each physician sees only their own corrections.
    assert _network_item(_network(client, record_id, LUCY_AGENT_ID), "Practice fit returned", OKONKWO_ID)["corrections"] == []
    torres = _network(client, record_id, TORRES_ID)
    assert [item["actor_physician_id"] for item in torres["items"] if item["correctable"]] == [TORRES_ID]


def test_a_durable_network_correction_needs_explicit_confirmation(client: TestClient, store: WorkflowStore) -> None:
    record_id = _consult(client)
    workspace = _workspace(client)
    case = _network_item(_network(client, record_id, LUCY_AGENT_ID), "Case shared with the network")
    version = representation_snapshot_id(store, workspace, "lucy")
    proposal = _network_interpret(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_DURABLE).json()
    assert proposal["suggested_scope"] == "future" and proposal["future_available"]
    assert store.proposed_learnings(workspace, "lucy") == [] and representation_snapshot_id(store, workspace, "lucy") == version
    saved = _network_confirm(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_DURABLE, "future").json()
    assert saved["status"] == "confirmed" and saved["resulting_learning_id"].startswith("learning-")
    assert saved["resulting_representation_version"] == representation_snapshot_id(store, workspace, "lucy") != version
    learnings = store.proposed_learnings(workspace, "lucy")
    assert [(item["statement"], item["status"], item["source_type"]) for item in learnings] == [(LUCY_CASE_DURABLE, "confirmed", "coordination_correction")]
    assert _network_item(_network(client, record_id, LUCY_AGENT_ID), "Case shared with the network")["statement"] == case["statement"]


def test_the_network_consultation_view_is_structured_outputs_only(client: TestClient) -> None:
    record_id = _consult(client)
    for viewer in (LUCY_AGENT_ID, CHEN_ID, OKONKWO_ID):
        episode = _network(client, record_id, viewer)
        for item in episode["items"]:
            assert set(item) == PERMITTED_ITEM_KEYS
        raw = json.dumps(episode).casefold()
        for forbidden in ("evidence", "prompt", "reasoning", "scratchpad", "chain_of_thought", "metadata", "sender_agent_id", "agent-pcp"):
            assert forbidden not in raw, forbidden


def test_network_oversight_leaves_routing_and_reset_unchanged(client: TestClient, store: WorkflowStore) -> None:
    result = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
    record_id = client.get("/api/workspace/consultations").json()[0]["id"]
    case = _network_item(_network(client, record_id, LUCY_AGENT_ID), "Case shared with the network")
    _network_confirm(client, record_id, case["id"], LUCY_AGENT_ID, LUCY_CASE_DURABLE, "both")
    again = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
    assert again["recommended_physician"]["physician_id"] == result["recommended_physician"]["physician_id"] == CHEN_ID
    assert [route["physician_id"] for route in again["candidate_routes"]] == [route["physician_id"] for route in result["candidate_routes"]]
    workspace = _workspace(client)
    client.post("/api/workspace/demo/reset/tonjit")
    assert store.list_corrections(workspace, TONJIT_PATIENT_ID) == []
    assert store.proposed_learnings(workspace, "lucy") == []
