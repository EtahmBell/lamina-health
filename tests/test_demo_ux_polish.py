"""Demo UX + semantic polish pass: pre/post-training representation
clarity, conditional modality semantics (never redirect, never a
misleading flat "Either" label), and the clarification copy/causality it
all depends on."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import workspace as workspace_api
from backend.engagement import base_practice_representation
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import StructuredReferralPreference
from backend.professional_services import AgentChatService, ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    clarification_opportunities,
    confirmed_referral_preference_sections,
    deterministic_interpret,
    preference_modality_label,
)
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import teach_and_confirm_chen_baseline

CHEN_ID = "physician-chen"

ECONSULT_CLARIFICATION_TEXT = (
    "For straightforward medication questions, I'm happy to start with an e-consult when the recent "
    "A1c, current medications, and kidney function are available. If control is continuing to worsen "
    "despite treatment escalation, I generally prefer an in-person evaluation."
)


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(referral_preferences_api, "workflow_store", value)
    monkeypatch.setattr(referrals_api, "workflow_store", value)
    monkeypatch.setattr(workspace_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    monkeypatch.setattr(engagement_api, "agent_chat_service", AgentChatService(ResponsesApiClient(enabled=False)))
    # Force the deterministic fallback path -- interpretation must be
    # exercised the same reproducible way whether or not a live model API
    # happens to be configured in the environment running these tests.
    monkeypatch.setattr(
        referral_preferences_api, "referral_preference_interpretation_service",
        ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False)),
    )
    return value


def _bootstrap(client: TestClient) -> str:
    client.get("/api/patients")
    from backend.demo_workspace import DEFAULT_COOKIE_NAME

    return client.cookies[DEFAULT_COOKIE_NAME]


# ---------------------------------------------------------------- Part 1/2: pre-training representation


def test_chens_pre_training_requirements_are_his_footprint_baseline_not_generic_profile_workup() -> None:
    """Routing consolidation pass, Part O/Y: the footprint baseline the
    agent actually applies is shown, split required vs helpful -- never the
    generic profile workup duplicated into both sections."""
    sections = base_practice_representation("chen")
    assert "Recent renal function" in sections["referral_requirements"]
    assert "Glucose log or CGM data" in sections["preferred_workup"]
    assert not set(sections["referral_requirements"]) & set(sections["preferred_workup"])
    # Clinical focus/access are untouched -- only the receiving-requirements
    # sections that would visually imply a confirmed referral policy change.
    assert sections["clinical_focus"]
    assert sections["access_facts"]


def test_an_unrelated_physician_with_no_confirmed_preference_system_is_unaffected() -> None:
    sections = base_practice_representation("iain")
    assert sections["referral_requirements"] != []


# ---------------------------------------------------------------- Part 3: no duplicated requirements


def test_required_and_helpful_items_are_mutually_exclusive_after_confirmation(store: WorkflowStore) -> None:
    ws = "ws-dedup-check"
    teach_and_confirm_chen_baseline(store, ws)
    sections = confirmed_referral_preference_sections(store, ws, CHEN_ID)
    assert sections is not None
    assert set(sections["referral_requirements"]).isdisjoint(sections["preferred_workup"])
    assert sections["referral_requirements"]
    assert sections["preferred_workup"]


def test_practice_rules_does_not_restate_the_good_fit_sentence_already_shown_under_referral_fit(
    store: WorkflowStore,
) -> None:
    ws = "ws-no-restated-good-fit"
    teach_and_confirm_chen_baseline(store, ws)
    sections = confirmed_referral_preference_sections(store, ws, CHEN_ID)
    assert sections is not None
    for rule in sections["explicit_rules"]:
        assert not rule.startswith("Accepts:")


# ---------------------------------------------------------------- Part 7: conditional modality semantics


def test_in_person_preference_is_never_classified_as_redirect() -> None:
    structured = deterministic_interpret(
        "If control is continuing to worsen despite treatment escalation, I generally prefer an "
        "in-person evaluation.",
        CHEN_SEED_CASE_FAMILY,
    )
    assert structured.redirect == []
    assert structured.modality == "in_person"
    assert len(structured.modality_rules) == 1
    assert structured.modality_rules[0].modality == "in_person"


def test_a_genuine_redirect_statement_still_classifies_as_redirect() -> None:
    structured = deterministic_interpret(
        "I prefer to redirect complex cardiology cases to a specialist.", CHEN_SEED_CASE_FAMILY
    )
    assert structured.redirect


def test_the_exact_econsult_clarification_text_produces_two_conditional_modality_rules() -> None:
    structured = deterministic_interpret(ECONSULT_CLARIFICATION_TEXT, CHEN_SEED_CASE_FAMILY)
    assert structured.modality == "either"
    assert structured.redirect == []
    assert structured.required == []  # the required recent workup clause must not leak into "required"
    kinds = {rule.modality for rule in structured.modality_rules}
    assert kinds == {"econsult", "in_person"}
    econsult_condition = next(r.condition for r in structured.modality_rules if r.modality == "econsult").casefold()
    in_person_condition = next(r.condition for r in structured.modality_rules if r.modality == "in_person").casefold()
    assert "available" in econsult_condition
    assert "worsen" in in_person_condition


def test_conditional_modality_never_renders_as_the_misleading_flat_either_label() -> None:
    structured = deterministic_interpret(ECONSULT_CLARIFICATION_TEXT, CHEN_SEED_CASE_FAMILY)
    label = preference_modality_label(structured)
    assert label is not None
    assert "no strong preference" not in label.casefold()
    assert "e-consult" in label.casefold()
    assert "in-person" in label.casefold()


def test_modality_preference_section_shows_conditional_guidance_not_either_no_strong_preference(
    store: WorkflowStore,
) -> None:
    ws = "ws-conditional-modality-representation"
    teach_and_confirm_chen_baseline(store, ws)
    seed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    structured = StructuredReferralPreference.model_validate_json(seed["structured_rules_json"])
    clarified = deterministic_interpret(ECONSULT_CLARIFICATION_TEXT, CHEN_SEED_CASE_FAMILY)
    structured.modality = clarified.modality
    structured.modality_rules = clarified.modality_rules
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, ECONSULT_CLARIFICATION_TEXT,
        structured.model_dump_json(), "physician_authored_nlp",
    )
    store.confirm_referral_preference(ws, created["id"], None)

    sections = confirmed_referral_preference_sections(store, ws, CHEN_ID)
    assert sections is not None
    assert sections["modality_preference"] is not None
    assert "no strong preference" not in sections["modality_preference"].casefold()
    assert clarification_opportunities(store, ws, CHEN_ID) == []


# ---------------------------------------------------------------- Part 8: clarification copy


def test_the_clarifying_question_is_short_enough_to_never_wrap_into_a_heavy_multiline_title(
    store: WorkflowStore,
) -> None:
    ws = "ws-short-clarifying-question"
    teach_and_confirm_chen_baseline(store, ws)
    opportunity = clarification_opportunities(store, ws, CHEN_ID)[0]
    assert len(opportunity["clarifying_question"]) <= 60
    assert "comfortable" not in opportunity["clarifying_question"].casefold()


# ---------------------------------------------------------------- Part 17: causality still holds end to end


def test_reset_then_teach_then_clarify_end_to_end_causality_still_holds(store: WorkflowStore) -> None:
    from backend.synthetic_data import TONJIT_PATIENT_ID

    with TestClient(app) as client:
        _bootstrap(client)
        before = client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
        ).json()
        # Routing consolidation pass, Part Y: the footprint baseline already
        # applies before any teaching.
        assert any(item["key"] == "recent_renal_function" for item in before["receiving_requirements"])

        client.post("/api/workspace/demo/reset/tonjit")
        preference_url = "/api/workspace/physician/chen/referral-preferences"
        client.post(f"{preference_url}/interpret", json={
            "source_text": (
                "For diabetes referrals, I usually need a recent A1c, current diabetes medications, "
                "and recent kidney function. Glucose logs or CGM are useful when available, but "
                "aren't required. I commonly see patients whose diabetes remains poorly controlled "
                "despite treatment escalation."
            )
        })
        draft = client.get(preference_url).json()[0]
        confirmed = client.post(f"{preference_url}/{draft['id']}/confirm").json()
        assert confirmed["source"] == "physician_authored_nlp"

        after = client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals", json={"receiving_physician_id": CHEN_ID}
        ).json()
    after_keys = {item["key"] for item in after["receiving_requirements"]}
    assert {"recent_hba1c", "current_medications", "recent_renal_function"} <= after_keys
