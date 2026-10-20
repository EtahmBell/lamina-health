"""Small, foundational physician-agent evaluation harness (pre-NLP pass).

NOT a generic LLM benchmark platform. The one question this answers: does
a physician's reconstructed agent behave consistently with that
physician's CONFIRMED Lamina representation on a previously unseen,
synthetic case? Every evaluation runs the SAME deterministic production
logic the product itself uses (backend.agents.evaluate_physician,
backend.agents.build_care_routing, backend.referrals.requirements_for/
resolve_missing_requirement, backend.network_chat.
answer_general_practice_question) against a throwaway, in-memory synthetic
PatientRecord -- never a parallel evaluation-only reimplementation, never
real patient data, and never a write to live workflow/clinical state.
"""

from .cases import CHEN_EVAL_CASES, EVAL_CASES_BY_PHYSICIAN
from .representation import representation_snapshot_id
from .runner import run_eval_case, run_eval_suite

__all__ = [
    "CHEN_EVAL_CASES",
    "EVAL_CASES_BY_PHYSICIAN",
    "representation_snapshot_id",
    "run_eval_case",
    "run_eval_suite",
]
