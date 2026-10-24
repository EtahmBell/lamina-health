"""Physician-case fit: the second of Lamina's three routing computations
(routing consolidation pass, Part B2).

    1. Patient need       -- what care does this patient need?
    2. Physician-case fit -- for whom is this actually a good case?   <- here
    3. Route fit          -- which viable physician + modality + access
                             route is best right now?

Fit is two-sided. `clinical_fit` asks patient -> physician (specialty and
scope). `receiving_fit` asks physician -> patient: does this physician's
explicit representation, and their actual history with similar patients,
say this case belongs in their practice? Access and capacity never enter
here -- a busy physician keeps exactly the same fit; route fit is where
access lowers utility (Part B3).

Similar-patient history is a first-class signal, read only from
privacy-preserving case PATTERNS (HistoricalCase): structured kinds of
cases, never prior patients. Nothing here can emit a prior patient's
name, identifier, or a count of cases -- only pattern labels. When no
history exists, the evidence says so instead of inventing any.
"""

from __future__ import annotations

from backend.models import (
    ClinicalRepresentation,
    HistoricalCase,
    MatchEvidence,
    PhysicianCaseFit,
    PhysicianCaseRules,
    PhysicianProfile,
)
from backend.models.consultation import EconsultPolicy, ReceivingFit

# The signals that define what a case family's referral is actually about
# -- ancillary documentation signals (e.g. "renal_function_documented")
# never decide fit. Extend this dict for a future case family.
PRIMARY_SIGNALS: dict[str, frozenset[str]] = {
    "type_2_diabetes": frozenset({"type_2_diabetes", "progressive_glycemic_control"}),
    "ckd_hypertension": frozenset({"progressive_renal_dysfunction", "resistant_hypertension"}),
    "iron_deficiency_anemia": frozenset({"persistent_iron_deficiency_anemia"}),
}

PRACTICE_HISTORY_SOURCE = "Practice history · privacy-preserving case patterns (synthetic)"


def short_physician_name(name: str) -> str:
    """"Dr. Noah Chen (synthetic)" -> "Dr. Chen"."""
    clean = name.replace("(synthetic)", "").strip()
    return f"Dr. {clean.split()[-1]}" if clean else clean


def comparable_case_patterns(
    context: ClinicalRepresentation, patterns: list[HistoricalCase]
) -> list[HistoricalCase]:
    """Patterns whose every feature is present in this case -- a pattern
    that merely shares the diagnosis (e.g. a focused medication question
    vs. worsening disease despite escalation) is not comparable."""
    signals = set(context.signals)
    return [pattern for pattern in patterns if pattern.features and set(pattern.features) <= signals]


def interest_matches_case_text(interest: str, case_text: str, case_family: str) -> bool:
    """Supporting evidence only when the case shares something specific
    with the interest. The case family's own words ("diabetes" for a
    type_2_diabetes case) are true of every case in that family, so on
    their own they are not a match -- unless the interest is nothing BUT
    the family (e.g. "Type 2 diabetes"), which then matches the family."""
    interest_words = {word for word in interest.casefold().replace("-", " ").split() if len(word) > 3}
    family_words = {word for word in case_family.casefold().split("_") if len(word) > 3} | {"diabetic", "cases", "patients"}
    specific = interest_words - family_words
    words = specific or interest_words
    return bool(words) and any(word in case_text.casefold() for word in words)


def _case_matches_interest(context: ClinicalRepresentation, interest: str) -> bool:
    case_text = f"{context.summary} {' '.join(context.facts)} {' '.join(context.signals)}"
    return interest_matches_case_text(interest, case_text, context.case_family)


def _econsult_policy_summary(short_name: str, policy: EconsultPolicy) -> str:
    return {
        "acceptable": f"{short_name} accepts e-consult for this presentation.",
        "possible_not_preferred": f"{short_name} prefers in-person evaluation for this presentation; e-consult remains possible.",
        "unknown": f"{short_name}'s e-consult policy for this presentation is not yet known.",
        "not_offered": f"{short_name} does not offer e-consult for this presentation.",
    }[policy]


def assess_physician_case_fit(
    context: ClinicalRepresentation,
    need_specialty: str,
    profile: PhysicianProfile,
    case_rules: PhysicianCaseRules,
    *,
    preference_confirmed: bool = False,
    case_interest_titles: list[str] | None = None,
    econsult_policy: EconsultPolicy = "unknown",
    econsult_policy_source: str | None = None,
) -> PhysicianCaseFit:
    """A pure function of its arguments. `case_rules` is whatever
    resolve_case_rules() already chose (confirmed preference > fixture
    override > profile); `preference_confirmed` only changes the stated
    provenance. Case interests add supporting evidence but never change
    either fit tier -- they are one signal among several, not a gate."""
    short_name = short_physician_name(profile.name)
    evidence: list[MatchEvidence] = []

    specialty_match = profile.specialty == need_specialty
    scope = profile.focus_areas[0] if profile.focus_areas else profile.subspecialty
    if specialty_match:
        clinical_fit = "strong"
        evidence.append(MatchEvidence(
            category="specialty_scope",
            summary=f"{profile.specialty} / {scope}",
            source="Physician profile · specialty and practice focus",
        ))
    else:
        clinical_fit = "poor"
        evidence.append(MatchEvidence(
            category="specialty_scope",
            summary=f"{profile.specialty} is not the specialty this patient needs ({need_specialty}).",
            source="Physician profile · specialty",
        ))

    case_signals = set(context.signals) & PRIMARY_SIGNALS.get(context.case_family, frozenset())
    explicit_accept = bool(case_signals) and case_signals <= set(case_rules.accepts_signals)
    if explicit_accept:
        evidence.append(MatchEvidence(
            category="referral_preference",
            summary=f"This presentation matches cases {short_name}'s representation identifies as appropriate for the practice.",
            source="Confirmed referral preference" if preference_confirmed else "Explicit practice rule (synthetic practice footprint)",
        ))

    comparable = comparable_case_patterns(context, case_rules.historical_cases)
    if comparable:
        evidence.append(MatchEvidence(
            category="similar_case_experience",
            summary=(
                f"{short_name}'s practice history includes comparable patients: "
                + "; ".join(pattern.label[0].lower() + pattern.label[1:] for pattern in comparable)
                + ". A fit signal, not a quality measure."
            ),
            source=PRACTICE_HISTORY_SOURCE,
        ))
    else:
        evidence.append(MatchEvidence(
            category="similar_case_experience",
            summary="No similar-case history on record for this physician.",
            source=PRACTICE_HISTORY_SOURCE,
        ))

    for interest in case_interest_titles or []:
        if _case_matches_interest(context, interest):
            evidence.append(MatchEvidence(
                category="case_interest",
                summary=f"Matches a confirmed case interest ({interest}); supporting, not required.",
                source="Confirmed case interest",
            ))

    evidence.append(MatchEvidence(
        category="modality_policy",
        summary=_econsult_policy_summary(short_name, econsult_policy),
        source=econsult_policy_source or "No confirmed modality guidance yet",
    ))

    receiving_fit: ReceivingFit
    if explicit_accept and comparable:
        receiving_fit = "strong"
    elif explicit_accept or comparable:
        receiving_fit = "moderate"
    else:
        receiving_fit = "unknown"

    return PhysicianCaseFit(
        physician_id=profile.id,
        physician_name=profile.name.replace("(synthetic)", "").strip(),
        clinical_fit=clinical_fit,
        receiving_fit=receiving_fit,
        similar_case_patterns=[pattern.label for pattern in comparable],
        econsult_policy=econsult_policy,
        evidence=evidence,
    )
