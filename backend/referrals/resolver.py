"""Generic missing-requirement resolution: search the patient's existing
structured chart for data that directly satisfies an explicit requirement.

This performs no clinical inference. It only locates already-recorded
structured results (LabObservation rows) that qualify a named requirement --
the same mechanism works for any future requirement key, as long as an entry
exists in REQUIREMENT_CHART_SOURCES.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from backend.demo_identity import PCP_AGENT_ID
from backend.models import PacketItem, PacketItemProvenance, PatientRecord, ReferralRequirement

# Which structured chart lab tests, if all present and fresh enough, satisfy a
# given requirement key. Adding a future resolvable requirement means adding a
# line here, not a new conditional branch.
REQUIREMENT_CHART_SOURCES: dict[str, list[str]] = {
    "recent_renal_function": ["creatinine", "eGFR"],
    "recent_hba1c": ["HbA1c"],
    "glucose_log": ["fasting_glucose"],
}

_TEST_LABELS = {"creatinine": "Creatinine", "eGFR": "eGFR", "HbA1c": "HbA1c", "fasting_glucose": "Fasting glucose"}


def _latest_lab(patient: PatientRecord, test: str):
    matches = [lab for lab in patient.labs if lab.test == test]
    return max(matches, key=lambda lab: lab.date) if matches else None


def resolve_missing_requirement(
    patient: PatientRecord,
    requirement: ReferralRequirement,
    *,
    today: date | None = None,
) -> PacketItem | None:
    """Find existing chart data that satisfies `requirement`, or None if no
    qualifying result exists. Never fabricates a result."""
    test_names = REQUIREMENT_CHART_SOURCES.get(requirement.key)
    if not test_names:
        return None
    reference_day = today or datetime.now(UTC).date()
    labs = []
    for test in test_names:
        lab = _latest_lab(patient, test)
        if lab is None:
            return None
        if requirement.freshness_days is not None:
            observed = datetime.strptime(lab.date, "%Y-%m-%d").date()
            if (reference_day - observed).days > requirement.freshness_days:
                return None
        labs.append(lab)
    observed_date = labs[0].date
    value = ", ".join(f"{_TEST_LABELS.get(lab.test, lab.test)}: {lab.value:g} {lab.unit}" for lab in labs)
    return PacketItem(
        key=requirement.key,
        label=requirement.label,
        value=f"{value} ({observed_date})",
        provenance=PacketItemProvenance(
            source="patient_chart",
            attached_by=PCP_AGENT_ID,
            attached_during="preflight",
            observed_date=observed_date,
        ),
    )
