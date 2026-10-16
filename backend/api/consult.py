from fastapi import APIRouter, HTTPException

from backend.agents import consult_network
from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.fhir import MedplumError, create_clinical_data_source
from backend.models import ConsultationRequest, ConsultationResult, PatientRecord
from backend.referrals import apply_medication_changes
from backend.synthetic_data import PATIENTS, PHYSICIANS_BY_PATIENT
from backend.workflow import workflow_store

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


def _with_derived_medications(patient: PatientRecord, workspace_id: str) -> PatientRecord:
    """Overlays any documented-encounter medication changes onto the static
    fixture's base regimen (Tonjit demo-story pass, Part F/G) -- a pure,
    request-time read; `patient` itself (and the fixture it came from) is
    never mutated, so a patient with no encounters renders exactly as
    before. The patient's own clinical record, not the handoff, is the
    source of truth for the current medication list."""
    encounters = workflow_store.list_encounters_for_patient(workspace_id, patient.id)
    if not encounters:
        return patient
    current_medications, changes = apply_medication_changes(patient.medications, encounters)
    return patient.model_copy(update={"medications": current_medications, "recent_medication_changes": changes})


@router.get("/patients", response_model=list[PatientRecord])
def list_patients(workspace_id: DemoWorkspace) -> list[PatientRecord]:
    return [_with_derived_medications(load_patient(patient_id), workspace_id) for patient_id in PATIENTS]


@router.get("/patients/{patient_id}", response_model=PatientRecord)
def get_patient(patient_id: str, workspace_id: MutableDemoWorkspace) -> PatientRecord:
    patient = load_patient(patient_id)
    workflow_store.opened(workspace_id, patient_id)
    return _with_derived_medications(patient, workspace_id)


@router.post("/patients/{patient_id}/consultations", response_model=ConsultationResult)
def create_consultation(
    patient_id: str, request: ConsultationRequest, workspace_id: MutableDemoWorkspace
) -> ConsultationResult:
    # Tonjit demo-story pass, Part S/T: a future network consultation must see
    # the patient's CURRENT clinical record -- including any medication
    # change from a prior documented encounter -- never the frozen base
    # fixture. Same derivation GET /api/patients/{id} already applies.
    patient = _with_derived_medications(load_patient(patient_id), workspace_id)
    workflow_store.started(workspace_id, patient_id)
    result = consult_network(patient, PHYSICIANS_BY_PATIENT[patient_id], request.pcp_guidance)
    workflow_store.completed(workspace_id, result)
    return result
