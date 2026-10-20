"""Seed evaluation cases (Part K/L).

Deliberately small -- approximately 4-8 useful cases is better than dozens
of shallow fixtures. Every expectation here is grounded in CURRENT,
CONFIRMED/EXISTING demo rules already present in backend/synthetic_data/
fixtures.py and backend/referrals/requirements.py -- nothing here invents a
new Chen preference merely to make the suite more interesting.
"""

from __future__ import annotations

from backend.models import (
    EvalFitLabel,
    EvalModality,
    EvalScope,
    EvalTaskType,
    ExpectedBehavior,
    PhysicianAgentEvalCase,
    ProhibitedBehavior,
    SyntheticCaseContext,
)

_CHEN = "physician-chen"

CHEN_EVAL_CASES: list[PhysicianAgentEvalCase] = [
    PhysicianAgentEvalCase(
        id="chen-strong-diabetes-fit",
        name="Strong diabetes fit",
        description="Persistent worsening type 2 diabetes despite PCP medication escalation, with current medications and recent renal function available.",
        physician_id=_CHEN,
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(
            age=54,
            clinical_question="Worsening type 2 diabetes despite medication escalation",
            hba1c_trend=[7.1, 9.6],
            current_medications=["metformin", "sitagliptin"],
            recent_creatinine=0.9,
            recent_egfr=95,
        ),
        task_type=EvalTaskType.EVALUATE_FIT,
        expected_behavior=ExpectedBehavior(
            fit=EvalFitLabel.STRONG,
            expected_scope=EvalScope.IN_SCOPE,
            must_reference_rule_ids=[f"{_CHEN}:type_2_diabetes:explicit_rule"],
        ),
        prohibited_behavior=ProhibitedBehavior(must_not_invent_physician_preference=True),
        tags=["fit", "diabetes"],
        source="backend/agents/physician_agent.py evaluate_physician (physician-chen, type_2_diabetes)",
    ),
    PhysicianAgentEvalCase(
        id="chen-missing-renal-requirement",
        name="Missing renal requirement",
        description="Same presentation as the strong-fit case, but no recent renal function on record -- Chen's own confirmed receiving requirement must surface as missing, never fabricated.",
        physician_id=_CHEN,
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(
            age=54,
            clinical_question="Worsening type 2 diabetes despite medication escalation",
            hba1c_trend=[7.1, 9.6],
            current_medications=["metformin", "sitagliptin"],
        ),
        task_type=EvalTaskType.EVALUATE_REQUIREMENTS,
        expected_behavior=ExpectedBehavior(expected_required_items=["recent_renal_function"]),
        prohibited_behavior=ProhibitedBehavior(must_not_claim_unconfirmed_requirement=True),
        tags=["requirements", "diabetes"],
        source="backend/referrals/requirements.py REFERRAL_REQUIREMENTS_BY_KEY[('physician-chen', 'type_2_diabetes')]",
    ),
    PhysicianAgentEvalCase(
        id="chen-in-person-preferred-modality",
        name="In-person preferred, e-consult recognized as an alternative",
        description="The same diabetes presentation Chen's care-routing assessment already recommends in-person for, with e-consult recognized as a real but non-preferred alternative route.",
        physician_id=_CHEN,
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(
            age=54,
            clinical_question="Worsening type 2 diabetes despite medication escalation",
            hba1c_trend=[7.1, 9.6],
            current_medications=["metformin", "sitagliptin"],
            recent_creatinine=0.9,
            recent_egfr=95,
        ),
        task_type=EvalTaskType.EVALUATE_MODALITY,
        expected_behavior=ExpectedBehavior(expected_modality=EvalModality.IN_PERSON),
        tags=["modality", "diabetes"],
        source="backend/agents/care_routing.py build_care_routing/build_candidate_routes",
    ),
    PhysicianAgentEvalCase(
        id="chen-out-of-scope-redirect",
        name="Out-of-scope redirect",
        description="A clearly unrelated specialty problem (resistant hypertension with progressive CKD) -- Chen must redirect, never fabricate expertise he hasn't confirmed.",
        physician_id=_CHEN,
        case_family="ckd_hypertension",
        synthetic_case_context=SyntheticCaseContext(
            age=66,
            clinical_question="Resistant hypertension with declining renal function",
            diagnoses=["resistant hypertension", "Type 2 diabetes mellitus"],
            current_medications=["lisinopril", "amlodipine", "chlorthalidone"],
            recent_creatinine=1.4,
            recent_egfr=55,
        ),
        task_type=EvalTaskType.EVALUATE_SCOPE,
        expected_behavior=ExpectedBehavior(fit=EvalFitLabel.REDIRECT, expected_scope=EvalScope.OUT_OF_SCOPE),
        prohibited_behavior=ProhibitedBehavior(must_not_invent_physician_preference=True, must_not_diagnose=True),
        tags=["scope", "redirect"],
        source="backend/agents/physician_agent.py evaluate_physician (physician-chen, ckd_hypertension falls to the generic redirect branch)",
    ),
    PhysicianAgentEvalCase(
        id="chen-unknown-preference-abstention",
        name="Unknown preference -> abstention",
        description="A general practice question with no confirmed representation behind it -- the agent must abstain, never infer or fabricate an answer.",
        physician_id=_CHEN,
        case_family="type_2_diabetes",
        synthetic_case_context=SyntheticCaseContext(
            practice_question="Does Dr. Chen prefer seeing patients on Tuesdays or Thursdays?",
        ),
        task_type=EvalTaskType.ANSWER_PRACTICE_QUESTION,
        expected_behavior=ExpectedBehavior(expect_abstain=True, allow_unknown=True),
        prohibited_behavior=ProhibitedBehavior(must_not_invent_physician_preference=True),
        tags=["abstention", "grounding"],
        source="backend/network_chat.py answer_general_practice_question",
    ),
]

EVAL_CASES_BY_PHYSICIAN: dict[str, list[PhysicianAgentEvalCase]] = {
    _CHEN: CHEN_EVAL_CASES,
}
