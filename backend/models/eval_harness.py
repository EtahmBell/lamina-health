"""Physician-agent evaluation harness schema (pre-NLP foundational pass).

The product question this exists to answer: "If the physician has
explicitly taught Lamina X, does their reconstructed agent actually behave
according to X on a previously unseen case?" This is deliberately NOT a
generic LLM benchmark platform -- every assertion is a structural/typed
check (fit, required items, modality, scope, grounding, abstention), never
exact-prose matching. See backend/eval_harness/ for the runner and seed
cases that populate this schema.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from .consultation import StrictModel


class EvalCategory(StrEnum):
    """Evaluation visibility pass, Part C: the critical distinction between
    testing deterministic/structured PRODUCT behavior (resolve_case_rules,
    requirements_for, build_care_routing, representation snapshots, draft-
    vs-confirmed semantics) and testing whether a genuinely model-backed
    agent execution can correctly APPLY a representation to a novel
    scenario. A deterministic function call is never labeled as an "LLM
    eval" just because its task_type happens to resemble one."""

    REPRESENTATION_SYSTEM = "representation_system"
    AGENT_BEHAVIOR = "agent_behavior"


class ExecutionMode(StrEnum):
    """Evaluation visibility pass, Part D: every model-dependent result
    must say, explicitly, whether a model actually ran or the deterministic
    fallback did -- never implied, never silently defaulted. A
    representation/system eval is always DETERMINISTIC_FALLBACK (no model
    call is ever attempted for those task types)."""

    MODEL = "model"
    DETERMINISTIC_FALLBACK = "deterministic_fallback"


class EvalTaskType(StrEnum):
    """Deliberately small -- one task type per existing production decision
    point this harness can exercise. Never grown into a generic benchmark
    taxonomy."""

    EVALUATE_FIT = "evaluate_fit"
    EVALUATE_REQUIREMENTS = "evaluate_requirements"
    EVALUATE_MODALITY = "evaluate_modality"
    EVALUATE_SCOPE = "evaluate_scope"
    ANSWER_PRACTICE_QUESTION = "answer_practice_question"
    APPLY_CONFIRMED_PREFERENCE = "apply_confirmed_preference"


class EvalFitLabel(StrEnum):
    STRONG = "strong"
    MODERATE = "moderate"
    WEAK = "weak"
    REDIRECT = "redirect"
    UNKNOWN = "unknown"


class EvalModality(StrEnum):
    IN_PERSON = "in_person"
    ECONSULT = "econsult"
    EITHER = "either"
    UNKNOWN = "unknown"


class EvalScope(StrEnum):
    IN_SCOPE = "in_scope"
    OUT_OF_SCOPE = "out_of_scope"
    UNKNOWN = "unknown"


class ProhibitedBehavior(StrictModel):
    """Typed MUST-NOT assertions (Part F) -- prefer these over arbitrary
    free-text prohibitions wherever a structural check is practical."""

    must_not_diagnose: bool = False
    must_not_invent_physician_preference: bool = False
    must_not_invent_patient_fact: bool = False
    must_not_claim_unconfirmed_requirement: bool = False
    must_not_accept_referral_on_physicians_behalf: bool = False
    must_not_escalate_urgency_autonomously: bool = False


class ExpectedBehavior(StrictModel):
    """Structural behavioral constraints only -- never expected prose
    (Part B/P). Every field is optional; a case only asserts the
    dimensions relevant to its own task_type."""

    fit: EvalFitLabel | None = None
    expected_required_items: list[str] = Field(default_factory=list)
    expected_modality: EvalModality | None = None
    expected_scope: EvalScope | None = None
    must_reference_rule_ids: list[str] = Field(default_factory=list)
    must_abstain_on: list[str] = Field(default_factory=list)
    allow_unknown: bool = False
    expect_abstain: bool = False


class SyntheticCaseContext(StrictModel):
    """Deliberately minimal and synthetic-only (Part D) -- never a real
    patient id, never coupled to the live Tonjit demo's own persisted
    workflow state. Shaped to build a throwaway, in-memory PatientRecord
    (backend.models.PatientRecord) that the SAME production
    build_patient_context()/evaluate_physician()/build_care_routing() pure
    functions can run against -- no parallel evaluation-only logic."""

    # Optional: an answer_practice_question case has no synthetic patient at
    # all, only a practice_question below.
    age: int | None = None
    clinical_question: str = ""
    diagnoses: list[str] = Field(default_factory=list)
    hba1c_trend: list[float] = Field(default_factory=list)
    current_medications: list[str] = Field(default_factory=list)
    fasting_glucose_trend: list[float] = Field(default_factory=list)
    recent_creatinine: float | None = None
    recent_egfr: float | None = None
    # For answer_practice_question cases only -- a general, non-patient
    # question asked of the physician's own confirmed representation.
    practice_question: str | None = None


class PhysicianAgentEvalCase(StrictModel):
    id: str
    name: str
    description: str
    physician_id: str
    case_family: str
    synthetic_case_context: SyntheticCaseContext
    task_type: EvalTaskType
    # Evaluation visibility pass, Part C: which of the two categories this
    # case belongs to -- set once, at authoring time, never inferred from
    # runtime behavior.
    eval_category: EvalCategory = EvalCategory.REPRESENTATION_SYSTEM
    expected_behavior: ExpectedBehavior
    prohibited_behavior: ProhibitedBehavior = Field(default_factory=ProhibitedBehavior)
    tags: list[str] = Field(default_factory=list)
    source: str
    enabled: bool = True
    # Part O: repeated-run support -- the schema must not prevent running a
    # case N times later, even though this pass only ever runs it once
    # (everything here is deterministic today, so repeats would be
    # identical; this field exists so a future model-dependent task_type
    # doesn't require a schema change).
    repeat_count: int = 1


class AssertionKind(StrEnum):
    """Part V: distinguishes "this followed necessarily from the confirmed
    rule/data" from "the agent had to correctly recognize this applies" --
    useful for reasoning about nondeterminism once a task_type actually
    becomes model-dependent. Everything in this initial pass is
    DETERMINISTIC (see Part A's audit: no task_type here currently invokes
    an LLM)."""

    DETERMINISTIC = "deterministic"
    MODEL_BEHAVIOR = "model_behavior"


class EvalAssertionResult(StrictModel):
    assertion_type: str
    expected: str
    actual: str
    passed: bool
    evidence: list[str] = Field(default_factory=list)
    kind: AssertionKind = AssertionKind.DETERMINISTIC


class EvalRunStatus(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"
    PASS_WITH_VARIATION = "pass_with_variation"


class PhysicianAgentEvalRun(StrictModel):
    id: str
    eval_case_id: str
    physician_id: str
    # Part G: the smallest clean abstraction that lets a result say "this
    # was produced using THIS representation state" -- a deterministic
    # content hash over confirmed learnings/interests/profile overlays
    # (see backend/eval_harness/representation.py), not a full version-
    # management subsystem.
    representation_snapshot_id: str
    model_identifier: str
    # Evaluation visibility pass, Part D: explicit, never implied. A
    # representation/system eval is always DETERMINISTIC_FALLBACK with
    # model_id=None -- no model is ever invoked for those task types, so
    # there is nothing to "fall back" from; this just records the honest
    # fact that no model execution occurred.
    execution_mode: ExecutionMode = ExecutionMode.DETERMINISTIC_FALLBACK
    model_id: str | None = None
    iteration: int = 1
    started_at: str
    completed_at: str
    structured_output: dict[str, Any] = Field(default_factory=dict)
    assertion_results: list[EvalAssertionResult] = Field(default_factory=list)
    status: EvalRunStatus
    error_message: str | None = None


class PhysicianAgentEvalSuiteResult(StrictModel):
    """One physician's whole eval suite, run once -- read-only/response-only,
    never persisted (Part N: zero side effects)."""

    physician_id: str
    representation_snapshot_id: str
    cases: list[PhysicianAgentEvalCase]
    runs: list[PhysicianAgentEvalRun]
    # Part R: interpretable dimensions, never one aggregate score.
    metrics: dict[str, float]
