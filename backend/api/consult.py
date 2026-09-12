from fastapi import APIRouter, HTTPException

from backend.agents import consult_network
from backend.fhir import SyntheticClinicalDataSource
from backend.models import ConsultationRequest, ConsultationResult, PatientRecord
from backend.synthetic_data import PHYSICIANS, PRIMARY_PATIENT_ID

router = APIRouter(prefix="/api", tags=["consult-network"])
data_source = SyntheticClinicalDataSource()


@router.get("/patients", response_model=list[PatientRecord])
def list_patients() -> list[PatientRecord]:
    patient = data_source.get_patient(PRIMARY_PATIENT_ID)
    return [patient] if patient else []


@router.get("/patients/{patient_id}", response_model=PatientRecord)
def get_patient(patient_id: str) -> PatientRecord:
    patient = data_source.get_patient(patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Synthetic patient not found")
    return patient


@router.post("/patients/{patient_id}/consultations", response_model=ConsultationResult)
def create_consultation(patient_id: str, request: ConsultationRequest) -> ConsultationResult:
    patient = data_source.get_patient(patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Synthetic patient not found")
    return consult_network(patient, PHYSICIANS, request.pcp_guidance)

