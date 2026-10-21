"""Active physician-agent network pass: "Ask the Network" (Part H-U/X).

A bounded, explainable professional-network query, grounded only in
confirmed physician representation/case interests/referral preferences and
physician-approved broadcasts -- never a generic search engine, never a
magic score, never patient memory that persists beyond the request.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.workflow import WorkflowStore

WS = "network-query-test-workspace"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(consult_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    return value


def _ask(client: TestClient, question: str, patient_id: str | None = None) -> dict:
    body = {"question": question}
    if patient_id:
        body["patient_id"] = patient_id
    response = client.post("/api/workspace/network/ask", json=body)
    assert response.status_code == 200
    return response.json()


# ------------------------------------------------------- Part X.1/X.2: general query


def test_general_ask_the_network_works_without_patient_context(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who in my network handles osteoporosis cases?")
    assert result["routing"] is None
    assert any(item["physician_id"] == "physician-ramanathan" for item in result["physician_agents"])


def test_general_query_uses_confirmed_physician_representation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "What do nephrologists in my network usually want before resistant-hypertension referrals?")
    jung = next(item for item in result["physician_agents"] if item["physician_id"] == "physician-jung")
    assert any("Nephrology" in reason for reason in jung["reasons"])


# ------------------------------------------------------- Part X.3/X.4: case interests / referral preferences


def test_relevant_confirmed_case_interest_surfaces_a_physician(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who prefers difficult osteoporosis management cases?")
    maya = next(item for item in result["physician_agents"] if item["physician_id"] == "physician-ramanathan")
    assert any("Osteoporosis management" in reason for reason in maya["reasons"])


def test_relevant_confirmed_referral_preference_surfaces_a_physician(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who sees patients with worsening type 2 diabetes despite medication escalation?")
    chen = next(item for item in result["physician_agents"] if item["physician_id"] == "physician-chen")
    assert any("Confirmed referral preference" in reason for reason in chen["reasons"])


# ------------------------------------------------------- Part X.5/X.6: broadcasts and draft exclusion


def test_an_approved_broadcast_may_surface_as_relevant_network_context(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who has recently posted about osteoporosis cases?")
    assert any(item["post_id"] == "fixture-maya-osteoporosis" for item in result["broadcasts"])


def test_an_unapproved_draft_representation_does_not_influence_the_result(store: WorkflowStore) -> None:
    """A DRAFT referral preference (never confirmed) must never surface as
    network signal -- only confirmed representation grounds a match."""
    from backend.models import StructuredReferralPreference

    with TestClient(app) as client:
        before = _ask(client, "Who treats a distinctive unconfirmed condition xyzrareqpq?")
    assert before["physician_agents"] == []
    structured = StructuredReferralPreference(good_fit=["Distinctive unconfirmed condition xyzrareqpq."])
    store.create_referral_preference(
        WS, "physician-chen", "type_2_diabetes", "draft only", structured.model_dump_json(), "physician_authored_nlp"
    )
    with TestClient(app) as client:
        after = _ask(client, "Who treats a distinctive unconfirmed condition xyzrareqpq?")
    assert after["physician_agents"] == []


# ------------------------------------------------------- Part X.7/X.8/X.9: patient-specific


def test_patient_specific_ask_the_network_uses_existing_routing_and_candidate_logic(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who should see this diabetes case?", patient_id="patient-t2dm-003")
    assert result["routing"] is not None
    assert result["routing"]["case_family"] == "type_2_diabetes"
    physician_ids = {item["physician_id"] for item in result["routing"]["evaluations"]}
    assert physician_ids == {"physician-chen", "physician-okonkwo", "physician-torres"}


def test_patient_specific_query_creates_no_referral(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        before = store.list_referrals(WS)
        _ask(client, "Who should see this diabetes case?", patient_id="patient-t2dm-003")
        after = store.list_referrals(WS)
    assert before == after == []


def test_candidate_physicians_acquire_no_durable_patient_memory(store: WorkflowStore) -> None:
    """Nothing about the query is persisted anywhere -- a second identical
    query starts from the same clean state."""
    with TestClient(app) as client:
        _ask(client, "Who should see this diabetes case?", patient_id="patient-t2dm-003")
    assert store.list_referrals(WS) == []
    assert store.proposed_learnings(WS, "chen") == []


def test_an_unknown_patient_id_404s_rather_than_silently_ignoring_patient_context(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post("/api/workspace/network/ask", json={"question": "test", "patient_id": "not-a-real-patient"})
    assert response.status_code == 404


# ------------------------------------------------------- Part X.13/X.14/X.15/X.16: provenance + self-training


def test_physician_authored_and_approved_broadcasts_are_typed_by_provenance(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "Who has recently posted about osteoporosis cases?")
    broadcast = next(item for item in result["broadcasts"] if item["post_id"] == "fixture-maya-osteoporosis")
    assert broadcast["provenance_type"] == "physician_authored"


def test_an_agent_broadcast_from_confirmed_representation_is_typed_distinctly(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        result = _ask(client, "What does Dr. Chen look for in a diabetes referral?")
    broadcast = next(item for item in result["broadcasts"] if item["post_id"] == "fixture-chen-diabetes-fit-broadcast")
    assert broadcast["provenance_type"] == "agent_broadcast_from_confirmed_representation"


def test_reading_an_agent_broadcast_never_changes_the_representation_snapshot(store: WorkflowStore) -> None:
    from backend.representation import representation_snapshot_id

    before = representation_snapshot_id(store, WS, "chen")
    with TestClient(app) as client:
        _ask(client, "What does Dr. Chen look for in a diabetes referral?")
    after = representation_snapshot_id(store, WS, "chen")
    assert before == after


def test_reading_an_agent_broadcast_creates_no_proposed_learning(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _ask(client, "What does Dr. Chen look for in a diabetes referral?")
    assert store.proposed_learnings(WS, "chen") == []
