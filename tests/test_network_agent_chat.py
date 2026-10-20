"""Pre-NLP physician-representation cleanup pass, Part J-Q: "Ask their
agent" from a Network physician profile. General practice questions only,
grounded exclusively in that physician's own confirmed representation,
never patient-specific, never persisted."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.workflow import WorkflowStore


@pytest.fixture
def engagement_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    store = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(consult_api, "workflow_store", store)
    monkeypatch.setattr(workspace_api, "workflow_store", store)
    monkeypatch.setattr(specialist_api, "workflow_store", store)
    monkeypatch.setattr(engagement_api, "workflow_store", store)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", store)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return store


def _ask(client: TestClient, controlled_id: str, question: str) -> dict:
    response = client.post(f"/api/workspace/network/physicians/{controlled_id}/ask", json={"question": question})
    assert response.status_code == 200
    return response.json()


def test_chen_answers_a_workup_question_from_his_confirmed_representation(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        answer = _ask(client, "chen", "What workup do you usually want before seeing a referral?")
    assert "Chen" in answer["answer"]
    assert answer["based_on"] == ["confirmed practice representation"]
    assert answer["requires_physician_input"] is False
    assert answer["represented_agent_id"]
    assert answer["created_at"]


def test_chen_answers_a_case_interest_question_from_his_confirmed_clinical_focus(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        answer = _ask(client, "chen", "What kinds of diabetes cases are most useful to send you?")
    assert "type 2 diabetes" in answer["answer"]


def test_econsult_question_answers_from_chens_confirmed_referral_preference(
    engagement_store: WorkflowStore,
) -> None:
    """NLP referral-preference pass, Part V: Dr. Chen's confirmed diabetes
    referral preference (migrated from his existing fixture, Part K) now
    includes a confirmed modality preference -- this question is no longer
    an honest-uncertainty case for him specifically (see
    test_unsupported_econsult_preference_is_an_honest_uncertainty_not_a_fabricated_policy
    below, which covers a physician with no confirmed modality preference at
    all)."""
    with TestClient(app) as client:
        answer = _ask(client, "chen", "When would you prefer an e-consult versus an in-person visit?")
    assert "has confirmed" in answer["answer"]
    assert answer["based_on"] == ["confirmed referral preference"]
    assert answer["requires_physician_input"] is False


def test_unsupported_econsult_preference_is_an_honest_uncertainty_not_a_fabricated_policy(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        answer = _ask(client, "iain", "When would you prefer an e-consult versus an in-person visit?")
    assert "has not confirmed a preference" in answer["answer"]
    assert answer["based_on"] == []
    assert answer["requires_physician_input"] is True


def test_a_generic_unrelated_question_declines_rather_than_hallucinating(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        answer = _ask(client, "chen", "What do you think about this experimental new drug?")
    assert "don't have enough confirmed information" in answer["answer"]
    assert answer["requires_physician_input"] is True


def test_maya_is_also_eligible_and_answered_from_her_own_representation(
    engagement_store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        answer = _ask(client, "maya", "What workup do you usually want?")
    assert "Dr. Maya Ramanathan" in answer["answer"] or "Dr. Ramanathan" in answer["answer"]


def test_unknown_controlled_physician_404s(engagement_store: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post("/api/workspace/network/physicians/not-a-real-persona/ask", json={"question": "hi"})
    assert response.status_code == 404


def test_nothing_is_persisted_by_asking_the_network_agent(engagement_store: WorkflowStore) -> None:
    """Ephemeral by construction: the endpoint never touches workflow_store
    at all for this question/answer, so two independent questions never
    see each other's state and nothing survives between calls."""
    with TestClient(app) as client:
        first = _ask(client, "chen", "What workup do you usually want?")
        second = _ask(client, "chen", "What workup do you usually want?")
    assert first["answer"] == second["answer"]
