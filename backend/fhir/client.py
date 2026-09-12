from typing import Protocol

from backend.models import PatientRecord
from backend.synthetic_data import PATIENTS


class ClinicalDataSource(Protocol):
    """Boundary for synthetic fixtures now and a bounded FHIR adapter later."""

    def get_patient(self, patient_id: str) -> PatientRecord | None: ...


class SyntheticClinicalDataSource:
    def get_patient(self, patient_id: str) -> PatientRecord | None:
        return PATIENTS.get(patient_id)

