from __future__ import annotations

from typing import Any

from backend.synthetic_data import PRIMARY_PATIENT_ID

from .mapping import DEMO_AGE_EXTENSION
from .medplum import (
    DEMO_PATIENT_IDENTIFIER_SYSTEM,
    SYNTHETIC_TAG,
    MedplumClient,
)

RESOURCE_IDENTIFIER_ROOT = "https://lamina.health/fhir/demo-resource"


def _identifier(value: str) -> list[dict[str, str]]:
    return [{"system": RESOURCE_IDENTIFIER_ROOT, "value": value}]


def jordan_lee_fhir_resources() -> dict[str, list[dict[str, Any]]]:
    tag = {"tag": [SYNTHETIC_TAG]}
    patient = {
        "resourceType": "Patient",
        "meta": tag,
        "identifier": [
            {"system": DEMO_PATIENT_IDENTIFIER_SYSTEM, "value": PRIMARY_PATIENT_ID}
        ],
        "extension": [{"url": DEMO_AGE_EXTENSION, "valueInteger": 62}],
        "active": True,
        "gender": "unknown",
        "name": [{"given": ["Jordan"], "family": "Lee"}],
        "birthDate": "1964-01-12",
        "address": [{"city": "Oakland", "state": "CA", "country": "US"}],
    }
    conditions = [
        {
            "resourceType": "Condition",
            "meta": tag,
            "identifier": _identifier(f"{PRIMARY_PATIENT_ID}-condition-{index}"),
            "clinicalStatus": {"text": "Active"},
            "verificationStatus": {"text": "Confirmed"},
            "code": {"text": display},
        }
        for index, display in enumerate(
            (
                "Resistant hypertension",
                "Type 2 diabetes mellitus",
                "Progressive chronic kidney disease",
            ),
            1,
        )
    ]
    medications = [
        {
            "resourceType": "MedicationRequest",
            "meta": tag,
            "identifier": _identifier(f"{PRIMARY_PATIENT_ID}-medication-{index}"),
            "status": "active",
            "intent": "order",
            "medicationCodeableConcept": {"text": display},
        }
        for index, display in enumerate(("Lisinopril", "Amlodipine", "Chlorthalidone"), 1)
    ]
    observations: list[dict[str, Any]] = []
    series = (
        ("creatinine", "2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "mg/dL", (1.1, 1.3, 1.6, 1.8)),
        ("egfr", "98979-8", "Glomerular filtration rate", "mL/min/1.73m2", (68, 59, 48, 41)),
    )
    dates = ("2025-01-12", "2025-05-16", "2026-01-09", "2026-08-21")
    for key, loinc, display, unit, values in series:
        for index, (effective, value) in enumerate(zip(dates, values, strict=True), 1):
            observations.append(
                {
                    "resourceType": "Observation",
                    "meta": tag,
                    "identifier": _identifier(
                        f"{PRIMARY_PATIENT_ID}-observation-{key}-{index}"
                    ),
                    "status": "final",
                    "category": [{"text": "Laboratory"}],
                    "code": {
                        "coding": [
                            {
                                "system": "http://loinc.org",
                                "code": loinc,
                                "display": display,
                            }
                        ],
                        "text": "Creatinine" if key == "creatinine" else "eGFR",
                    },
                    "effectiveDateTime": f"{effective}T12:00:00Z",
                    "valueQuantity": {"value": value, "unit": unit},
                }
            )
    coverage = {
        "resourceType": "Coverage",
        "meta": tag,
        "identifier": _identifier(f"{PRIMARY_PATIENT_ID}-coverage-1"),
        "status": "active",
        "type": {"text": "Lamina Demo PPO"},
        "payor": [{"display": "Lamina Demo PPO"}],
    }
    return {
        "Patient": [patient],
        "Condition": conditions,
        "MedicationRequest": medications,
        "Observation": observations,
        "Coverage": [coverage],
    }


def seed_jordan_lee(client: MedplumClient) -> dict[str, list[str]]:
    resources = jordan_lee_fhir_resources()
    patient = client.upsert_by_identifier(
        "Patient",
        DEMO_PATIENT_IDENTIFIER_SYSTEM,
        PRIMARY_PATIENT_ID,
        resources["Patient"][0],
    )
    subject = {"reference": f"Patient/{patient['id']}"}
    saved: dict[str, list[str]] = {"Patient": [str(patient["id"])]}
    for resource_type in ("Condition", "MedicationRequest", "Observation", "Coverage"):
        saved[resource_type] = []
        reference_field = "beneficiary" if resource_type == "Coverage" else "subject"
        for resource in resources[resource_type]:
            value = str(resource["identifier"][0]["value"])
            stored = client.upsert_by_identifier(
                resource_type,
                RESOURCE_IDENTIFIER_ROOT,
                value,
                {**resource, reference_field: subject},
            )
            saved[resource_type].append(str(stored["id"]))
    return saved
