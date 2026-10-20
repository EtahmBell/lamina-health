"""Structured, physician-authored referral intake requirements.

These are deliberately data, not code: "Dr. Chen requires recent renal function
for this type of diabetes referral" is a fact about his practice, evaluated
generically against whatever packet a referral happens to carry -- never a
conditional keyed on which patient is being referred.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from backend.models import ReferralPacket, ReferralRequirement, RequirementCheck, RequirementStatus

REFERRAL_REQUIREMENTS_BY_KEY: dict[tuple[str, str], list[ReferralRequirement]] = {
    ("physician-chen", "type_2_diabetes"): [
        ReferralRequirement(
            key="recent_hba1c", label="Recent HbA1c", required=True, freshness_days=180
        ),
        ReferralRequirement(
            key="current_medications",
            label="Current diabetes medication list",
            required=True,
            freshness_days=None,
        ),
        ReferralRequirement(
            key="recent_renal_function",
            label="Recent renal function",
            required=True,
            freshness_days=180,
        ),
        ReferralRequirement(
            key="glucose_log",
            label="Glucose log or CGM data",
            required=False,
            freshness_days=None,
        ),
    ],
}


def requirements_for(
    receiving_physician_id: str,
    case_family: str,
    confirmed_items: list[ReferralRequirement] | None = None,
) -> list[ReferralRequirement]:
    """`confirmed_items` (NLP referral-preference pass, Part J), when supplied,
    is the physician's own CONFIRMED persisted referral preference's required
    + helpful items for this case family -- takes priority over the static
    fixture below. Stays a pure function: the caller (see
    backend/referral_preferences.py) looks up the confirmed preference from
    storage. Falls back to the fixture when no confirmed preference exists,
    so every physician without one is unaffected."""
    if confirmed_items is not None:
        return confirmed_items
    return REFERRAL_REQUIREMENTS_BY_KEY.get((receiving_physician_id, case_family), [])


def _is_fresh(observed_date: str | None, freshness_days: int | None, today: date) -> bool:
    if freshness_days is None:
        return True
    if observed_date is None:
        return False
    observed = datetime.strptime(observed_date, "%Y-%m-%d").date()
    return (today - observed).days <= freshness_days


def evaluate_requirements(
    requirements: list[ReferralRequirement],
    packet: ReferralPacket,
    *,
    today: date | None = None,
) -> list[RequirementCheck]:
    """Deterministic, structured presence/freshness check -- no model call."""
    reference_day = today or datetime.now(UTC).date()
    checks: list[RequirementCheck] = []
    for requirement in requirements:
        item = packet.item(requirement.key)
        if item is not None and _is_fresh(item.provenance.observed_date, requirement.freshness_days, reference_day):
            status = RequirementStatus.SATISFIED
        elif requirement.required:
            status = RequirementStatus.MISSING_FROM_PACKET
        else:
            status = RequirementStatus.OPTIONAL_NOT_PRESENT
        checks.append(
            RequirementCheck(
                key=requirement.key, label=requirement.label, required=requirement.required, status=status
            )
        )
    return checks
