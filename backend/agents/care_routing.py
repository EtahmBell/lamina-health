"""Care routing: Lamina's three routing computations, kept distinct
(care-routing demo pass; routing consolidation pass, Part B-H).

    1. PATIENT NEED (`patient_need`) -- what care does this patient need?
       Specialty, clinician-confirmable priority, and which modalities are
       CLINICALLY viable. Reads only the patient; never a physician's
       preference, never access.
    2. PHYSICIAN-CASE FIT (`build_physician_fits`, backend/physicians/
       case_fit.py) -- for whom is this a good case? Two-sided: specialty/
       scope plus explicit representation and similar-patient history.
       Applies each physician's own modality policy. Never access.
    3. ROUTE FIT (`compare_routes`) -- among routes that pass the clinical
       and modality gates, which physician + modality + access route is
       best right now? Access lowers a route's utility; it never changes
       the physician's fit.

No numeric match value exists anywhere in this module: routes are
compared with an explicit, ordered tuple of structured facts.

Deliberately narrow: only Tonjit's diabetes case family has routed
physicians and access profiles today; every other case family gets
`None`/`[]`, rendering exactly as before.
"""

from __future__ import annotations

from backend.models import (
    AccessProfile,
    CandidateRoute,
    CareRoutingAssessment,
    ClinicalRepresentation,
    MatchEvidence,
    ModalityViability,
    NetworkParticipation,
    PhysicianCaseFit,
    PhysicianCaseRules,
)
from backend.models.consultation import CareModality, EconsultPolicy, ReferralPriority
from backend.physicians import assess_physician_case_fit, short_physician_name
from backend.synthetic_data import ALL_PHYSICIANS, resolve_case_rules

# One shared structured source for modality-specific access (Part B/K) --
# in-person and e-consult are separate capacity channels, never one derived
# from the other. Reused by both route comparison below and the small
# physician capacity endpoint (`GET /api/physicians/{id}/capacity`).
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

# Evidence-confidence/connectivity, never a quality tier (Part J).
PHYSICIAN_NETWORK: dict[str, tuple[NetworkParticipation, str]] = {
    "physician-chen": (NetworkParticipation.INTEGRATED_NETWORK, "high"),
    "physician-ramanathan": (NetworkParticipation.LAMINA_PHYSICIAN, "medium"),
}

_NETWORK_LABELS = {
    NetworkParticipation.INTEGRATED_NETWORK: "Integrated network: shared records and coordination",
    NetworkParticipation.LAMINA_PHYSICIAN: "Lamina physician: agent-to-agent coordination, less institutional integration",
    NetworkParticipation.EXTERNAL_DIRECTORY: "External directory listing: unverified",
}

# Which physicians' agents are routed for a case family. Extend this dict
# (plus an access profile) to route a future case family.
ROUTED_PHYSICIANS_BY_CASE_FAMILY: dict[str, list[str]] = {
    "type_2_diabetes": ["physician-chen", "physician-ramanathan"],
}

# Physician-specific e-consult policy for a case PATTERN, from the static
# synthetic representation -- what the agent already knows before any
# confirmed preference. Absent means genuinely unknown (Part P), never
# defaulted to acceptable.
DEFAULT_ECONSULT_POLICIES: dict[tuple[str, str], tuple[EconsultPolicy, str]] = {
    ("physician-chen", "progressive_glycemic_control"): (
        "possible_not_preferred",
        "Practice representation: in-person preferred when diabetes keeps worsening despite treatment escalation",
    ),
}

# Demo-safe, configurable windows for "is this route's access appropriate
# for the clinician-confirmed priority?" -- not clinical SLAs.
PRIORITY_ACCESS_TARGET_DAYS: dict[str, int] = {"urgent": 3, "soon": 14, "routine": 42}

_CLINICAL_ORDER = {"strong": 0, "moderate": 1, "poor": 2}
_RECEIVING_ORDER = {"strong": 0, "moderate": 1, "limited": 2, "unknown": 3}

_EXTERNAL_DIRECTORY_CANDIDATE = {
    "physician_id": "external-directory-endocrinology-1",
    # No "(external directory, synthetic)" suffix (bug-fix/UX pass, Part M)
    # -- that read like fixture/debug metadata; the global "Synthetic
    # demonstration only" disclaimer already covers demo provenance.
    "physician_name": "Dr. Renata Okafor",
}

_PROFILES_BY_ID = {profile.id: profile for profile in ALL_PHYSICIANS}


# ------------------------------------------------------------------ 1. patient need


def patient_need(context: ClinicalRepresentation) -> CareRoutingAssessment | None:
    """The patient-side facts only. `None` for any case family this demo
    doesn't route -- never a guessed assessment. Priority is protocol-
    grounded and remains a suggestion the referring clinician confirms; it
    is never promoted here."""
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
        modality_viability=ModalityViability(
            visit="viable",
            econsult="conditional",
            basis=(
                "Worsening control despite escalation usually warrants a broader specialist "
                "assessment; e-consult only where the receiving physician's policy supports it."
            ),
        ),
        priority_basis=(
            "Protocol-grounded: worsening glycemic control despite medication escalation. "
            "Confirmed or changed by the referring clinician."
        ),
        referral_question="Treatment intensification for worsening type 2 diabetes despite medication escalation.",
    )


# --------------------------------------------------------------- 2. physician fit


def resolve_econsult_policy(
    physician_id: str, context: ClinicalRepresentation, confirmed_modality: str | None = None
) -> tuple[EconsultPolicy, str | None]:
    """How THIS physician handles e-consult for this kind of case.
    `confirmed_modality` is the physician's own CONFIRMED preference (looked
    up by the caller). "either" keeps the in-person boundary for disease
    that keeps worsening despite escalation -- the same reading the agent's
    own chat applies -- and accepts e-consult otherwise."""
    worsening = context.progressive_glycemic_control
    if confirmed_modality == "econsult":
        return "acceptable", "Confirmed referral preference: e-consult suitable for this presentation"
    if confirmed_modality == "either":
        if worsening:
            return "possible_not_preferred", "Confirmed referral preference: in-person when worsening despite escalation"
        return "acceptable", "Confirmed referral preference: e-consult for focused questions"
    if confirmed_modality == "in_person":
        return "possible_not_preferred", "Confirmed referral preference: in-person preferred"
    if worsening and (physician_id, "progressive_glycemic_control") in DEFAULT_ECONSULT_POLICIES:
        return DEFAULT_ECONSULT_POLICIES[(physician_id, "progressive_glycemic_control")]
    return "unknown", None


def build_physician_fits(
    context: ClinicalRepresentation,
    confirmed_modality: str | None = None,
    case_rules_overrides: dict[str, PhysicianCaseRules] | None = None,
    case_interest_titles_by_physician: dict[str, list[str]] | None = None,
) -> list[PhysicianCaseFit]:
    """Physician-case fit for every routed physician of this case family.
    `confirmed_modality` is Dr. Chen's confirmed preference (the only
    receiving physician with a confirmable modality preference today)."""
    need = patient_need(context)
    if need is None:
        return []
    overrides = case_rules_overrides or {}
    interests = case_interest_titles_by_physician or {}
    fits = []
    for physician_id in ROUTED_PHYSICIANS_BY_CASE_FAMILY.get(context.case_family, []):
        profile = _PROFILES_BY_ID[physician_id]
        override = overrides.get(physician_id)
        policy, policy_source = resolve_econsult_policy(
            physician_id, context, confirmed_modality if physician_id == "physician-chen" else None
        )
        fits.append(assess_physician_case_fit(
            context,
            need.specialty,
            profile,
            resolve_case_rules(profile, context, override),
            preference_confirmed=override is not None,
            case_interest_titles=interests.get(physician_id),
            econsult_policy=policy,
            econsult_policy_source=policy_source,
        ))
    return fits


# ------------------------------------------------------------------ 3. route fit


def _route_access_days(route_modality: CareModality, access: AccessProfile) -> int | None:
    return access.in_person_wait_days if route_modality == "in_person" else access.econsult_response_days


def _econsult_listed(need: CareRoutingAssessment, fit: PhysicianCaseFit, access: AccessProfile) -> bool:
    """Hard gates: clinically viable for the patient, offered by this
    physician's policy, and a real e-consult capacity channel exists."""
    viability = need.modality_viability
    return bool(
        viability is not None
        and viability.econsult != "not_viable"
        and access.econsult_available
        and fit.econsult_policy in ("acceptable", "possible_not_preferred")
    )


def _econsult_appropriate(need: CareRoutingAssessment, fit: PhysicianCaseFit) -> bool:
    """E-consult is only ever recommended when clinically appropriate for
    the patient AND consistent with the physician's own policy -- never
    merely because it is faster or cheaper (Part F/G)."""
    viability = need.modality_viability
    return bool(viability is not None and viability.econsult != "not_viable" and fit.econsult_policy == "acceptable")


def _route_evidence(
    modality: CareModality, fit: PhysicianCaseFit, access: AccessProfile, network: NetworkParticipation,
    priority: ReferralPriority, within_target: bool | None,
) -> list[MatchEvidence]:
    short_name = short_physician_name(fit.physician_name)
    window = "within" if within_target else "outside"
    if modality == "in_person":
        modality_item = MatchEvidence(
            category="modality_policy",
            summary="In-person appropriate for this presentation.",
            source="Patient need · clinically viable modalities",
        )
        access_item = MatchEvidence(
            category="access_capacity",
            summary=f"Expected visit access {access.in_person_wait_label.replace('Approximately ', '~')} · {window} the {priority} window.",
            source="Visit capacity (synthetic access profile)",
        )
    else:
        modality_item = next(
            (item for item in fit.evidence if item.category == "modality_policy"),
            MatchEvidence(category="modality_policy", summary=f"{short_name}'s e-consult policy", source="Physician representation"),
        )
        access_item = MatchEvidence(
            category="access_capacity",
            summary=f"Typical e-consult response {(access.econsult_response_label or 'unverified').replace('Approximately ', '~')} · a separate capacity pool from visits.",
            source="E-consult capacity (synthetic access profile)",
        )
    return [
        modality_item,
        access_item,
        MatchEvidence(category="network_relationship", summary=_NETWORK_LABELS[network], source="Lamina network participation"),
    ]


def _route_rationale(
    route_modality: CareModality, fit: PhysicianCaseFit, recommended_fit: PhysicianCaseFit | None,
    recommended_modality: CareModality | None, is_recommended: bool, access: AccessProfile,
) -> str:
    short_name = short_physician_name(fit.physician_name)
    if route_modality == "econsult":
        if is_recommended:
            return (
                f"{short_name} has confirmed e-consult is suitable for this presentation, with a fast "
                "response (about 2 business days) that protects scarce visit capacity; it can still "
                "escalate to a visit if examination is needed."
            )
        return (
            "Fast response (about 2 business days), but direct in-person evaluation is preferred "
            "for this presentation."
        )
    if is_recommended:
        history = " including experience with similar patients," if fit.similar_case_patterns else ","
        return (
            f"In-person evaluation is appropriate for this presentation; {short_name} has the strongest "
            f"physician-side fit,{history} and current in-person access remains within an acceptable window."
        )
    if recommended_fit is not None and recommended_fit.physician_id == fit.physician_id and recommended_modality == "econsult":
        return (
            f"A visit with {short_name} remains available "
            f"({access.in_person_wait_label.replace('Approximately ', '~')}) if the e-consult identifies a need "
            "for examination."
        )
    if fit.receiving_fit == "unknown":
        return (
            "A strong clinical alternative with shorter in-person access, though with no similar-case "
            "history or confirmed receiving preferences on record yet, and a less institutionally "
            "integrated connection."
        )
    return "A clinically appropriate alternative route."


def compare_routes(
    need: CareRoutingAssessment,
    fits: list[PhysicianCaseFit],
    access_profiles: dict[str, AccessProfile] | None = None,
    network: dict[str, tuple[NetworkParticipation, str]] | None = None,
) -> list[CandidateRoute]:
    """Route fit. Builds physician + modality routes that pass the hard
    clinical/modality gates, then picks ONE recommended route:

    - physicians are compared by (clinical fit, whether their best
      appropriate route's access meets the priority window, receiving fit,
      access days, name) -- an explicit ordering, never a numeric value;
    - for the chosen physician, the least resource-intensive route that is
      still appropriate wins: e-consult only when clinically appropriate
      and consistent with their policy, otherwise a visit.

    Access affects which route wins; it never alters any `fit_label`."""
    access_profiles = access_profiles if access_profiles is not None else PHYSICIAN_ACCESS_PROFILES
    network = network if network is not None else PHYSICIAN_NETWORK
    target_days = PRIORITY_ACCESS_TARGET_DAYS[need.suggested_priority]
    viability = need.modality_viability

    def within_target(modality: CareModality, access: AccessProfile) -> bool | None:
        days = _route_access_days(modality, access)
        return None if days is None else days <= target_days

    eligible: list[tuple[PhysicianCaseFit, AccessProfile, list[CareModality], CareModality | None]] = []
    for fit in fits:
        access = access_profiles.get(fit.physician_id)
        if fit.clinical_fit == "poor" or access is None:
            continue
        modalities: list[CareModality] = []
        if viability is None or viability.visit == "viable":
            modalities.append("in_person")
        if _econsult_listed(need, fit, access):
            modalities.append("econsult")
        if not modalities:
            continue
        best: CareModality | None = (
            "econsult" if "econsult" in modalities and _econsult_appropriate(need, fit)
            else "in_person" if "in_person" in modalities else None
        )
        eligible.append((fit, access, modalities, best))

    ranked = sorted(
        (item for item in eligible if item[3] is not None),
        key=lambda item: (
            _CLINICAL_ORDER[item[0].clinical_fit],
            not within_target(item[3], item[1]),
            _RECEIVING_ORDER[item[0].receiving_fit],
            _route_access_days(item[3], item[1]) or 10_000,
            item[0].physician_name,
        ),
    )
    recommended_fit, recommended_modality = (ranked[0][0], ranked[0][3]) if ranked else (None, None)

    routes: list[CandidateRoute] = []
    for fit, access, modalities, _best in eligible:
        participation, confidence = network.get(fit.physician_id, (NetworkParticipation.LAMINA_PHYSICIAN, "medium"))
        for modality in modalities:
            is_recommended = recommended_fit is fit and recommended_modality == modality
            in_target = within_target(modality, access)
            routes.append(CandidateRoute(
                physician_id=fit.physician_id,
                physician_name=fit.physician_name,
                specialty=need.specialty,
                modality=modality,
                fit_label=fit.clinical_fit,
                evidence_confidence=confidence,
                network_participation=participation,
                access=access,
                recommended=is_recommended,
                rationale=_route_rationale(modality, fit, recommended_fit, recommended_modality, is_recommended, access),
                route_evidence=_route_evidence(modality, fit, access, participation, need.suggested_priority, in_target),
                within_access_target=in_target,
            ))
    return routes


def _external_directory_route(specialty: str) -> CandidateRoute:
    return CandidateRoute(
        physician_id=_EXTERNAL_DIRECTORY_CANDIDATE["physician_id"],
        physician_name=_EXTERNAL_DIRECTORY_CANDIDATE["physician_name"],
        specialty=specialty,
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
    )


def build_candidate_routes(
    context: ClinicalRepresentation,
    confirmed_modality: str | None = None,
    case_rules_overrides: dict[str, PhysicianCaseRules] | None = None,
) -> list[CandidateRoute]:
    """physician + modality + expected access = ROUTE. Empty for any case
    this demo doesn't route. Case interests are not an input: they add
    fit evidence but never change a tier, so routes are identical with or
    without them."""
    need = patient_need(context)
    if need is None:
        return []
    fits = build_physician_fits(context, confirmed_modality, case_rules_overrides)
    return [*compare_routes(need, fits), _external_directory_route(need.specialty)]


def build_care_routing(
    context: ClinicalRepresentation,
    confirmed_modality: str | None = None,
    case_rules_overrides: dict[str, PhysicianCaseRules] | None = None,
) -> CareRoutingAssessment | None:
    """The patient need, plus a display summary of the route-fit outcome
    (`recommended_modality`/`in_person_need`/`econsult_suitability`).
    `modality_viability` and `suggested_priority` never change with any
    physician's preference."""
    need = patient_need(context)
    if need is None:
        return None
    routes = build_candidate_routes(context, confirmed_modality, case_rules_overrides)
    recommended = next((route for route in routes if route.recommended), None)
    if recommended is not None and recommended.modality == "econsult":
        return need.model_copy(update={
            "recommended_modality": "econsult",
            "in_person_need": "optional",
            "econsult_suitability": "suitable",
            "rationale": (
                "Persistent worsening type 2 diabetes despite medication escalation makes "
                "Endocrinology evaluation appropriate; the receiving physician has confirmed "
                "e-consult is suitable for this presentation."
            ),
        })
    has_econsult_route = any(route.modality == "econsult" for route in routes)
    return need.model_copy(update={
        "econsult_suitability": "possible_not_preferred" if has_econsult_route else "not_suitable",
    })
