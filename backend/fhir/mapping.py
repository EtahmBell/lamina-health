from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from backend.models import LabObservation, PatientRecord

DEMO_AGE_EXTENSION = "https://lamina.health/fhir/StructureDefinition/demo-age"
DEMO_CLINICAL_NOTE_EXTENSION = "https://lamina.health/fhir/StructureDefinition/demo-clinical-note"

LAB_CODES = {
    "2160-0": "creatinine",
    "98979-8": "eGFR",
    "718-7": "hemoglobin",
    "2276-4": "ferritin",
    "2498-4": "serum_iron",
    "2500-7": "TIBC",
    "2502-3": "transferrin_saturation",
    "787-2": "MCV",
    "6690-2": "WBC",
    "777-3": "platelets",
}


def _concept_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    if value.get("text"):
        return " ".join(str(value["text"]).split())
    for coding in value.get("coding") or []:
        if coding.get("display"):
            return " ".join(str(coding["display"]).split())
    return ""


def _age(patient: dict[str, Any], as_of: date | None = None) -> int:
    for extension in patient.get("extension") or []:
        if extension.get("url") == DEMO_AGE_EXTENSION and isinstance(
            extension.get("valueInteger"), int
        ):
            return extension["valueInteger"]
    born = date.fromisoformat(patient["birthDate"])
    current = as_of or datetime.now(UTC).date()
    return current.year - born.year - ((current.month, current.day) < (born.month, born.day))


def _display_name(patient: dict[str, Any]) -> str:
    name = (patient.get("name") or [{}])[0]
    parts = [*(name.get("given") or []), name.get("family")]
    clean = " ".join(str(part).strip() for part in parts if part)
    return f"{clean} (synthetic)"


def _lab_kind(observation: dict[str, Any]) -> str | None:
    code = observation.get("code") or {}
    codes = {str(item.get("code", "")) for item in code.get("coding") or []}
    text = _concept_text(code).casefold()
    for code, kind in LAB_CODES.items():
        if code in codes:
            return kind
    text_kinds = {
        "creatinine": "creatinine",
        "egfr": "eGFR",
        "glomerular filtration": "eGFR",
        "hemoglobin": "hemoglobin",
        "ferritin": "ferritin",
        "iron saturation": "transferrin_saturation",
        "iron binding capacity": "TIBC",
        "mcv": "MCV",
        "leukocyte": "WBC",
        "platelet": "platelets",
    }
    for term, kind in text_kinds.items():
        if term in text:
            return kind
    return None


def map_fhir_resources_to_patient(
    patient_id: str,
    patient: dict[str, Any],
    conditions: list[dict[str, Any]],
    medication_requests: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    coverages: list[dict[str, Any]],
    *,
    as_of: date | None = None,
) -> PatientRecord:
    diagnoses = [_concept_text(item.get("code")) for item in conditions]
    medications = [
        _concept_text(item.get("medicationCodeableConcept")) for item in medication_requests
    ]
    labs: list[LabObservation] = []
    for observation in observations:
        kind = _lab_kind(observation)
        quantity = observation.get("valueQuantity") or {}
        effective = str(
            observation.get("effectiveDateTime") or observation.get("effectiveDate") or ""
        )[:10]
        if kind and effective and isinstance(quantity.get("value"), (int, float)):
            labs.append(
                LabObservation(
                    date=effective,
                    test=kind,
                    value=float(quantity["value"]),
                    unit=str(quantity.get("unit") or ""),
                )
            )
    labs.sort(key=lambda item: (item.test, item.date))
    address = (patient.get("address") or [{}])[0]
    location = ", ".join(
        value
        for value in (str(address.get("city") or ""), str(address.get("state") or ""))
        if value
    )
    coverage = coverages[0] if coverages else {}
    insurer = _concept_text(coverage.get("type")) or str(coverage.get("subscriberId") or "")
    clinical_notes = [
        str(extension["valueString"])
        for extension in patient.get("extension") or []
        if extension.get("url") == DEMO_CLINICAL_NOTE_EXTENSION and extension.get("valueString")
    ]
    return PatientRecord(
        id=patient_id,
        display_name=_display_name(patient),
        age=_age(patient, as_of),
        diagnoses=[value for value in diagnoses if value],
        medications=[value for value in medications if value],
        labs=labs,
        clinical_notes=clinical_notes,
        insurance=insurer or "Insurance not supplied",
        location=location or "Location not supplied",
        clinical_data_source="medplum_fhir",
    )
