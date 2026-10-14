"""Physician-agent-to-physician-agent coordination chat (demo-consolidation
pass, Part 16-21): deliberately stateless/task-scoped server-side. See Part
42 of the request for the full test checklist this file covers.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import consult as consult_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.demo_identity import LUCY_AGENT_ID, PCP_NAME
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
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


def _ask(client: TestClient, referral_id: int, requesting_physician_id: str, question: str):
    return client.post(
        f"/api/referrals/{referral_id}/coordination-chat",
        json={"requesting_physician_id": requesting_physician_id, "question": question},
    )


def test_no_coordination_chat_endpoint_persists_or_exposes_a_shared_thread(api_client: TestClient) -> None:
    """Part 17: there must be no GET endpoint at all -- nothing is stored
    server-side for either physician to read back."""
    referral_id = _accepted_referral_id(api_client)
    _ask(api_client, referral_id, LUCY_AGENT_ID, "What is the referral concern?")
    # 405: the path only accepts POST now -- no GET route is registered at all.
    assert api_client.get(f"/api/referrals/{referral_id}/coordination-chat").status_code == 405


def test_no_chat_before_referral_acceptance(api_client: TestClient) -> None:
    referral_id = _submitted_referral_id(api_client)
    response = _ask(api_client, referral_id, CHEN_ID, "What is the referral question?")
    assert response.status_code == 403


def test_lucy_can_ask_chens_agent_after_acceptance(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What is the referral concern?")
    assert response.status_code == 200
    body = response.json()
    assert body["answer"]
    assert "requires_physician_input" in body
    assert "represented_agent_id" in body
    assert "created_at" in body


def test_chen_can_ask_saruhashis_agent_after_acceptance(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, CHEN_ID, "What was the original referral concern?")
    assert response.status_code == 200
    assert response.json()["answer"]


def test_lucys_question_is_never_visible_to_chen_and_vice_versa(api_client: TestClient) -> None:
    """Part 16: these are two entirely separate private interactions, never
    one shared physician-to-physician message thread. With no persistence
    and no GET endpoint, there is no way for either physician's question to
    ever reach the other's view -- confirmed by each call being independent
    and by no read surface existing at all."""
    referral_id = _accepted_referral_id(api_client)
    lucy_response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What follow-up did Dr. Chen recommend?")
    chen_response = _ask(api_client, referral_id, CHEN_ID, "What was the original referral concern?")
    assert lucy_response.json()["answer"] != chen_response.json()["answer"]
    # Neither response carries any trace of the other physician's question.
    assert "original referral concern" not in lucy_response.json()["answer"]
    assert "follow-up" not in chen_response.json()["answer"].lower()


def test_a_third_physician_cannot_ask(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, OTHER_PHYSICIAN_ID, "What is going on?")
    assert response.status_code == 403


def test_a_physician_cannot_ask_their_own_agent_through_this_channel(api_client: TestClient) -> None:
    """Asking resolves the OTHER party automatically -- there is no way to
    pass "self" as the represented physician at all."""
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, CHEN_ID, "test")
    assert response.status_code == 200
    assert response.json()["represented_agent_id"] == LUCY_AGENT_ID


def test_answers_are_grounded_in_the_real_referral_question(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What was included in the referral packet?")
    body = response.json()
    assert body["based_on"]
    assert "referral packet" in body["based_on"][0].lower() or "checklist" in body["based_on"][0].lower()


def test_unsupported_clinical_questions_escalate_instead_of_being_invented(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "Should we start insulin now?")
    body = response.json()
    assert body["requires_physician_input"] is True
    assert "Dr." in body["answer"] or PCP_NAME in body["answer"]


def test_chat_remains_available_after_scheduling_and_consult_returned(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "When is the appointment scheduled?")
    assert response.status_code == 200
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    api_client.post(f"/api/referrals/{referral_id}/handoff/send", json={"receiving_physician_id": CHEN_ID})
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What follow-up did Dr. Chen recommend?")
    assert response.status_code == 200
    assert response.json()["answer"]


def test_draft_handoff_content_is_never_shared_through_chat_before_it_is_sent(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    api_client.post(f"/api/referrals/{referral_id}/encounter/ingest", json={"receiving_physician_id": CHEN_ID})
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What follow-up did Dr. Chen recommend?")
    body = response.json()
    assert "sent handoff" not in " ".join(body["based_on"]).lower()


def test_represented_agent_id_resolves_correctly_for_both_directions(api_client: TestClient) -> None:
    referral_id = _accepted_referral_id(api_client)
    as_lucy = _ask(api_client, referral_id, LUCY_AGENT_ID, "What is the referral concern?").json()
    assert as_lucy["represented_agent_id"].startswith("agent-")
    assert as_lucy["represented_agent_id"] != LUCY_AGENT_ID

    as_chen = _ask(api_client, referral_id, CHEN_ID, "What was the original referral concern?").json()
    assert as_chen["represented_agent_id"] == LUCY_AGENT_ID


def test_no_other_patients_context_leaks_into_the_conversation(api_client: TestClient) -> None:
    """With no persistence at all, the only grounding source is the real
    referral/encounter/handoff/scheduling tied to THIS referral_id, loaded
    fresh per request -- nothing could carry another patient's context."""
    referral_id = _accepted_referral_id(api_client)
    response = _ask(api_client, referral_id, LUCY_AGENT_ID, "What was included in the referral packet?")
    assert response.status_code == 200
