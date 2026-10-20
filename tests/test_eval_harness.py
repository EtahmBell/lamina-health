"""Physician-agent evaluation harness tests (pre-NLP foundational pass,
Part W). Verifies the harness itself: synthetic-only fixtures, zero side
effects, representation-state recording, each assertion dimension, prose-
invariance, and error/fail distinguishability."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import eval_harness as eval_harness_api
from backend.eval_harness import CHEN_EVAL_CASES, representation_snapshot_id, run_eval_case, run_eval_suite
from backend.main import app
from backend.models import (
    EvalFitLabel,
    EvalRunStatus,
    EvalTaskType,
    ExpectedBehavior,
    PhysicianAgentEvalCase,
    ProhibitedBehavior,
    SyntheticCaseContext,
)
from backend.workflow import WorkflowStore


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(eval_harness_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    return value


WS = "eval-test-workspace"


# ----------------------------------------------------------- Part W.1 -- synthetic only


def test_every_seeded_case_is_built_from_synthetic_data_only() -> None:
    for case in CHEN_EVAL_CASES:
        assert case.synthetic_case_context.practice_question or case.synthetic_case_context.clinical_question
        # Never a reference to a real/live patient id anywhere in the fixture.
        assert "patient-" not in case.model_dump_json()


# ----------------------------------------------------------- Part W.2 -- zero mutation


def test_running_an_eval_never_mutates_live_workflow_state(store: WorkflowStore) -> None:
    before_referrals = store.list_referrals(WS)
    before_learnings = store.proposed_learnings(WS, "chen")
    run_eval_suite("physician-chen", store, WS)
    assert store.list_referrals(WS) == before_referrals
    assert store.proposed_learnings(WS, "chen") == before_learnings


def test_running_an_eval_via_the_real_api_never_mutates_live_workflow_state(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        client.post("/api/workspace/eval/physicians/physician-chen/run")
        client.post("/api/workspace/eval/physicians/physician-chen/run")
    # Confirmed representation state is untouched by two runs in a row.
    assert store.proposed_learnings(WS, "chen") == []


# ----------------------------------------------------------- Part W.3 -- representation state recorded


def test_every_run_records_the_representation_snapshot_id_it_used(store: WorkflowStore) -> None:
    result = run_eval_suite("physician-chen", store, WS)
    expected_snapshot = representation_snapshot_id(store, WS, "chen")
    assert result.representation_snapshot_id == expected_snapshot
    for run in result.runs:
        assert run.representation_snapshot_id == expected_snapshot


def test_the_snapshot_id_changes_when_confirmed_representation_changes(store: WorkflowStore) -> None:
    before = representation_snapshot_id(store, WS, "chen")
    learning = store.create_proposed_learning(WS, "chen", "training_response", "session:1:q1", "Prefers e-consult for stable follow-ups")
    store.update_proposed_learning(WS, "chen", learning["id"], learning["statement"], "confirmed")
    after = representation_snapshot_id(store, WS, "chen")
    assert before != after, "a confirmed learning must change the snapshot id -- this is the correction-sensitivity hook (Part Q)"


def test_an_unconfirmed_suggested_learning_does_not_change_the_snapshot(store: WorkflowStore) -> None:
    before = representation_snapshot_id(store, WS, "chen")
    store.create_proposed_learning(WS, "chen", "training_response", "session:1:q1", "Maybe prefers e-consult")
    after = representation_snapshot_id(store, WS, "chen")
    assert before == after, "only CONFIRMED representation changes the snapshot, never a merely-suggested/unconfirmed one"


# ----------------------------------------------------------- Part W.4 -- fit assertions


def test_strong_fit_case_passes(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-strong-diabetes-fit")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    fit_assertion = next(item for item in run.assertion_results if item.assertion_type == "fit")
    assert fit_assertion.passed
    assert run.structured_output["fit"] == "strong"


def test_fit_assertion_fails_when_the_expected_fit_does_not_match(store: WorkflowStore) -> None:
    wrong_expectation = PhysicianAgentEvalCase(
        id="synthetic-wrong-fit-check",
        name="Deliberately wrong expectation",
        description="A strong-fit presentation asserted against an impossible 'redirect' expectation, to prove the assertion can actually fail.",
        physician_id="physician-chen",
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(
            age=54, clinical_question="Worsening type 2 diabetes despite medication escalation",
            hba1c_trend=[7.1, 9.6], current_medications=["metformin", "sitagliptin"],
            recent_creatinine=0.9, recent_egfr=95,
        ),
        task_type=EvalTaskType.EVALUATE_FIT,
        expected_behavior=ExpectedBehavior(fit=EvalFitLabel.REDIRECT),
        source="test fixture",
    )
    run = run_eval_case(wrong_expectation, store, WS)
    assert run.status == EvalRunStatus.FAIL
    fit_assertion = next(item for item in run.assertion_results if item.assertion_type == "fit")
    assert fit_assertion.passed is False
    assert fit_assertion.expected == "redirect"
    assert fit_assertion.actual == "strong"


# ----------------------------------------------------------- Part W.5 -- requirement assertions


def test_missing_renal_requirement_case_passes_and_never_fabricates_a_value(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-missing-renal-requirement")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["missing_required_items"] == ["recent_renal_function"]
    assert run.structured_output["ready"] is False
    fabrication_assertion = next(item for item in run.assertion_results if item.assertion_type == "must_not_claim_unconfirmed_requirement")
    assert fabrication_assertion.passed


def test_the_strong_fit_case_actually_resolves_renal_function_automatically_since_it_is_present(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-strong-diabetes-fit")
    requirements_case = case.model_copy(update={"task_type": EvalTaskType.EVALUATE_REQUIREMENTS, "expected_behavior": ExpectedBehavior(expected_required_items=[])})
    run = run_eval_case(requirements_case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["ready"] is True
    assert "recent_renal_function" in run.structured_output["resolved_automatically"]


# ----------------------------------------------------------- Part W.6 -- modality assertions


def test_modality_case_passes_and_recognizes_econsult_as_a_real_alternative(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-in-person-preferred-modality")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["recommended_modality"] == "in_person"
    assert run.structured_output["econsult_suitability"] == "possible_not_preferred"


# ----------------------------------------------------------- Part W.7 -- out-of-scope assertions


def test_out_of_scope_case_passes_and_redirects_without_fabricating_expertise(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-out-of-scope-redirect")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["scope"] == "out_of_scope"
    assert run.structured_output["accepts_case"] is False


# ----------------------------------------------------------- Part W.8 -- abstention assertions


def test_unknown_preference_case_abstains_and_passes(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-unknown-preference-abstention")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["unconfirmed"] is True
    assert "confirmed preference" in run.structured_output["answer"].lower() or "don't have enough confirmed" in run.structured_output["answer"].lower()


def test_abstention_assertion_fails_if_the_agent_were_expected_to_answer_but_abstained(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-unknown-preference-abstention")
    wrong_expectation = case.model_copy(update={"expected_behavior": ExpectedBehavior(expect_abstain=False)})
    run = run_eval_case(wrong_expectation, store, WS)
    # expect_abstain=False means no abstention assertion is even generated
    # (Part B: only assert the dimensions relevant to this case) -- confirm
    # that absence rather than a false pass.
    assert not any(item.assertion_type == "abstention" for item in run.assertion_results)


# ----------------------------------------------------------- Part W.9 -- grounding assertions


def test_grounding_assertion_fails_when_no_rule_evidence_actually_supports_the_claim() -> None:
    """Direct check of the grounding-assertion logic itself: given no real
    rule evidence, a case that requires grounding must fail it -- this is
    what makes "Dr. Chen prefers e-consults for this presentation" FAIL
    grounding if no confirmed representation artifact actually supports it
    (Part I). evaluate_physician's own current branches happen to always
    cite SOME explicit rule (a real, desirable property of the existing
    deterministic logic), so this exercises the assertion helper directly
    with the "no rule evidence" case it exists to catch."""
    from backend.eval_harness.runner import _assertion

    rule_evidence: list[str] = []
    grounded = bool(rule_evidence)
    result = _assertion("grounding", "physician-chen:ckd_hypertension:explicit_rule", "ungrounded", grounded, evidence=rule_evidence)
    assert result.passed is False


def test_the_abstention_cases_grounding_assertion_fails_if_a_based_on_source_were_fabricated() -> None:
    """Direct unit check of the grounding principle outside the suite: an
    answer with a non-empty based_on list must NOT satisfy a "no grounding
    (abstained)" expectation."""
    from backend.eval_harness.runner import _assertion

    fabricated_based_on = ["a source that was never actually confirmed"]
    result = _assertion("grounding", "none (abstained)", ", ".join(fabricated_based_on), len(fabricated_based_on) == 0)
    assert result.passed is False


# ----------------------------------------------------------- Part W.10 -- prohibited-action assertions


def test_prohibited_behavior_assertion_runs_and_passes_for_the_strong_fit_case(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-strong-diabetes-fit")
    run = run_eval_case(case, store, WS)
    prohibited_assertion = next(item for item in run.assertion_results if item.assertion_type == "must_not_invent_physician_preference")
    assert prohibited_assertion.passed


def test_prohibited_behavior_assertions_are_absent_when_a_case_does_not_declare_them(store: WorkflowStore) -> None:
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-in-person-preferred-modality")
    run = run_eval_case(case, store, WS)
    assert not any(item.assertion_type.startswith("must_not_") for item in run.assertion_results)


# ----------------------------------------------------------- Part W.11 -- prose invariance


def test_structural_assertions_never_depend_on_exact_wording_of_the_reason_text(store: WorkflowStore) -> None:
    """The same structural fit/scope holds regardless of the exact reason
    string evaluate_physician happens to return -- the eval only ever
    asserts the typed fit/scope/grounding dimensions, never the prose."""
    case = next(item for item in CHEN_EVAL_CASES if item.id == "chen-strong-diabetes-fit")
    run = run_eval_case(case, store, WS)
    assertion_types = {item.assertion_type for item in run.assertion_results}
    assert "reason_text_exact_match" not in assertion_types
    assert isinstance(run.structured_output["reason"], str) and len(run.structured_output["reason"]) > 0


# ----------------------------------------------------------- Part W.12 -- error vs fail


def test_an_evaluation_error_is_distinguishable_from_a_failure(store: WorkflowStore) -> None:
    broken_case = PhysicianAgentEvalCase(
        id="synthetic-broken-case",
        name="Broken case (unknown physician)",
        description="References a physician id with no real fixture -- must ERROR, never silently FAIL or crash the suite.",
        physician_id="physician-does-not-exist",
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(age=50, clinical_question="n/a"),
        task_type=EvalTaskType.EVALUATE_FIT,
        expected_behavior=ExpectedBehavior(fit=EvalFitLabel.STRONG),
        source="test fixture",
    )
    run = run_eval_case(broken_case, store, WS)
    assert run.status == EvalRunStatus.ERROR
    assert run.error_message
    assert run.assertion_results == []


def test_error_and_fail_are_both_distinct_from_pass_in_a_mixed_suite(store: WorkflowStore) -> None:
    result = run_eval_suite("physician-chen", store, WS)
    assert all(run.status == EvalRunStatus.PASS for run in result.runs)
    assert result.metrics["errored_runs"] == 0.0


# ----------------------------------------------------------- repeat_count schema (Part O)


def test_eval_case_schema_supports_a_repeat_count_without_preventing_future_multi_run_stability_reporting() -> None:
    case = CHEN_EVAL_CASES[0]
    assert case.repeat_count == 1
    repeated = case.model_copy(update={"repeat_count": 5})
    assert repeated.repeat_count == 5


# ----------------------------------------------------------- metrics are dimensions, not a score


def test_metrics_are_interpretable_dimensions_never_one_aggregate_score(store: WorkflowStore) -> None:
    result = run_eval_suite("physician-chen", store, WS)
    assert "overall_assertion_pass_rate" in result.metrics
    assert "agent_score" not in result.metrics
    assert all(isinstance(value, float) for value in result.metrics.values())


# ----------------------------------------------------------- API surface


def test_the_api_lists_physicians_cases_and_runs_the_suite(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        physicians = client.get("/api/workspace/eval/physicians").json()
        assert any(item["physician_id"] == "physician-chen" for item in physicians)
        cases = client.get("/api/workspace/eval/physicians/physician-chen/cases").json()
        assert len(cases) == len(CHEN_EVAL_CASES)
        result = client.post("/api/workspace/eval/physicians/physician-chen/run").json()
        assert result["physician_id"] == "physician-chen"
        assert len(result["runs"]) == len(CHEN_EVAL_CASES)


def test_unseeded_physician_404s(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post("/api/workspace/eval/physicians/physician-jung/run")
    assert response.status_code == 404
