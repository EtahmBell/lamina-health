from backend.models import CandidateReason, ClinicalRepresentation, PhysicianProfile


def generate_candidates(
    context: ClinicalRepresentation,
    physicians: list[PhysicianProfile],
    pcp_guidance: str | None = None,
) -> list[CandidateReason]:
    """Generate a deliberately broad, inspectable demo slate; ranking happens later."""
    candidates: list[CandidateReason] = []
    for physician in physicians:
        overlap = sorted(set(context.signals) & set(physician.accepts_signals))
        reasons = [f"Practice signal overlap: {signal.replace('_', ' ')}" for signal in overlap]
        if physician.specialty == "Nephrology" and context.progressive_renal_dysfunction:
            reasons.insert(0, "Progressive renal dysfunction makes nephrology directly relevant")
        if "Cardiology" in physician.specialty and context.resistant_hypertension:
            reasons.append("Resistant hypertension warrants comparison with cardiology pathways")
        if physician.specialty == "Cardiac Electrophysiology":
            reasons.append("Included to test specialty-boundary rejection; no rhythm signal is present")
        if pcp_guidance:
            specialty = physician.specialty.casefold()
            if any(word in pcp_guidance.casefold() for word in specialty.split()):
                reasons.append("Matches optional PCP guidance")
        candidates.append(CandidateReason(physician_id=physician.id, reasons=reasons or ["Boundary comparison candidate"]))
    return candidates

