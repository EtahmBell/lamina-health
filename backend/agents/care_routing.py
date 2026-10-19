"""Care routing / match explainability (care-routing demo pass).

Lightly exposes the specialty-care routing architecture for the demo:
Lamina decides the appropriate CARE NEED (specialty, modality, priority)
*before* merely ranking doctors, and shows that access/wait time and
network-participation evidence-confidence materially factor into (without
numerically scoring) the eventual recommendation.

Deliberately deterministic, additive, and narrow for this pass (Part X: do
not regress the existing consult_network/referral flow) -- only Tonjit's
diabetes case gets a populated CareRoutingAssessment/candidate_routes for
now; every other patient/case continues to get `None`/`[]`, rendering
exactly as before this pass.
"""

from __future__ import annotations

from backend.models import (
    AccessProfile,
    CandidateRoute,
    CareRoutingAssessment,
    ClinicalRepresentation,
    NetworkParticipation,
)

# One shared structured source for modality-specific access (Part B/K) --
# in-person and e-consult are separate capacity channels, never one derived
# from the other. Reused by both candidate-route assembly below and the
# small physician capacity endpoint (`GET /api/physicians/{id}/capacity`).
PHYSICIAN_ACCESS_PROFILES: dict[str, AccessProfile] = {
    "physician-chen": AccessProfile(
        in_person_wait_days=10,
        in_person_wait_label="Approximately 10 days",
        econsult_available=True,
        econsult_response_days=2,
        econsult_response_label="Approximately 2 business days",
        access_confidence="high",
    ),
    "physician-ramanathan": AccessProfile(
        in_person_wait_days=7,
        in_person_wait_label="Approximately 6–8 days",
        econsult_available=True,
        econsult_response_days=2,
        econsult_response_label="Approximately 2 business days",
        access_confidence="medium",
    ),
}

_EXTERNAL_DIRECTORY_CANDIDATE = {
    "physician_id": "external-directory-endocrinology-1",
    "physician_name": "Dr. Renata Okafor (external directory, synthetic)",
}


def build_care_routing(context: ClinicalRepresentation) -> CareRoutingAssessment | None:
    """The CARE NEED, decided before any physician is ranked (Part A/C).
    `None` for any case family this demo pass doesn't populate -- never a
    guessed/fabricated routing assessment for a case this pass doesn't cover."""
    if not context.progressive_glycemic_control:
        return None
    return CareRoutingAssessment(
        specialty="Endocrinology",
        recommended_modality="in_person",
        suggested_priority="soon",
        in_person_need="preferred",
        econsult_suitability="possible_not_preferred",
        rationale=(
            "Persistent worsening type 2 diabetes despite medication escalation makes direct "
            "Endocrinology evaluation appropriate."
        ),
    )


def build_candidate_routes(context: ClinicalRepresentation) -> list[CandidateRoute]:
    """physician + modality + expected access = ROUTE (Part A). Only
    assembled alongside a real CareRoutingAssessment (see above) -- empty
    for any case this pass doesn't cover."""
    if not context.progressive_glycemic_control:
        return []
    chen_access = PHYSICIAN_ACCESS_PROFILES["physician-chen"]
    maya_access = PHYSICIAN_ACCESS_PROFILES["physician-ramanathan"]
    return [
        CandidateRoute(
            physician_id="physician-chen",
            physician_name="Dr. Noah Chen",
            specialty="Endocrinology",
            modality="in_person",
            fit_label="strong",
            evidence_confidence="high",
            network_participation=NetworkParticipation.INTEGRATED_NETWORK,
            access=chen_access,
            recommended=True,
            rationale=(
                "Direct evaluation is preferred, Dr. Chen has the strongest practice fit, and his "
                "current in-person access remains within an acceptable window."
            ),
        ),
        CandidateRoute(
            physician_id="physician-chen",
            physician_name="Dr. Noah Chen",
            specialty="Endocrinology",
            modality="econsult",
            fit_label="strong",
            evidence_confidence="high",
            network_participation=NetworkParticipation.INTEGRATED_NETWORK,
            access=chen_access,
            recommended=False,
            rationale="Considered, but direct in-person evaluation is preferred for this presentation.",
        ),
        CandidateRoute(
            physician_id="physician-ramanathan",
            physician_name="Dr. Maya Ramanathan",
            specialty="Endocrinology",
            modality="in_person",
            fit_label="strong",
            evidence_confidence="medium",
            network_participation=NetworkParticipation.LAMINA_PHYSICIAN,
            access=maya_access,
            recommended=False,
            rationale=(
                "A strong alternative with shorter in-person access, though with a less "
                "institutionally integrated connection than Dr. Chen."
            ),
        ),
        CandidateRoute(
            physician_id=_EXTERNAL_DIRECTORY_CANDIDATE["physician_id"],
            physician_name=_EXTERNAL_DIRECTORY_CANDIDATE["physician_name"],
            specialty="Endocrinology",
            modality="in_person",
            fit_label="potential",
            evidence_confidence="unverified",
            network_participation=NetworkParticipation.EXTERNAL_DIRECTORY,
            access=AccessProfile(
                in_person_wait_days=None,
                in_person_wait_label="Unverified",
                econsult_available=None,
                econsult_response_days=None,
                econsult_response_label=None,
                access_confidence="unverified",
            ),
            recommended=False,
            # Part I: intentionally no rationale -- this agent never evaluated
            # Tonjit, so there is nothing real to say.
            rationale=None,
        ),
    ]
