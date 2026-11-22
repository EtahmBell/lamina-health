"""Structured triage rationale.

Each rationale line is stored as a `code` plus `params` (rule, version, matched and missing
items, ...) alongside the physician-worded `statement` kept for older readers. Display text is
rendered from the structured parts for whoever is reading (`Voice`), so staff see "Dr. X's rule"
without any rewriting of stored sentences. Recommendations stored before this existed have no
`code`; their `statement` is shown as written and flagged as such.
"""

from __future__ import annotations

from typing import Any

from .voice import PHYSICIAN, Voice

POLICY_TEXT = {"accept": "a type you see", "out_of_scope": "out of scope", "case_by_case": "case by case"}
POLICY_TEXT_STAFF = {"accept": "a type the practice sees", "out_of_scope": "out of scope", "case_by_case": "case by case"}


def _q(text: str) -> str:
    return f"“{text}”"


def render(code: str, params: dict[str, Any], voice: Voice = PHYSICIAN) -> str:
    v, p = voice, params
    t = p.get("referral_type", "")
    if code == "type_matched":
        how = (f" through its alias {_q(p['alias'])}." if p.get("alias")
               else " (same words after normalizing plurals and punctuation).")
        return f"Submitted as {_q(p['submitted'])}; matched {v.whose} {_q(p['rule_type'])} rule{how}"
    if code == "type_unconfirmed":
        options = ", ".join(_q(name) for name in p.get("options") or [])
        return (f"{_q(p['submitted'])} doesn’t exactly match one of {v.whose} referral types"
                + (f" (possible: {options})" if options else "")
                + ". I didn’t apply a rule — confirm the referral type so the right criteria are used.")
    if code == "no_rule":
        return (f"No confirmed practice rule covers {_q(t)}, so fit and required information cannot be "
                "assessed automatically.")
    if code == "outside_partial":
        return (f"Partly matches {v.whose} outside-scope criterion {_q(p['phrase'])} "
                f"(found: {', '.join(p['matched'])}; not found: {', '.join(p['missing'])}). "
                "A physician should check whether it applies.")
    if code == "scope_layer_conflict":
        own = "your own statement" if v.physician else f"{v.doctor}’s own statement"
        policy = POLICY_TEXT if v.physician else POLICY_TEXT_STAFF
        return (f"{'Your practice' if v.physician else 'The practice'} marks {_q(t)} as {policy[p['practice_policy']]}, "
                f"but {own} says {policy[p['physician_policy']]}. I didn’t choose between them — review the conflict in "
                f"{v.whose} representation.")
    if code == "out_of_scope":
        return f"{v.subject} marked {_q(t)} referrals as out of scope."
    if code == "outside_match":
        return f"Referral text matches {v.whose} outside-scope criterion {_q(p['phrase'])} (matched: {', '.join(p['matched'])})."
    if code == "case_by_case":
        return f"{v.subject} {v.verb('decide', 'decides')} {_q(t)} referrals case by case, so this one is for {v.object}."
    if code == "fit_match":
        return f"Referral text matches {v.whose} fit criterion {_q(p['phrase'])} (matched: {', '.join(p['matched'])})."
    if code == "type_accepted":
        return f"{v.subject} {v.verb('see', 'sees')} {_q(t)} referrals, and nothing in it matches an outside-scope criterion."
    if code == "no_fit_match":
        return (f"{v.whose_cap} rule for {_q(t)} applies, but the referral text does not clearly match any stated fit "
                "or outside-scope criterion.")
    if code == "loosening_conflict":
        self_word = "yourself" if v.physician else "themselves"
        return (f"{v.subject} marked {_q(p['item'])} as optional for {self_word}, but it is a practice requirement "
                "and the practice doesn’t allow loosening it, so it is still required.")
    if code == "requirement_open":
        return f"{p['label']}: {p['detail']}." + ("" if p.get("required", True) else " (helpful, not required)")
    if code == "requirements_complete":
        return f"Every required item in {v.whose} rule is present and recent enough."
    if code == "requirements_none":
        return f"{v.whose_cap} rule for {_q(t)} lists no required items, so completeness wasn’t checked."
    if code == "urgency_match":
        return f"Matches {v.whose} urgency signal {_q(p['phrase'])}."
    if code == "sender_priority":
        return f"The referring clinician marked this {p['priority']}."
    if code == "default_modality":
        return f"{v.whose_cap} rule sets the default modality to {p['modality'].replace('_', '-')}."
    raise KeyError(f"unknown rationale code: {code}")


def rationale_view(item: dict, voice: Voice) -> dict:
    """One stored rationale item (JSON) with display `text` for this reader."""
    code = item.get("code")
    if code:
        return {**item, "text": render(code, item.get("params") or {}, voice), "worded_for_physician": False}
    # Stored before structured rationale: shown exactly as written (worded for the physician).
    return {**item, "text": item["statement"], "worded_for_physician": not voice.physician}
