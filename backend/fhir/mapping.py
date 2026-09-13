from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from backend.models import LabObservation, PatientRecord

DEMO_AGE_EXTENSION = "https://lamina.health/fhir/StructureDefinition/demo-age"


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
    if "2160-0" in codes or "creatinine" in text:
        return "creatinine"
    if "98979-8" in codes or "egfr" in text or "glomerular filtration" in text:
        return "eGFR"
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
    return PatientRecord(
        id=patient_id,
        display_name=_display_name(patient),
        age=_age(patient, as_of),
        diagnoses=[value for value in diagnoses if value],
        medications=[value for value in medications if value],
        labs=labs,
        insurance=insurer or "Insurance not supplied",
        location=location or "Location not supplied",
        clinical_data_source="medplum_fhir",
    )

