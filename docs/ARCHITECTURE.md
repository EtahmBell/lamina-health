# V1 architecture

Lamina V1 is a deterministic, synthetic specialty-care orchestration demo. The implementation intentionally keeps clinical logic independent of HTTP and UI code.

```text
SyntheticClinicalDataSource (future: bounded Medplum/FHIR adapter)
    ↓ PatientRecord
build_patient_context
    ↓ ClinicalRepresentation: facts, trends, interpretable signals
generate_candidates
    ↓ broad candidate slate with reasons
evaluate_physician × 5
    ↓ structured, independent PhysicianEvaluation records
consult_network
    ↓ grounded recommendation, alternatives, and evidence
FastAPI → React patient view
```

## Evidence hierarchy

1. Hard patient facts: diagnoses, medications, and longitudinal renal labs.
2. Explicit physician rules: current acceptance or deferral preferences.
3. Historical-practice similarity: overlap with synthetic prior case mix, used only as a fit signal.
4. Operational constraints: synthetic insurance/network status and approximate availability.
5. Bounded inference: plain-language synthesis over the structured results.

Explicit rules are evaluated before case similarity. Dr. Onadeko therefore remains a reasonable hypertension alternative but defers the progressively declining renal case to nephrology first, even though the historical case mix overlaps.

## Main modules

- `backend/models/consultation.py`: strict Pydantic schemas shared across the domain and API.
- `backend/synthetic_data/fixtures.py`: the primary patient and five inspectable practice footprints.
- `backend/fhir/client.py`: clinical-data source interface and local synthetic implementation.
- `backend/clinical/`: patient representation and candidate generation.
- `backend/agents/physician_agent.py`: deterministic physician-specific evaluation.
- `backend/agents/orchestrator.py`: evaluation comparison and final synthesis.
- `backend/api/consult.py`: patient and consultation endpoints.
- `frontend/`: the patient chart, Consult Network interaction, recommendation, and structured evidence view.

## API

- `GET /health`
- `GET /api/patients`
- `GET /api/patients/{patient_id}`
- `POST /api/patients/{patient_id}/consultations`

The POST body is `{ "pcp_guidance": null }`; optional guidance can be supplied without changing the default one-click flow.

## Adding a second case

Add a `PatientRecord` to `PATIENTS`, add or reuse practice footprints, and create an acceptance test asserting the intended structured outcome. Domain code should change only if the new fixture exposes a genuinely new clinical signal or rule—not to hard-code a desired physician.

## Deferred intentionally

- Production Medplum implementation, authentication, authorization, and persistence.
- Real scheduling, payer eligibility, referral submission, and EHR writeback.
- LLM augmentation. If added, model output must validate against the existing schemas and remain subordinate to patient facts and explicit rules.
- A second clinical demo case.

