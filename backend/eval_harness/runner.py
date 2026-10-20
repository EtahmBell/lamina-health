"""Evaluation execution (Part M/N).

Runs the SAME deterministic production logic the product itself uses --
never a parallel "fake eval agent". Zero side effects: nothing here ever
creates a referral, mutates a patient record, creates an appointment,
updates physician representation, sends a handoff, writes a coordination
event, trains the agent, or alters network state. Every workflow_store
call in this module is a read.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from backend.agents import build_candidate_routes, build_care_routing, evaluate_physician
from backend.clinical import build_patient_context
from backend.engagement import (
    EDITABLE_PERSONAS,
    PERSONA_BY_PHYSICIAN_ID,
    project_practice_representation,
    project_professional_profile,
)
from backend.models import (
    AssertionKind,
    EvalAssertionResult,
    EvalFitLabel,
    EvalModality,
    EvalRunStatus,
    EvalScope,
    EvalTaskType,
    PhysicianAgentEvalCase,
    PhysicianAgentEvalRun,
    PhysicianAgentEvalSuiteResult,
)
from backend.network_chat import answer_general_practice_question
from backend.referrals import assemble_initial_packet, evaluate_requirements, requirements_for, resolve_missing_requirement
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import WorkflowStore

from .cases import EVAL_CASES_BY_PHYSICIAN
from .representation import representation_snapshot_id
from .synthetic_patient import build_synthetic_patient

_MODEL_IDENTIFIER = "deterministic_fixture_v1"

_PHYSICIANS_BY_ID = {profile.id: profile for profile in ALL_PHYSICIANS}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _assertion(
    assertion_type: str, expected: object, actual: object, passed: bool,
    evidence: list[str] | None = None, kind: AssertionKind = AssertionKind.DETERMINISTIC,
) -> EvalAssertionResult:
    return EvalAssertionResult(
        assertion_type=assertion_type, expected=str(expected), actual=str(actual),
        passed=passed, evidence=evidence or [], kind=kind,
    )


def _fit_label(evaluation) -> EvalFitLabel:
    if evaluation.clinical_fit.value == "strong":
        return EvalFitLabel.STRONG
    if evaluation.clinical_fit.value == "moderate":
        return EvalFitLabel.MODERATE
    return EvalFitLabel.WEAK if evaluation.accepts_case else EvalFitLabel.REDIRECT


def _scope(evaluation) -> EvalScope:
    return EvalScope.IN_SCOPE if evaluation.accepts_case else EvalScope.OUT_OF_SCOPE


def _run_fit_or_scope(case: PhysicianAgentEvalCase):
    profile = _PHYSICIANS_BY_ID[case.physician_id]
    patient = build_synthetic_patient(case.id, case.synthetic_case_context)
    context = build_patient_context(patient)
    evaluation = evaluate_physician(patient, context, profile)
    fit = _fit_label(evaluation)
    scope = _scope(evaluation)
    rule_evidence = [item.detail for item in evaluation.evidence if item.kind.value == "explicit_physician_rule"]
    rule_id = f"{case.physician_id}:{context.case_family}:explicit_rule"
    expected = case.expected_behavior
    assertions: list[EvalAssertionResult] = []
    if expected.fit is not None:
        assertions.append(_assertion("fit", expected.fit.value, fit.value, fit == expected.fit, evidence=rule_evidence))
    if expected.expected_scope is not None:
        assertions.append(_assertion("scope", expected.expected_scope.value, scope.value, scope == expected.expected_scope, evidence=rule_evidence, kind=AssertionKind.MODEL_BEHAVIOR))
    if expected.must_reference_rule_ids:
        grounded = bool(rule_evidence)
        assertions.append(_assertion("grounding", ", ".join(expected.must_reference_rule_ids), rule_id if grounded else "ungrounded", grounded, evidence=rule_evidence))
    if case.prohibited_behavior.must_not_invent_physician_preference:
        # The reason text is a fixed, code-authored string for this exact
        # (physician_id, case_family) branch -- it can only ever be grounded
        # in the real explicit rule or absent/generic, never a fabricated
        # physician-specific preference invented for this one synthetic case.
        unsupported = bool(evaluation.accepts_case) and not rule_evidence and fit != EvalFitLabel.REDIRECT
        assertions.append(_assertion("must_not_invent_physician_preference", "no unsupported claim", "unsupported claim" if unsupported else "grounded or redirected", not unsupported))
    structured_output = {
        "fit": fit.value, "accepts_case": evaluation.accepts_case, "reason": evaluation.reason, "scope": scope.value,
    }
    return structured_output, assertions


def _run_requirements(case: PhysicianAgentEvalCase):
    patient = build_synthetic_patient(case.id, case.synthetic_case_context)
    context = build_patient_context(patient)
    referring_agent_id = "eval-harness-pcp-agent"
    packet = assemble_initial_packet(patient, context, referring_agent_id)
    requirements = requirements_for(case.physician_id, context.case_family)
    initial_checks = evaluate_requirements(requirements, packet)
    missing_before = {check.key for check in initial_checks if check.status.value != "satisfied" and check.required}
    resolved_keys: list[str] = []
    fabricated = False
    for requirement in requirements:
        if requirement.key not in missing_before:
            continue
        found = resolve_missing_requirement(patient, requirement, referring_agent_id)
        if found is not None:
            packet.items.append(found)
            resolved_keys.append(requirement.key)
    final_checks = evaluate_requirements(requirements, packet)
    still_missing = sorted(check.key for check in final_checks if check.status.value == "missing_from_packet" and check.required)
    ready = len(still_missing) == 0
    expected = case.expected_behavior
    expected_missing = sorted(expected.expected_required_items)
    assertions = [
        _assertion(
            "required_items", ", ".join(expected_missing) or "none", ", ".join(still_missing) or "none",
            expected_missing == still_missing,
            evidence=[f"{case.physician_id}:{context.case_family} receiving requirements"],
        ),
    ]
    if not expected.allow_unknown:
        expected_ready = len(expected_missing) == 0
        assertions.append(_assertion("referral_ready", expected_ready, ready, expected_ready == ready))
    if case.prohibited_behavior.must_not_claim_unconfirmed_requirement:
        # resolve_missing_requirement must never fabricate a result for a
        # requirement this synthetic patient genuinely has no chart data
        # for (see its own "Never fabricates a result" guarantee).
        attempted_fabrication = any(
            resolve_missing_requirement(patient, requirement, referring_agent_id) is not None
            for requirement in requirements
            if requirement.key in expected_missing
        )
        assertions.append(_assertion("must_not_claim_unconfirmed_requirement", "no fabricated value", "fabricated" if attempted_fabrication else "none fabricated", not attempted_fabrication))
    structured_output = {"missing_required_items": still_missing, "ready": ready, "resolved_automatically": resolved_keys}
    return structured_output, assertions


def _run_modality(case: PhysicianAgentEvalCase):
    patient = build_synthetic_patient(case.id, case.synthetic_case_context)
    context = build_patient_context(patient)
    routing = build_care_routing(context)
    expected = case.expected_behavior
    assertions: list[EvalAssertionResult] = []
    actual_modality = EvalModality.UNKNOWN
    econsult_suitability = None
    if routing is not None:
        actual_modality = EvalModality.IN_PERSON if routing.recommended_modality == "in_person" else EvalModality.ECONSULT
        econsult_suitability = routing.econsult_suitability
    if expected.expected_modality is not None:
        assertions.append(_assertion("modality", expected.expected_modality.value, actual_modality.value, actual_modality == expected.expected_modality, evidence=[f"{case.physician_id} care-routing assessment"]))
    routes = build_candidate_routes(context)
    chen_econsult = next((route for route in routes if route.physician_id == case.physician_id and route.modality == "econsult"), None)
    assertions.append(_assertion("econsult_alternative_recognized", True, chen_econsult is not None, chen_econsult is not None))
    structured_output = {"recommended_modality": actual_modality.value, "econsult_suitability": econsult_suitability}
    return structured_output, assertions


def _run_answer_practice_question(case: PhysicianAgentEvalCase, workflow_store: WorkflowStore, workspace_id: str):
    persona_id = PERSONA_BY_PHYSICIAN_ID.get(case.physician_id, case.physician_id)
    editable = persona_id in EDITABLE_PERSONAS
    overlays = workflow_store.profile_items(workspace_id, persona_id) if editable else []
    interest_overlays = workflow_store.physician_interests(workspace_id, persona_id) if editable else []
    profile = project_professional_profile(persona_id, overlays, interest_overlays)
    questions: list = []
    learnings = workflow_store.proposed_learnings(workspace_id, persona_id) if editable else []
    representation = project_practice_representation(persona_id, questions, learnings, profile)
    physician_name = _PHYSICIANS_BY_ID[case.physician_id].name.replace(" (synthetic)", "").replace("Dr. ", "")
    question = case.synthetic_case_context.practice_question or ""
    answer, based_on, unconfirmed = answer_general_practice_question(representation["sections"], physician_name, question)
    expected = case.expected_behavior
    assertions = []
    if expected.expect_abstain:
        assertions.append(_assertion("abstention", True, unconfirmed, unconfirmed, evidence=[answer]))
        assertions.append(_assertion("grounding", "none (abstained)", ", ".join(based_on) or "none", len(based_on) == 0, evidence=[answer]))
    structured_output = {"answer": answer, "based_on": based_on, "unconfirmed": unconfirmed}
    return structured_output, assertions


def run_eval_case(case: PhysicianAgentEvalCase, workflow_store: WorkflowStore, workspace_id: str) -> PhysicianAgentEvalRun:
    """Pure/read-only: builds a throwaway synthetic patient/representation
    snapshot, runs it through the real production functions, and returns a
    result -- never writes anything (Part N)."""
    started_at = _now()
    snapshot_id = representation_snapshot_id(workflow_store, workspace_id, PERSONA_BY_PHYSICIAN_ID.get(case.physician_id, case.physician_id))
    try:
        if case.task_type in (EvalTaskType.EVALUATE_FIT, EvalTaskType.EVALUATE_SCOPE):
            structured_output, assertions = _run_fit_or_scope(case)
        elif case.task_type == EvalTaskType.EVALUATE_REQUIREMENTS:
            structured_output, assertions = _run_requirements(case)
        elif case.task_type == EvalTaskType.EVALUATE_MODALITY:
            structured_output, assertions = _run_modality(case)
        elif case.task_type == EvalTaskType.ANSWER_PRACTICE_QUESTION:
            structured_output, assertions = _run_answer_practice_question(case, workflow_store, workspace_id)
        else:
            structured_output, assertions = {}, []
        status = EvalRunStatus.PASS if all(item.passed for item in assertions) else EvalRunStatus.FAIL
        return PhysicianAgentEvalRun(
            id=f"eval-run-{uuid4().hex[:10]}",
            eval_case_id=case.id,
            physician_id=case.physician_id,
            representation_snapshot_id=snapshot_id,
            model_identifier=_MODEL_IDENTIFIER,
            started_at=started_at,
            completed_at=_now(),
            structured_output=structured_output,
            assertion_results=assertions,
            status=status,
        )
    except Exception as error:  # noqa: BLE001 -- an eval ERROR must never propagate as a 500
        return PhysicianAgentEvalRun(
            id=f"eval-run-{uuid4().hex[:10]}",
            eval_case_id=case.id,
            physician_id=case.physician_id,
            representation_snapshot_id=snapshot_id,
            model_identifier=_MODEL_IDENTIFIER,
            started_at=started_at,
            completed_at=_now(),
            structured_output={},
            assertion_results=[],
            status=EvalRunStatus.ERROR,
            error_message=str(error),
        )


def _metrics(runs: list[PhysicianAgentEvalRun]) -> dict[str, float]:
    """Part R: interpretable dimensions, never one aggregate score."""
    all_assertions = [item for run in runs for item in run.assertion_results]
    grounding = [item for item in all_assertions if item.assertion_type == "grounding"]
    abstention = [item for item in all_assertions if item.assertion_type == "abstention"]
    prohibited = [item for item in all_assertions if item.assertion_type.startswith("must_not_")]
    scope = [item for item in all_assertions if item.assertion_type == "scope"]

    def rate(items: list[EvalAssertionResult]) -> float:
        return round(sum(1 for item in items if item.passed) / len(items), 3) if items else 1.0

    return {
        "overall_assertion_pass_rate": rate(all_assertions),
        "grounding_correctness": rate(grounding),
        "correct_abstention": rate(abstention),
        "prohibited_action_violations": float(sum(1 for item in prohibited if not item.passed)),
        "scope_accuracy": rate(scope),
        "errored_runs": float(sum(1 for run in runs if run.status == EvalRunStatus.ERROR)),
    }


def run_eval_suite(physician_id: str, workflow_store: WorkflowStore, workspace_id: str) -> PhysicianAgentEvalSuiteResult:
    cases = EVAL_CASES_BY_PHYSICIAN.get(physician_id, [])
    enabled_cases = [case for case in cases if case.enabled]
    runs = [run_eval_case(case, workflow_store, workspace_id) for case in enabled_cases]
    snapshot_id = representation_snapshot_id(workflow_store, workspace_id, PERSONA_BY_PHYSICIAN_ID.get(physician_id, physician_id))
    return PhysicianAgentEvalSuiteResult(
        physician_id=physician_id,
        representation_snapshot_id=snapshot_id,
        cases=enabled_cases,
        runs=runs,
        metrics=_metrics(runs),
    )
