from backend.models import (
    CandidateReason,
    ClinicalRepresentation,
    PhysicianCaseRules,
    PhysicianProfile,
)
from backend.synthetic_data import resolve_case_rules


def generate_candidates(
    context: ClinicalRepresentation,
    physicians: list[PhysicianProfile],
    pcp_guidance: str | None = None,
    case_rules_overrides: dict[str, PhysicianCaseRules] | None = None,
) -> list[CandidateReason]:
    """Generate a deliberately broad, inspectable demo slate; ranking happens
    later. `case_rules_overrides` (NLP referral-preference pass, Part J) is
    keyed by physician_id -- each physician's own CONFIRMED persisted
    referral preference, if any; looked up by the caller, never here."""
    candidates: list[CandidateReason] = []
    overrides = case_rules_overrides or {}
    for physician in physicians:
        accepts_signals = resolve_case_rules(
            physician, context, overrides.get(physician.id)
        ).accepts_signals
        overlap = sorted(set(context.signals) & set(accepts_signals))
        reasons = [f"Practice signal overlap: {signal.replace('_', ' ')}" for signal in overlap]
        if physician.specialty == "Nephrology" and context.progressive_renal_dysfunction:
            reasons.insert(0, "Progressive renal dysfunction makes nephrology directly relevant")
        if "Cardiology" in physician.specialty and context.resistant_hypertension:
            reasons.append("Resistant hypertension warrants comparison with cardiology pathways")
        if physician.specialty == "Cardiac Electrophysiology":
            reasons.append(
                "Included to test specialty-boundary rejection; no rhythm signal is present"
            )
        if (
            physician.specialty == "Gastroenterology"
            and context.prior_endoscopy_documented is False
        ):
            reasons.insert(0, "Persistent iron deficiency requires initial GI source evaluation")
        if physician.specialty == "Haematology" and context.persistent_iron_deficiency_anemia:
            reasons.append("Haematology remains relevant for refractory deficiency or IV iron")
        if physician.specialty == "Colorectal Surgery":
            reasons.append("Included to confirm diagnostic evaluation should precede surgery")
        if physician.specialty == "Endocrinology" and context.progressive_glycemic_control:
            reasons.insert(0, "Worsening glycemic control despite medication escalation makes endocrinology directly relevant")
        if pcp_guidance:
            specialty = physician.specialty.casefold()
            if any(word in pcp_guidance.casefold() for word in specialty.split()):
                reasons.append("Matches optional PCP guidance")
        candidates.append(
            CandidateReason(
                physician_id=physician.id, reasons=reasons or ["Boundary comparison candidate"]
            )
        )
    return candidates
