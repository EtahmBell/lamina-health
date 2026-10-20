"""First NLP physician-representation feature: natural-language referral
preferences (Part A-AB).

Core loop under test: physician natural language -> structured DRAFT
interpretation -> physician review -> confirm/edit/reject -> confirmed
PhysicianReferralPreference -> PhysicianRepresentation changes -> future
agent behavior changes. The single most important property tested here
(Part M/N) is that a DRAFT never changes operational behavior and a
CONFIRMED preference does.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.agents import evaluate_physician
from backend.api import consult as consult_api
from backend.api import engagement as engagement_api
from backend.api import referral_preferences as referral_preferences_api
from backend.api import referrals as referrals_api
from backend.api import specialist as specialist_api
from backend.api import workspace as workspace_api
from backend.clinical import build_patient_context
from backend.demo_workspace import DEFAULT_COOKIE_NAME
from backend.eval_harness import run_eval_case
from backend.eval_harness.cases import CHEN_EVAL_CASES
from backend.fhir import SyntheticClinicalDataSource
from backend.main import app
from backend.models import StructuredReferralPreference
from backend.professional_services import ResponsesApiClient
from backend.referral_preferences import (
    CHEN_SEED_CASE_FAMILY,
    ReferralPreferenceInterpretationService,
    _fallback_case_rules,
    case_rules_from_preference,
    confirmed_case_rules_override,
    confirmed_requirement_items,
    deterministic_interpret,
    ensure_seed_preferences,
)
from backend.referrals import requirements_for
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PHYSICIAN_CHEN, TONJIT_PATIENT_ID
from backend.synthetic_data.fixtures import PATIENTS
from backend.workflow import WorkflowStore

CHEN_ID = "physician-chen"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(referral_preferences_api, "workflow_store", value)
    monkeypatch.setattr(referrals_api, "workflow_store", value)
    monkeypatch.setattr(consult_api, "workflow_store", value)
    monkeypatch.setattr(engagement_api, "workflow_store", value)
    monkeypatch.setattr(workspace_api, "workflow_store", value)
    monkeypatch.setattr(specialist_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    monkeypatch.setattr(consult_api, "data_source", SyntheticClinicalDataSource())
    # Force the deterministic fallback path -- interpretation must be
    # exercised the same reproducible way whether or not a live model API
    # happens to be configured in the environment running these tests.
    monkeypatch.setattr(
        referral_preferences_api,
        "referral_preference_interpretation_service",
        ReferralPreferenceInterpretationService(ResponsesApiClient(enabled=False)),
    )
    return value


def _bootstrap(client: TestClient) -> str:
    """The real server-managed workspace is cookie-based, not a query param
    -- the first request through `client` auto-creates one. Returns that
    real workspace_id so a test's direct `store.*()` calls can read/write
    the SAME workspace the HTTP requests on this client will see."""
    client.get("/api/patients")
    return client.cookies[DEFAULT_COOKIE_NAME]


def _preference_url(path: str = "") -> str:
    return f"/api/workspace/physician/chen/referral-preferences{path}"


SOURCE_TEXT = (
    "For diabetes referrals, I usually need a recent A1c, current diabetes medications, "
    "and recent kidney function. Glucose logs or CGM are useful when available, but aren't "
    "required. I commonly see patients whose diabetes remains poorly controlled despite "
    "treatment escalation."
)


# ---------------------------------------------------------------- Part 1-6: the review loop


def test_physician_can_enter_a_natural_language_preference_and_receives_a_structured_draft(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        response = client.post(_preference_url("/interpret"), json={"source_text": SOURCE_TEXT})
    assert response.status_code == 200
    draft = response.json()
    assert draft["status"] == "draft"
    assert draft["source_text"] == SOURCE_TEXT
    assert draft["physician_id"] == CHEN_ID
    required_keys = {item["key"] for item in draft["structured_rules"]["required"]}
    assert "recent_hba1c" in required_keys
    assert "current_medications" in required_keys
    assert "recent_renal_function" in required_keys
    helpful_keys = {item["key"] for item in draft["structured_rules"]["helpful"]}
    assert "glucose_log" in helpful_keys
    assert draft["structured_rules"]["good_fit"]


def test_deterministic_interpretation_never_invents_an_unspecified_freshness_window() -> None:
    structured = deterministic_interpret(SOURCE_TEXT, "type_2_diabetes")
    for item in [*structured.required, *structured.helpful]:
        assert item.freshness_days is None


def test_physician_can_edit_the_interpretation_before_confirming(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        draft = client.post(_preference_url("/interpret"), json={"source_text": SOURCE_TEXT}).json()
        edited_rules = {**draft["structured_rules"], "required": draft["structured_rules"]["required"][:1]}
        response = client.patch(_preference_url(f"/{draft['id']}"), json={"structured_rules": edited_rules})
    assert response.status_code == 200
    assert len(response.json()["structured_rules"]["required"]) == 1


def test_physician_can_reject_the_interpretation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        draft = client.post(_preference_url("/interpret"), json={"source_text": SOURCE_TEXT}).json()
        response = client.post(_preference_url(f"/{draft['id']}/reject"))
    assert response.status_code == 200
    assert response.json()["status"] == "rejected"


def test_a_rejected_preference_cannot_be_confirmed(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        draft = client.post(_preference_url("/interpret"), json={"source_text": SOURCE_TEXT}).json()
        client.post(_preference_url(f"/{draft['id']}/reject"))
        response = client.post(_preference_url(f"/{draft['id']}/confirm"))
    assert response.status_code == 409


def test_confirm_makes_a_preference_appear_as_confirmed(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        draft = client.post(_preference_url("/interpret"), json={"source_text": SOURCE_TEXT}).json()
        response = client.post(_preference_url(f"/{draft['id']}/confirm"))
    assert response.status_code == 200
    confirmed = response.json()
    assert confirmed["status"] == "confirmed"
    assert confirmed["confirmed_at"]
    assert confirmed["representation_snapshot_id_at_confirmation"]


# ---------------------------------------------------------------- Part M: the critical test


def test_draft_preference_never_affects_requirements_only_confirming_does(store: WorkflowStore) -> None:
    ws = "ws-draft-does-nothing"
    before = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert before is None  # not yet seeded in this isolated workspace

    ensure_seed_preferences(store, ws)
    seeded = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert any(item.key == "recent_renal_function" for item in seeded)

    structured = StructuredReferralPreference(
        good_fit=["Persistent, worsening type 2 diabetes despite medication escalation."],
        required=[item for item in seeded if item.key != "recent_renal_function"],
        helpful=[],
        modality="in_person",
    )
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "test: drop renal function requirement",
        structured.model_dump_json(), "physician_authored_nlp",
    )
    assert created["status"] == "draft"

    # EXPECTED: a draft changes nothing -- renal function is STILL required.
    still_required = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert any(item.key == "recent_renal_function" for item in still_required)
    requirements = requirements_for(CHEN_ID, CHEN_SEED_CASE_FAMILY, still_required)
    assert any(item.key == "recent_renal_function" for item in requirements)

    store.confirm_referral_preference(ws, created["id"], None)

    # EXPECTED: confirming now reflects the updated preference.
    after_confirm = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert not any(item.key == "recent_renal_function" for item in after_confirm)
    requirements_after = requirements_for(CHEN_ID, CHEN_SEED_CASE_FAMILY, after_confirm)
    assert not any(item.key == "recent_renal_function" for item in requirements_after)


def test_confirming_a_new_preference_supersedes_the_prior_confirmed_one(store: WorkflowStore) -> None:
    ws = "ws-supersede"
    ensure_seed_preferences(store, ws)
    seed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    structured = StructuredReferralPreference(good_fit=["Edited good fit."], modality="econsult")
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "edited", structured.model_dump_json(), "physician_authored_nlp"
    )
    store.confirm_referral_preference(ws, created["id"], None)
    reloaded_seed = store.referral_preference(ws, seed["id"])
    assert reloaded_seed["status"] == "superseded"
    now_confirmed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert now_confirmed["id"] == created["id"]


# ---------------------------------------------------------------- Part N: end-to-end production proof


def test_confirming_a_new_preference_for_a_previously_unconfigured_physician_changes_a_real_referral(
    store: WorkflowStore,
) -> None:
    """Dr. Okonkwo (Tonjit's alternative endocrinologist) has no entry in
    REFERRAL_REQUIREMENTS_BY_KEY today -- before any confirmed preference, a
    referral to him carries zero receiving requirements. After confirming
    one directly in storage (he has no persona/editable-profile wiring in
    this demo pass -- see ensure_chen_seed_preference for the same pattern),
    a real referral created through the real API carries it. (The real
    referral-creation endpoint is idempotent per patient+physician pair --
    see find_active_referral_for_pair -- so "before" is checked via the same
    pure confirmed_requirement_items() the endpoint itself calls, and this
    pair only ever gets ONE real referral within this test.)"""
    okonkwo_id = "physician-okonkwo"
    with TestClient(app) as client:
        ws = _bootstrap(client)
        assert confirmed_requirement_items(store, ws, okonkwo_id, CHEN_SEED_CASE_FAMILY) is None

        structured = StructuredReferralPreference(
            good_fit=["Progressive type 2 diabetes needing treatment intensification."],
            required=[{"key": "recent_hba1c", "label": "Recent HbA1c", "required": True, "freshness_days": None}],
        )
        draft = store.create_referral_preference(
            ws, okonkwo_id, CHEN_SEED_CASE_FAMILY, "test preference", structured.model_dump_json(),
            "physician_authored_nlp",
        )
        store.confirm_referral_preference(ws, draft["id"], None)

        after = client.post(
            f"/api/patients/{TONJIT_PATIENT_ID}/referrals",
            json={"receiving_physician_id": okonkwo_id},
        ).json()
    assert any(item["key"] == "recent_hba1c" for item in after["receiving_requirements"])


# ---------------------------------------------------------------- Part K/A: one source of truth


def test_resolve_case_rules_prefers_the_confirmed_preference_over_the_static_fixture() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    structured = StructuredReferralPreference(good_fit=["A distinctive confirmed good-fit sentence."])
    fallback = _fallback_case_rules(CHEN_ID, "type_2_diabetes")
    case_rules = case_rules_from_preference(CHEN_ID, "type_2_diabetes", structured, fallback)
    assert case_rules.explicit_rules[0] == "Accepts: A distinctive confirmed good-fit sentence."
    evaluation = evaluate_physician(patient, context, PHYSICIAN_CHEN, case_rules)
    assert evaluation.evidence[0].detail == "Accepts: A distinctive confirmed good-fit sentence."


def test_physicians_without_a_confirmed_preference_still_use_the_fallback_fixture(store: WorkflowStore) -> None:
    """Dr. Iain Jung has no confirmed referral preference anywhere in this
    pass -- resolve_case_rules()/requirements_for() must be completely
    unaffected (Part J: "physicians who only ever see one case family ...
    are completely unaffected")."""
    ws = "ws-iain-unaffected"
    override = confirmed_case_rules_override(store, ws, "physician-jung", "ckd_hypertension")
    assert override is None
    items = confirmed_requirement_items(store, ws, "physician-jung", "ckd_hypertension")
    assert items is None


def test_no_duplicate_hidden_chen_rule_source_remains_operational(store: WorkflowStore) -> None:
    """After seeding, Chen's CONFIRMED preference -- not the static fixture
    -- is the one resolve_case_rules()/requirements_for() actually read."""
    ws = "ws-one-source-of-truth"
    ensure_seed_preferences(store, ws)
    override = confirmed_case_rules_override(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert override is not None
    assert override.explicit_rules[0].startswith("Accepts: Persistent, worsening type 2 diabetes")
    items = confirmed_requirement_items(store, ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    assert [item.key for item in items] == [
        "recent_hba1c", "current_medications", "recent_renal_function", "glucose_log",
    ]


def test_tonjit_default_behavior_is_unchanged_by_seeding_chens_confirmed_preference(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        result = client.post(f"/api/patients/{TONJIT_PATIENT_ID}/consultations", json={}).json()
    assert result["recommended_physician"]["physician_name"].startswith("Dr. Noah Chen")
    assert result["recommended_physician"]["clinical_fit"] == "strong"
    assert result["care_routing"]["recommended_modality"] == "in_person"


# ---------------------------------------------------------------- Part Q: Practice Representation


def test_confirmed_preference_appears_in_practice_representation(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        representation = client.get("/api/workspace/physician/agent-representation?perspective=chen").json()
    sections = representation["sections"]
    assert any("type 2 diabetes" in item for item in sections["good_fit"])
    assert "Recent HbA1c" in sections["referral_requirements"]
    assert sections["modality_preference"] == "In-person review preferred."
    assert sections["referral_preference_provenance"]


# ---------------------------------------------------------------- Part T: case interests inform fit, never gate it


def test_confirmed_case_interest_adds_fit_evidence_without_changing_accept_reject() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    without_interest = evaluate_physician(patient, context, PHYSICIAN_CHEN)
    with_interest = evaluate_physician(
        patient, context, PHYSICIAN_CHEN, None, ["Progressive type 2 diabetes treatment intensification"]
    )
    assert with_interest.clinical_fit == without_interest.clinical_fit
    assert with_interest.accepts_case == without_interest.accepts_case
    assert len(with_interest.evidence) > len(without_interest.evidence)
    assert any("confirmed case interest" in item.detail for item in with_interest.evidence)


def test_an_unrelated_case_interest_adds_no_fabricated_evidence() -> None:
    patient = PATIENTS[TONJIT_PATIENT_ID]
    context = build_patient_context(patient)
    with_unrelated_interest = evaluate_physician(
        patient, context, PHYSICIAN_CHEN, None, ["Thyroid nodule evaluation"]
    )
    assert not any("confirmed case interest" in item.detail for item in with_unrelated_interest.evidence)


# ---------------------------------------------------------------- Part V: Ask their agent


def test_ask_their_agent_grounds_in_confirmed_referral_preferences(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        response = client.post(
            "/api/workspace/network/physicians/chen/ask",
            json={"question": "What information do you generally want before a diabetes referral?"},
        )
    answer = response.json()
    assert "Recent HbA1c" in answer["answer"]
    assert answer["requires_physician_input"] is False


def test_ask_their_agent_never_grounds_in_a_draft_preference(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        ws = _bootstrap(client)
        ensure_seed_preferences(store, ws)
        structured = StructuredReferralPreference(good_fit=["A draft-only good fit nobody has confirmed."])
        store.create_referral_preference(
            ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "draft", structured.model_dump_json(), "physician_authored_nlp"
        )
        response = client.post(
            "/api/workspace/network/physicians/chen/ask",
            json={"question": "What kinds of diabetes cases are useful to send you?"},
        )
    assert "draft-only good fit nobody has confirmed" not in response.json()["answer"]


def test_ask_their_agent_abstains_when_no_physician_has_confirmed_a_modality_preference(
    store: WorkflowStore,
) -> None:
    with TestClient(app) as client:
        _bootstrap(client)
        response = client.post(
            "/api/workspace/network/physicians/iain/ask",
            json={"question": "When would you prefer an e-consult versus an in-person visit?"},
        )
    answer = response.json()
    assert "has not confirmed a preference" in answer["answer"]
    assert answer["requires_physician_input"] is True


# ---------------------------------------------------------------- Part O/P: evaluation before/after


def test_representation_snapshot_changes_after_confirmation(store: WorkflowStore) -> None:
    ws = "ws-snapshot-changes"
    before = representation_snapshot_id(store, ws, "chen")
    ensure_seed_preferences(store, ws)
    after_seed = representation_snapshot_id(store, ws, "chen")
    assert before != after_seed

    structured = StructuredReferralPreference(good_fit=["A new confirmed good fit."])
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "another edit", structured.model_dump_json(), "physician_authored_nlp"
    )
    unconfirmed_still = representation_snapshot_id(store, ws, "chen")
    assert unconfirmed_still == after_seed  # a draft never changes the snapshot

    store.confirm_referral_preference(ws, created["id"], None)
    after_second_confirm = representation_snapshot_id(store, ws, "chen")
    assert after_second_confirm != after_seed


def test_evaluation_harness_demonstrates_behavior_change_before_and_after_a_confirmed_preference(
    store: WorkflowStore,
) -> None:
    ws = "ws-eval-before-after"
    requirements_case = next(
        case for case in CHEN_EVAL_CASES if case.id == "chen-missing-renal-requirement"
    )
    ensure_seed_preferences(store, ws)
    before_run = run_eval_case(requirements_case, store, ws)
    assert before_run.status.value == "pass"
    assert "recent_renal_function" in before_run.structured_output["missing_required_items"]

    seed = store.confirmed_referral_preference(ws, CHEN_ID, CHEN_SEED_CASE_FAMILY)
    structured = StructuredReferralPreference.model_validate_json(seed["structured_rules_json"])
    structured.required = [item for item in structured.required if item.key != "recent_renal_function"]
    created = store.create_referral_preference(
        ws, CHEN_ID, CHEN_SEED_CASE_FAMILY, "renal no longer required",
        structured.model_dump_json(), "physician_authored_nlp",
    )
    store.confirm_referral_preference(ws, created["id"], None)

    after_run = run_eval_case(requirements_case, store, ws)
    assert "recent_renal_function" not in after_run.structured_output["missing_required_items"]
    assert before_run.representation_snapshot_id != after_run.representation_snapshot_id
    # The evaluation framework itself never mutated clinical/workflow state.
    assert store.list_referrals(ws, patient_id="patient-t2dm-003") == []
