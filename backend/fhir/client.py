from __future__ import annotations

from typing import Protocol

from backend.config import environment
from backend.models import PatientRecord
from backend.synthetic_data import PATIENTS


class ClinicalDataSource(Protocol):
    """Bounded patient-context source used by the consultation application."""

    source_name: str

    def get_patient(self, patient_id: str) -> PatientRecord | None: ...


class SyntheticClinicalDataSource:
    source_name = "synthetic_fixture"

    def get_patient(self, patient_id: str) -> PatientRecord | None:
        return PATIENTS.get(patient_id)


def create_clinical_data_source(source: str | None = None) -> ClinicalDataSource:
    selected = (source or environment.get("LAMINA_CLINICAL_SOURCE", "synthetic")).strip().casefold()
    if selected == "synthetic":
        return SyntheticClinicalDataSource()
    if selected == "medplum":
        from .medplum import MedplumClinicalDataSource, MedplumSettings

        return MedplumClinicalDataSource(MedplumSettings.from_environment())
    raise RuntimeError("LAMINA_CLINICAL_SOURCE must be 'synthetic' or 'medplum'")
