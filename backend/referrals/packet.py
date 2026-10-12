"""Initial referral packet assembly.

Deliberately generic: each case family has a list of fields its initial
assembly step knows how to gather. For a diabetes referral, that list does not
yet include renal function -- not because any particular patient's result is
withheld, but because initial assembly for this case family simply hasn't been
taught to reach for it. Preflight (see resolver.py) is what notices the gap.
"""

from __future__ import annotations

from backend.demo_identity import PCP_AGENT_ID
from backend.models import ClinicalRepresentation, PacketItem, PacketItemProvenance, PatientRecord, ReferralPacket

INITIAL_ASSEMBLY_FIELDS_BY_CASE_FAMILY: dict[str, list[str]] = {
    "type_2_diabetes": ["recent_hba1c", "current_medications", "glucose_log"],
}


def _latest_lab(patient: PatientRecord, test: str):
    matches = [lab for lab in patient.labs if lab.test == test]
    return max(matches, key=lambda lab: lab.date) if matches else None


def _hba1c_item(patient: PatientRecord, context: ClinicalRepresentation) -> PacketItem | None:
    lab = _latest_lab(patient, "HbA1c")
    if lab is None:
        return None
    value = f"{lab.value:g}% on {lab.date}"
    if len(context.hba1c_trend) > 1:
        value += " (trend: " + ", ".join(f"{v:g}%" for v in context.hba1c_trend) + ")"
    return PacketItem(
        key="recent_hba1c",
        label="Recent HbA1c",
        value=value,
        provenance=PacketItemProvenance(
            source="patient_chart", attached_by=PCP_AGENT_ID, attached_during="initial_assembly", observed_date=lab.date
        ),
    )


def _medications_item(patient: PatientRecord, _context: ClinicalRepresentation) -> PacketItem | None:
    if not patient.medications:
        return None
    return PacketItem(
        key="current_medications",
        label="Current diabetes medication list",
        value=", ".join(patient.medications),
        provenance=PacketItemProvenance(
            source="patient_chart", attached_by=PCP_AGENT_ID, attached_during="initial_assembly", observed_date=None
        ),
    )


def _glucose_log_item(patient: PatientRecord, context: ClinicalRepresentation) -> PacketItem | None:
    lab = _latest_lab(patient, "fasting_glucose")
    if lab is None:
        return None
    value = f"{lab.value:g} mg/dL on {lab.date}"
    if len(context.fasting_glucose_trend) > 1:
        value += " (trend: " + ", ".join(f"{v:g}" for v in context.fasting_glucose_trend) + " mg/dL)"
    return PacketItem(
        key="glucose_log",
        label="Home glucose log",
        value=value,
        provenance=PacketItemProvenance(
            source="patient_chart", attached_by=PCP_AGENT_ID, attached_during="initial_assembly", observed_date=lab.date
        ),
    )


_ITEM_BUILDERS = {
    "recent_hba1c": _hba1c_item,
    "current_medications": _medications_item,
    "glucose_log": _glucose_log_item,
}


def assemble_initial_packet(patient: PatientRecord, context: ClinicalRepresentation) -> ReferralPacket:
    fields = INITIAL_ASSEMBLY_FIELDS_BY_CASE_FAMILY.get(context.case_family, [])
    items: list[PacketItem] = []
    for key in fields:
        builder = _ITEM_BUILDERS.get(key)
        item = builder(patient, context) if builder else None
        if item is not None:
            items.append(item)
    return ReferralPacket(items=items)
