"""Evaluation visibility pass (Part A-G/W): the critical distinction
between deterministic REPRESENTATION/SYSTEM evaluation and genuinely
model-dependent AGENT BEHAVIOR evaluation, with execution mode and model
identity always recorded explicitly -- never implied."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace as demo_workspace_module
from backend.api import eval_harness as eval_harness_api
from backend.eval_harness import cases as cases_module
from backend.eval_harness import representation_snapshot_id, run_eval_case, run_eval_case_repeated, run_eval_suite
from backend.eval_harness import runner as runner_module
from backend.main import app
from backend.models import EvalCategory, EvalRunStatus, ExecutionMode
from backend.professional_services import AgentChatService, ResponsesApiClient
from backend.workflow import WorkflowStore
from tests._chen_demo_fixture import teach_and_confirm_chen_baseline

WS = "eval-visibility-test-workspace"


@pytest.fixture
def store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> WorkflowStore:
    value = WorkflowStore(tmp_path / "workflow.sqlite")
    monkeypatch.setattr(eval_harness_api, "workflow_store", value)
    monkeypatch.setattr(demo_workspace_module, "workflow_store", value)
    # Force the deterministic fallback path for every agent-behavior case
    # unless a test explicitly injects its own fake model client.
    monkeypatch.setattr(runner_module, "agent_chat_service", AgentChatService(ResponsesApiClient(enabled=False)))
    # The eval harness itself never seeds (Part G: zero side effects) --
    # teach+confirm Chen's baseline here, once, exactly the way a physician
    # actually would (demo-coherence causality fix: no product-level
    # auto-migration does this anymore), so these tests exercise the
    # realistic "Chen has a confirmed referral preference" state the
    # harness is actually meant to evaluate against.
    teach_and_confirm_chen_baseline(value, WS)
    return value


class _FakeResponses:
    def __init__(self, payload: dict):
        self.payload = payload

    def create(self, **kwargs):
        return SimpleNamespace(output_text=json.dumps(self.payload))


def _fake_model_client(payload: dict) -> ResponsesApiClient:
    sdk = SimpleNamespace(responses=_FakeResponses(payload))
    return ResponsesApiClient(sdk, enabled=True, model="test-model-v1")


def _case(case_id: str):
    return next(item for item in cases_module.EVAL_CASES_BY_PHYSICIAN["physician-chen"] if item.id == case_id)


# -------------------------------------------- Part C: representation vs agent category


def test_representation_system_cases_are_categorized_correctly() -> None:
    for case in cases_module.CHEN_EVAL_CASES:
        assert case.eval_category == EvalCategory.REPRESENTATION_SYSTEM


def test_agent_behavior_cases_are_categorized_correctly() -> None:
    assert len(cases_module.CHEN_AGENT_BEHAVIOR_CASES) >= 3
    for case in cases_module.CHEN_AGENT_BEHAVIOR_CASES:
        assert case.eval_category == EvalCategory.AGENT_BEHAVIOR


# -------------------------------------------- Part D/W.4/W.5/W.6: execution mode is explicit


def test_a_representation_system_eval_is_always_labelled_deterministic_fallback_with_no_model_id(
    store: WorkflowStore,
) -> None:
    case = _case("chen-strong-diabetes-fit")
    run = run_eval_case(case, store, WS)
    assert run.execution_mode == ExecutionMode.DETERMINISTIC_FALLBACK
    assert run.model_id is None


def test_an_agent_behavior_eval_is_labelled_deterministic_fallback_when_no_model_is_configured(
    store: WorkflowStore,
) -> None:
    case = _case("chen-agent-grounded-workup-question")
    run = run_eval_case(case, store, WS)
    assert run.execution_mode == ExecutionMode.DETERMINISTIC_FALLBACK
    assert run.model_id is None
    assert "a1c" in run.structured_output["answer"].casefold()


def test_an_agent_behavior_eval_is_labelled_model_only_when_a_real_model_call_actually_occurred(
    store: WorkflowStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    case = _case("chen-agent-grounded-workup-question")
    valid_payload = {
        "answer": "Dr. Chen wants a recent HbA1c, current medications, and recent renal function.",
        "evidence_summary": ["confirmed practice representation"],
        "based_on": ["confirmed practice representation"],
        "coverage": "confirmed_representation",
        "uncertainty": None,
        "can_train_from_this": False,
    }
    monkeypatch.setattr(
        runner_module, "agent_chat_service", AgentChatService(_fake_model_client(valid_payload))
    )
    run = run_eval_case(case, store, WS)
    assert run.execution_mode == ExecutionMode.MODEL
    assert run.model_id == "test-model-v1"


def test_deterministic_fallback_is_never_presented_as_a_model_pass(
    store: WorkflowStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An invalid/malformed model response must fall back -- and the run
    must say so, never silently claim a model-backed pass."""
    case = _case("chen-agent-grounded-workup-question")
    invalid_payload = {"not_a_valid_schema_field": True}
    monkeypatch.setattr(
        runner_module, "agent_chat_service", AgentChatService(_fake_model_client(invalid_payload))
    )
    run = run_eval_case(case, store, WS)
    assert run.execution_mode == ExecutionMode.DETERMINISTIC_FALLBACK
    assert run.model_id is None


# -------------------------------------------- Part E: unknown preference abstains


def test_unknown_preference_model_eval_abstains(store: WorkflowStore) -> None:
    case = _case("chen-agent-unknown-day-preference")
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.PASS
    assert run.structured_output["coverage"] == "uncertain"


def test_unsupported_physician_claim_fails_grounding(store: WorkflowStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """A model response that confidently answers an out-of-scope question
    with no real grounding must fail the must_not_invent_physician_preference
    assertion -- this is what "fails grounding" means in this harness."""
    case = _case("chen-agent-unsupported-scope")
    fabricated_payload = {
        "answer": "Yes, Dr. Chen is a recognized expert in multiple sclerosis.",
        "evidence_summary": [],
        "based_on": [],
        "coverage": "represented",
        "uncertainty": None,
        "can_train_from_this": False,
    }
    monkeypatch.setattr(
        runner_module, "agent_chat_service", AgentChatService(_fake_model_client(fabricated_payload))
    )
    run = run_eval_case(case, store, WS)
    assert run.status == EvalRunStatus.FAIL
    violation = next(item for item in run.assertion_results if item.assertion_type == "must_not_invent_physician_preference")
    assert violation.passed is False


# -------------------------------------------- Part W.9: prose variation does not fail structure


def test_prose_variation_in_the_deterministic_answer_does_not_fail_the_structural_assertion(
    store: WorkflowStore,
) -> None:
    case = _case("chen-agent-grounded-workup-question")
    run_a = run_eval_case(case, store, WS)
    run_b = run_eval_case(case, store, WS)
    assert run_a.status == run_b.status == EvalRunStatus.PASS
    # The underlying prose need not be byte-identical for the structural
    # assertion to pass both times -- only the grounded/abstained structure matters.
    assert run_a.assertion_results[0].passed and run_b.assertion_results[0].passed


# -------------------------------------------- Part F/W.10: repeated runs


def test_repeated_runs_preserve_case_identity_and_record_iteration(store: WorkflowStore) -> None:
    case = _case("chen-agent-grounded-workup-question")
    runs = run_eval_case_repeated(case, store, WS, 5)
    assert len(runs) == 5
    assert [run.iteration for run in runs] == [1, 2, 3, 4, 5]
    assert all(run.eval_case_id == case.id for run in runs)
    assert all(run.status == EvalRunStatus.PASS for run in runs)


def test_the_repeated_run_api_endpoint_is_bounded_and_scoped_to_one_case(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/workspace/eval/physicians/physician-chen/cases/chen-agent-grounded-workup-question/run",
            params={"times": 999},
        )
    assert response.status_code == 200
    runs = response.json()
    assert len(runs) <= 10  # bounded, never an unbounded repeat count
    assert all(run["eval_case_id"] == "chen-agent-grounded-workup-question" for run in runs)


def test_repeated_run_endpoint_404s_for_an_unknown_case(store: WorkflowStore) -> None:
    with TestClient(app) as client:
        response = client.post("/api/workspace/eval/physicians/physician-chen/cases/not-a-real-case/run")
    assert response.status_code == 404


# -------------------------------------------- Part W.11: no hidden chain-of-thought


def test_no_hidden_chain_of_thought_is_ever_stored_or_returned(store: WorkflowStore) -> None:
    case = _case("chen-agent-grounded-workup-question")
    run = run_eval_case(case, store, WS)
    blob = run.model_dump_json().casefold()
    for forbidden in ("chain_of_thought", "reasoning_trace", "scratchpad", "internal_monologue"):
        assert forbidden not in blob


# -------------------------------------------- Part G/W.2: zero side effects


def test_agent_behavior_evaluation_never_mutates_live_workflow_state(store: WorkflowStore) -> None:
    before_referrals = store.list_referrals(WS)
    before_learnings = store.proposed_learnings(WS, "chen")
    run_eval_suite("physician-chen", store, WS)
    assert store.list_referrals(WS) == before_referrals
    assert store.proposed_learnings(WS, "chen") == before_learnings


def test_the_representation_snapshot_is_recorded_on_every_run_regardless_of_category(store: WorkflowStore) -> None:
    expected_snapshot = representation_snapshot_id(store, WS, "chen")
    suite = run_eval_suite("physician-chen", store, WS)
    for run in suite.runs:
        assert run.representation_snapshot_id == expected_snapshot
