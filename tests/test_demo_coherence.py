"""Demo coherence + training UX pass: readiness copy, "what your agent
learned this week" clarification opportunities, Test-page synthetic cases
that generalize a confirmed modality boundary, physician-facing language
cleanup, and demo reset/replay behavior."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import StructuredReferralPreference
from backend.professional_services import AgentChatService, ResponsesApiClient
from backend.referral_preferences import CHEN_SEED_CASE_FAMILY, clarification_opportunities
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import teach_and_confirm_chen_baseline

CHEN_ID = "physician-chen"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(referral_preferences_api, "workflow_store", value)
    monkeypatch.setattr(referrals_api, "workflow_store", value)
    monkeypatch.setattr(consult_api, "workflow_store", value)
    monkeypatch.setattr(workspace_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(engagement_api, "agent_chat_service", AgentChatService(ResponsesApiClient(enabled=False)))
    return value


def _bootstrap(client: TestClient) -> str:
    client.get("/api/patients")
    from backend.demo_workspace import DEFAULT_COOKIE_NAME

    return client.cookies[DEFAULT_COOKIE_NAME]


# ---------------------------------------------------------------- Part G: readiness


def test_chen_with_confirmed_representation_is_never_told_his_agent_is_untrained(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        overview = client.get("/api/workspace/physician/agent-overview?perspective=chen").json()
    assert "has a working representation" in overview["portrait"]
    assert "not been trained" not in overview["portrait"]


# ---------------------------------------------------------------- Part H/I/K/Y: learning opportunities


def test_no_clarification_opportunity_exists_before_chen_teaches_anything(store: WorkflowStore) -> None:
    """Demo-coherence causality fix: there is no gap to surface in a
    representation that doesn't exist yet -- the e-consult clarification
    must not appear until Chen has actually confirmed a baseline preference
    for this case family to have a gap in."""
    ws = "ws-demo-coherence-no-gap-pre-teaching"
    assert clarification_opportunities(store, ws, CHEN_ID) == []


def test_the_econsult_gap_surfaces_only_after_chen_confirms_his_baseline_preference(store: WorkflowStore) -> None:
    ws = "ws-demo-coherence-gap"
    teach_and_confirm_chen_baseline(store, ws)
    opportunities = clarification_opportunities(store, ws, CHEN_ID)
    assert len(opportunities) == 1
    assert opportunities[0]["id"] == "chen-econsult-modality-gap"
    assert "e-consult" in opportunities[0]["body"]


def test_the_opportunity_never_frames_this_as_an_agent_error(store: WorkflowStore) -> None:
    ws = "ws-demo-coherence-safety-language"
    teach_and_confirm_chen_baseline(store, ws)
    opportunity = clarification_opportunities(store, ws, CHEN_ID)[0]
    blob = (opportunity["title"] + opportunity["body"] + opportunity["supporting_text"]).casefold()
    for forbidden in ("wrong", "mistake", "error", "incorrect"):
        assert forbidden not in blob


def test_confirming_a_modality_preference_resolves_the_opportunity(store: WorkflowStore) -> None:
    ws = "ws-demo-coherence-resolve"
    teach_and_confirm_chen_baseline(store, ws)
    assert len(clarification_opportunities(store, ws, CHEN_ID)) == 1

    seed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    structured = StructuredReferralPreference.model_validate_json(seed["structured_rules_json"])
    structured.modality = "either"
    structured.modality_notes = "E-consult for focused questions with complete workup; in-person when worsening despite escalation."
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "e-consult clarification",
        structured.model_dump_json(), "physician_authored_nlp",
    )
    store.confirm_referral_preference(ws, created["id"], None)

    assert clarification_opportunities(store, ws, CHEN_ID) == []


def test_a_draft_clarification_does_not_resolve_the_opportunity(store: WorkflowStore) -> None:
    """Part K: a draft never silently changes representation."""
    ws = "ws-demo-coherence-draft-no-op"
    teach_and_confirm_chen_baseline(store, ws)
    structured = StructuredReferralPreference(modality="either")
    store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "draft only", structured.model_dump_json(), "physician_authored_nlp"
    )
    assert len(clarification_opportunities(store, ws, CHEN_ID)) == 1


def test_overview_exposes_the_learning_opportunity_for_chen_but_not_other_physicians(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        before_teaching = client.get("/api/workspace/physician/agent-overview?perspective=chen").json()
        assert before_teaching["learning_opportunities"] == []

        teach_and_confirm_chen_baseline(store, ws)
        chen_overview = client.get("/api/workspace/physician/agent-overview?perspective=chen").json()
        iain_overview = client.get("/api/workspace/physician/agent-overview?perspective=iain").json()
    assert len(chen_overview["learning_opportunities"]) == 1
    assert iain_overview["learning_opportunities"] == []


# ---------------------------------------------------------------- Part L/M: language cleanup


def test_generated_training_questions_never_say_this_case_without_context() -> None:
    from backend.engagement import generated_training_questions

    for question in generated_training_questions("iain"):
        assert "this case" not in question["prompt"].casefold()


def test_generated_training_questions_why_this_matters_has_no_internal_dimension_jargon() -> None:
    from backend.engagement import generated_training_questions

    for question in generated_training_questions("chen"):
        why = question["why_this_matters"]
        assert "boundary." not in why or "Helps your agent" in why
        for dimension_word in ("diagnosis_phenotype", "disease_severity", "prior_workup"):
            assert dimension_word not in why


def test_chens_canonical_case_question_shows_real_case_context() -> None:
    from backend.engagement import normalize_question

    normalized = normalize_question({
        "id": "chen-thyroid-nodule-fit",
        "source_type": "canonical_case",
        "source_reference": "patient-chen-maya-003",
    })
    assert normalized["case_context"] is not None
    assert "thyroid nodule" in normalized["case_context"].casefold()


def test_a_question_with_no_real_case_gets_no_case_context_block() -> None:
    from backend.engagement import normalize_question

    normalized = normalize_question({
        "id": "some-bank-question",
        "source_type": "practice_gap",
        "source_reference": "calibration:diagnosis_phenotype:0",
    })
    assert normalized["case_context"] is None


# ---------------------------------------------------------------- Part N/O/P/X: Test synthetic cases


def test_focused_medication_case_defaults_conservative_before_econsult_is_confirmed(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        response = client.post(
            "/api/workspace/physician/agent-chat?perspective=chen",
            json={"mode": "synthetic_case", "message": "How would I want this handled?",
                  "controlled_test_case_id": "chen-test-focused-medication-question", "origin": "synthetic_demo"},
        )
    assert response.status_code == 201
    body = response.json()
    assert body["coverage"] == "uncertain"
    assert "haven't yet confirmed" in body["answer"] or "have not confirmed" in body["answer"].casefold()


def test_focused_medication_case_applies_confirmed_econsult_preference(store: WorkflowStore) -> None:
    ws = None
    with TestClient(app) as client:
        ws = _bootstrap(client)
        structured = StructuredReferralPreference(
            good_fit=["Persistent, worsening type 2 diabetes despite medication escalation."],
            modality="either",
        )
        created = store.create_referral_preference(
            ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "econsult confirmed", structured.model_dump_json(),
            "physician_authored_nlp",
        )
        store.confirm_referral_preference(ws, created["id"], None)

        response = client.post(
            "/api/workspace/physician/agent-chat?perspective=chen",
            json={"mode": "synthetic_case", "message": "How would I want this handled?",
                  "controlled_test_case_id": "chen-test-focused-medication-question", "origin": "synthetic_demo"},
        )
    body = response.json()
    assert body["coverage"] == "confirmed_representation"
    assert "e-consult" in body["answer"].casefold()


def test_worsening_escalation_case_still_prefers_in_person_after_the_same_confirmation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        structured = StructuredReferralPreference(
            good_fit=["Persistent, worsening type 2 diabetes despite medication escalation."],
            modality="either",
        )
        created = store.create_referral_preference(
            ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "econsult confirmed", structured.model_dump_json(),
            "physician_authored_nlp",
        )
        store.confirm_referral_preference(ws, created["id"], None)

        response = client.post(
            "/api/workspace/physician/agent-chat?perspective=chen",
            json={"mode": "synthetic_case", "message": "How would I want this handled?",
                  "controlled_test_case_id": "chen-test-worsening-escalation", "origin": "synthetic_demo"},
        )
    body = response.json()
    assert body["coverage"] == "confirmed_representation"
    assert "in-person" in body["answer"].casefold()


def test_running_a_synthetic_test_case_never_mutates_representation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        before = store.confirmed_referral_preferences_for_physician(ws, CHEN_ID)
        client.post(
            "/api/workspace/physician/agent-chat?perspective=chen",
            json={"mode": "synthetic_case", "message": "How would I want this handled?",
                  "controlled_test_case_id": "chen-test-worsening-escalation", "origin": "synthetic_demo"},
        )
        after = store.confirmed_referral_preferences_for_physician(ws, CHEN_ID)
    assert before == after


# ---------------------------------------------------------------- Part V/W: demo reset


def test_reset_tonjit_also_returns_chens_referral_preferences_to_baseline(store: WorkflowStore) -> None:
    """Demo-coherence causality fix (Part 9): reset must restore the TRUE
    pre-teaching state -- zero confirmed referral preferences, zero
    clarification opportunities -- never silently recreate a confirmed
    migration standing in for Chen's own teaching."""
    with TestClient(app) as client:
        ws = _bootstrap(client)
        teach_and_confirm_chen_baseline(store, ws)
        assert len(clarification_opportunities(store, ws, CHEN_ID)) == 1

        structured = StructuredReferralPreference(modality="either")
        created = store.create_referral_preference(
            ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "clarified", structured.model_dump_json(), "physician_authored_nlp"
        )
        store.confirm_referral_preference(ws, created["id"], None)
        assert clarification_opportunities(store, ws, CHEN_ID) == []

        response = client.post("/api/workspace/demo/reset/tonjit")
        assert response.status_code == 200
        assert response.json()["removed_chen_referral_preferences"] >= 1

        assert store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY) is None
        # Nothing is auto-recreated -- there is no confirmed baseline left
        # to have a gap in, so there is no opportunity either, exactly like
        # a brand-new workspace that has never seen Chen teach anything.
        assert clarification_opportunities(store, ws, CHEN_ID) == []
