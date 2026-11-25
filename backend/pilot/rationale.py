"""Structured triage rationale.

Each rationale line is stored as a `code` plus `params` (rule, version, matched and missing
items, ...) alongside the physician-worded `statement` kept for older readers. Display text is
rendered from the structured parts for whoever is reading (`Voice`), so staff see "Dr. X's rule"
without any rewriting of stored sentences. Recommendations stored before this existed have no
`code`; their `statement` is shown as written and flagged as such.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .voice import PHYSICIAN, Voice


@dataclass(frozen=True)
class RuleRef:
    """How one rule is named for one reader (run 3).

    Practice layer: "the practice’s rule (confirmed by Dr. X, v5)" for everyone.
    Physician layer: "your rule (v2)" for its owner, "Dr. Y’s rule (v2)" for anyone else."""

    phrase: str  # "the practice’s Thyroid nodule rule (confirmed by Dr. X, v5)"
    subject: str  # "The practice" / "You" / "Dr. Y"
    second_person: bool = False

    @property
    def cap(self) -> str:
        return self.phrase[:1].upper() + self.phrase[1:]

    def verb(self, second: str, third: str) -> str:
        return second if self.second_person else third

    @classmethod
    def build(cls, *, layer: str, referral_type: str, version: int, mine: bool, owner_name: str | None,
              confirmed_by_name: str | None) -> RuleRef:
        if layer == "physician":
            if mine:
                return cls(f"your {referral_type} rule (v{version})", "You", second_person=True)
            owner = owner_name or "another physician"
            return cls(f"{owner}’s {referral_type} rule (v{version})", owner)
        confirmed = f"confirmed by {confirmed_by_name}, " if confirmed_by_name else ""
        return cls(f"the practice’s {referral_type} rule ({confirmed}v{version})", "The practice")

POLICY_TEXT = {"accept": "a type you see", "out_of_scope": "out of scope", "case_by_case": "case by case"}
POLICY_TEXT_STAFF = {"accept": "a type the practice sees", "out_of_scope": "out of scope", "case_by_case": "case by case"}


def _q(text: str) -> str:
    return f"“{text}”"


def _render_with_rule(code: str, p: dict[str, Any], r: RuleRef) -> str | None:
    """Wording that names the rule by layer and author for this reader; None = not a rule line."""
    t = p.get("referral_type", "")
    if code == "type_matched":
        how = (f" through its alias {_q(p['alias'])}." if p.get("alias")
               else " (same words after normalizing plurals and punctuation).")
        return f"Submitted as {_q(p['submitted'])}; matched {r.phrase}{how}"
    if code == "outside_partial":
        return (f"Partly matches the outside-scope criterion {_q(p['phrase'])} in {r.phrase} "
                f"(found: {', '.join(p['matched'])}; not found: {', '.join(p['missing'])}). "
                "A physician should check whether it applies.")
    if code == "out_of_scope":
        return f"{r.subject} {r.verb('mark', 'marks')} {_q(t)} referrals as out of scope — {r.phrase}."
    if code == "outside_match":
        return (f"Referral text matches the outside-scope criterion {_q(p['phrase'])} in {r.phrase} "
                f"(matched: {', '.join(p['matched'])}).")
    if code == "fit_match":
        return f"Referral text matches the fit criterion {_q(p['phrase'])} in {r.phrase} (matched: {', '.join(p['matched'])})."
    if code == "type_accepted":
        return f"{r.subject} {r.verb('see', 'sees')} {_q(t)} referrals ({r.phrase}), and nothing in it matches an outside-scope criterion."
    if code == "no_fit_match":
        return f"{r.cap} applies, but the referral text does not clearly match any stated fit or outside-scope criterion."
    if code == "requirements_complete":
        return f"Every required item in {r.phrase} is present and recent enough."
    if code == "requirements_none":
        return f"{r.cap} lists no required items, so completeness wasn’t checked."
    if code == "urgency_match":
        return f"Matches the urgency signal {_q(p['phrase'])} in {r.phrase}."
    if code == "default_modality":
        return f"{r.cap} sets the default modality to {p['modality'].replace('_', '-')}."
    return None


def render(code: str, params: dict[str, Any], voice: Voice = PHYSICIAN, rule: RuleRef | None = None) -> str:
    """Display text for one rationale line. With `rule` (the reader's naming of the rule the line
    cites) rule lines say whose rule it is and its version; without it, the stored wording."""
    if rule is not None:
        text = _render_with_rule(code, params, rule)
        if text is not None:
            return text
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


def rationale_view(item: dict, voice: Voice, rules: dict[str, RuleRef] | None = None) -> dict:
    """One stored rationale item (JSON) with display `text` for this reader. `rules` maps a rule id
    to how this reader names it (layer, owner/confirmer, version)."""
    code = item.get("code")
    if code:
        rule = (rules or {}).get((item.get("source") or {}).get("rule_id") or "")
        return {**item, "text": render(code, item.get("params") or {}, voice, rule), "worded_for_physician": False}
    # Stored before structured rationale: shown exactly as written (worded for the physician).
    return {**item, "text": item["statement"], "worded_for_physician": not voice.physician}
