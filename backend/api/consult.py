from fastapi import APIRouter, HTTPException

from backend.agents import consult_network
from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.fhir import MedplumError, create_clinical_data_source
from backend.models import ConsultationEncounter, ConsultationRequest, ConsultationResult, HandoffStatus, PatientRecord
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


def _encounter_visible_to(
    encounter: ConsultationEncounter, workspace_id: str, as_physician_id: str | None
) -> bool:
    """The PCP-visibility gate (bug-fix pass, Part A/B): the receiving
    physician who authored an encounter sees its treatment change the
    moment it's documented -- the SAME physician/workspace-scoped
    convention `GET /referrals/{id}/handoff`'s `as_physician_id` already
    uses for gating a draft handoff. Anyone else (including the referring
    physician, and the default "no identity given" case) only sees it once
    the associated handoff has actually been SENT -- an information-
    visibility boundary, never a second source of clinical truth; the
    encounter itself is unchanged either way."""
    if as_physician_id is not None and as_physician_id == encounter.physician_id:
        return True
    handoff = workflow_store.get_handoff(workspace_id, encounter.referral_id)
    return handoff is not None and handoff.status == HandoffStatus.SENT


def _with_derived_medications(
    patient: PatientRecord, workspace_id: str, as_physician_id: str | None = None
) -> PatientRecord:
    """Overlays any VISIBLE documented-encounter medication changes onto the
    static fixture's base regimen (Tonjit demo-story pass, Part F/G, bug-fix
    pass Part A/B) -- a pure, request-time read; `patient` itself (and the
    fixture it came from) is never mutated, so a patient with no visible
    encounters renders exactly as before. The patient's own clinical
    record (ConsultationEncounter), not the handoff, remains the single
    source of truth for the current medication list -- `as_physician_id`
    only ever changes which encounters are visible to THIS reader, never
    what the record itself says."""
    encounters = workflow_store.list_encounters_for_patient(workspace_id, patient.id)
    visible = [e for e in encounters if _encounter_visible_to(e, workspace_id, as_physician_id)]
    if not visible:
        return patient
    current_medications, changes = apply_medication_changes(patient.medications, visible)
    return patient.model_copy(update={"medications": current_medications, "recent_medication_changes": changes})


@router.get("/patients", response_model=list[PatientRecord])
def list_patients(workspace_id: DemoWorkspace) -> list[PatientRecord]:
    return [_with_derived_medications(load_patient(patient_id), workspace_id) for patient_id in PATIENTS]


@router.get("/patients/{patient_id}", response_model=PatientRecord)
def get_patient(
    patient_id: str, workspace_id: MutableDemoWorkspace, as_physician_id: str | None = None
) -> PatientRecord:
    patient = load_patient(patient_id)
    workflow_store.opened(workspace_id, patient_id)
    return _with_derived_medications(patient, workspace_id, as_physician_id)


@router.post("/patients/{patient_id}/consultations", response_model=ConsultationResult)
def create_consultation(
    patient_id: str, request: ConsultationRequest, workspace_id: MutableDemoWorkspace
) -> ConsultationResult:
    # Tonjit demo-story pass, Part S/T: a future network consultation must see
    # the patient's CURRENT clinical record -- including any medication
    # change from a prior documented encounter -- never the frozen base
    # fixture. Never passes as_physician_id: this is always run as/for the
    # referring physician, so it must see exactly what Lucy herself would
    # see (gated on handoff-sent, bug-fix pass Part A).
    patient = _with_derived_medications(load_patient(patient_id), workspace_id)
    workflow_store.started(workspace_id, patient_id)
    result = consult_network(patient, PHYSICIANS_BY_PATIENT[patient_id], request.pcp_guidance)
    workflow_store.completed(workspace_id, result)
    return result
