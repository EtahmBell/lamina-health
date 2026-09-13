from fastapi import APIRouter, HTTPException

from backend.agents import consult_network
from backend.fhir import MedplumError, create_clinical_data_source
from backend.models import ConsultationRequest, ConsultationResult, PatientRecord
from backend.synthetic_data import PHYSICIANS, PRIMARY_PATIENT_ID

router = APIRouter(prefix="/api", tags=["consult-network"])
data_source = create_clinical_data_source()


def load_patient(patient_id: str) -> PatientRecord:
    try:
        patient = data_source.get_patient(patient_id)
    except MedplumError as error:
        raise HTTPException(
            status_code=503,
            detail=f"Configured Medplum clinical source is unavailable: {error.category}",
        ) from error
    if patient is None:
        raise HTTPException(status_code=404, detail="Synthetic patient not found")
    return patient


@router.get("/patients", response_model=list[PatientRecord])
def list_patients() -> list[PatientRecord]:
    return [load_patient(PRIMARY_PATIENT_ID)]


@router.get("/patients/{patient_id}", response_model=PatientRecord)
def get_patient(patient_id: str) -> PatientRecord:
    return load_patient(patient_id)


@router.post("/patients/{patient_id}/consultations", response_model=ConsultationResult)
def create_consultation(patient_id: str, request: ConsultationRequest) -> ConsultationResult:
    patient = load_patient(patient_id)
    return consult_network(patient, PHYSICIANS, request.pcp_guidance)
