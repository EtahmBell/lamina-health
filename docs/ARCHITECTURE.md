# Lamina architecture

Lamina keeps provider identity, patient clinical context, and specialty-care
orchestration as separate layers.

```text
NPPES provider index (read only)
    ↓
Physician Network → reserved Lamina identity → optional verification/preferences
                                              ↓ controlled synthetic footprints only

Medplum / FHIR synthetic data ─┐
                               ├→ ClinicalDataSource → PatientRecord
Local synthetic fixture ───────┘          ↓
                                 build_patient_context
                                          ↓
                                    Consult Network
                                          ↓
                       case-specific physician evaluations × 5
                                          ↓
                         structured consultation messages
                                          ↓
                    recommendation + alternatives + evidence
                                          ↓
                                     FastAPI → React
```

NPPES supplies public provider identity and practice-directory fields; it does
not establish licensure, participation, authorization, or recommendation
eligibility. Medplum supplies bounded clinical context and never stores the
national NPPES dataset. Lamina supplies reserved agent identities, controlled
practice footprints, orchestration, and transparent synthesis.

## Clinical-data boundary

`ClinicalDataSource.get_patient(patient_id)` is the only patient-data operation
used by the consultation application. `SyntheticClinicalDataSource` reads the
offline fixture. `MedplumClinicalDataSource` authenticates with environment
credentials, resolves the stable synthetic Patient identifier, and retrieves
synthetic-tagged Condition, MedicationRequest, Observation, and Coverage
resources for that exact Patient reference.

Both sources produce the same strict `PatientRecord`; consultation code does not
know which source was used. `LAMINA_CLINICAL_SOURCE=synthetic` is the offline
default. `medplum` is explicit and fails visibly rather than silently falling
back. Raw FHIR and credentials never enter agent messages or API responses.

## Structured consultation conversation

Physician evaluations remain deterministic and use the existing evidence
hierarchy. The orchestrator converts those completed records into typed,
auditable `ConsultationMessage` events:

- consult request;
- physician fit response or redirect;
- referral requirement;
- one evidence-backed follow-up question and answer when comparison benefits;
- final recommendation synthesis.

Each message has stable sequence, sender and recipient agent identities, a
concise summary, selected structured evidence, related patient facts, and
bounded metadata. Messages do not contain model scratchpads, hidden reasoning,
tokens, or chain-of-thought. The frontend animation and consult log render these
returned events; they are not theatrical frontend-only dialogue.

## Deliberately different demo patterns

The two cases exercise different orchestration behavior through the same data
and message contracts:

- **Case 1 — Jordan Lee:** resistant hypertension plus progressive CKD creates
  an ownership question. Explicit physician rules and the renal trajectory make
  nephrology the best owner.
- **Case 2 — Maria Santos:** persistent iron-deficiency anaemia creates a
  sequencing question. Gastroenterology evaluates for an occult source first;
  haematology remains a valid downstream service if source evaluation is
  unrevealing, anaemia persists, other cell lines become abnormal, or IV iron is
  required. Its faster synthetic appointment does not supersede that sequence.

Each patient selects a bounded synthetic physician slate. National NPPES rows
remain directory-only and cannot enter consultation matching.

## Evidence hierarchy

1. Hard patient facts: diagnoses, medications, documented prior workup, and
   longitudinal renal or haematology labs.
2. Explicit physician rules: current acceptance or deferral preferences.
3. Historical-practice similarity: overlap with synthetic prior case mix, used
   only as a fit signal.
4. Operational constraints: synthetic insurance status and availability.
5. Bounded synthesis over the structured results.

Dr. Onadeko therefore remains a relevant hypertension alternative but answers
the follow-up by applying his explicit nephrology-first rule. Dr. Jung remains
the strongest fit with known BMP/UPCR requirements and eight-day synthetic
access. No recommendation is drawn from uncontrolled national-directory rows.

For Maria, Dr. Alvarez asks whether colonoscopy or upper endoscopy is documented.
The PCP agent answers that neither is documented, and the GI agent then accepts
the first referral with a concise CBC, ferritin, and iron-study requirement.
Dr. Brooks remains an appropriate haematology option despite earlier access.

## Main modules

- `backend/fhir/client.py`: source protocol and explicit source factory.
- `backend/fhir/medplum.py`: bounded client-credentials FHIR client and Medplum source.
- `backend/fhir/mapping.py`: pure FHIR R4 to `PatientRecord` mapping.
- `backend/fhir/demo.py`: stable Jordan Lee and Maria Santos resources and one
  idempotent, non-destructive seeding workflow.
- `backend/provider_network/`: NPPES identities, agent status, and local activation preferences.
- `backend/clinical/`: patient representation and candidate generation.
- `backend/agents/physician_agent.py`: deterministic physician evaluation.
- `backend/agents/conversation.py`: deliberate structured consultation messages.
- `backend/agents/orchestrator.py`: comparison and final synthesis.
- `backend/api/consult.py`: source-independent patient and consultation endpoints.

## Current boundaries

All patients, clinicians, practice histories, access, insurance, and FHIR
resources are synthetic. There is no production EHR integration, real identity
verification, scheduling, eligibility, referral submission, billing, autonomous
clinical decision-making, or patient-facing workflow.
