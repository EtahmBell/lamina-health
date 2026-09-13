# Medplum and consultation-message audit

This audit was completed before implementation. The legacy project under
`../lamina-og/` was inspected read only.

## Current Lamina state

- `backend/fhir/client.py` already defines the correct narrow boundary:
  `ClinicalDataSource.get_patient(patient_id) -> PatientRecord | None`.
  Only `SyntheticClinicalDataSource` exists today.
- `backend/api/consult.py` owns a concrete synthetic source at module scope.
  The consult domain receives a `PatientRecord` and is otherwise independent of
  FHIR, which is the boundary to preserve.
- Jordan Lee is a strict local fixture containing identity, diagnoses,
  medications, longitudinal creatinine/eGFR observations, insurance, and
  location.
- Physician agents return strict, structured `PhysicianEvaluation` records.
  The orchestrator ranks those evaluations and synthesizes the result, but it
  does not yet persist or return first-class consultation messages.
- The NPPES/provider-network package is separate from clinical data. Synthetic
  consult identities reference controlled practice footprints; national NPPES
  rows are not consult eligible.

## Useful legacy Medplum patterns

- Explicit environment-derived base, token, FHIR, client, secret, project, and
  timeout settings.
- OAuth client-credentials authentication with bounded token caching.
- `application/fhir+json`, bounded response size, safe error categories, and a
  single retry after a read receives HTTP 401.
- A mandatory synthetic tag on every demo clinical resource.
- Stable identifiers and search-before-create upserts for idempotent seeding.
- Patient-subject searches limited to Condition, MedicationRequest, and
  Observation, followed by exact subject and synthetic-tag checks.
- Separation between Medplum clinical data and the SQLite NPPES directory.

## Legacy code not carried forward

- Organization membership, practitioner panels, forum exports, monitoring, and
  publication flows are unrelated to the current patient-consult workflow.
- Raw FHIR resources and credentials are not exposed to the frontend,
  physician agents, or recommendation code.
- The application will not silently substitute local fixtures when an explicit
  Medplum source fails.

## Smallest implementation

1. Add a pure FHIR R4 mapper and `MedplumClinicalDataSource` behind the current
   protocol. Select it only when `LAMINA_CLINICAL_SOURCE=medplum`; keep
   `synthetic` as the deterministic offline default.
2. Seed Jordan Lee with stable synthetic identifiers using Patient, Condition,
   MedicationRequest, Observation, and Coverage. Never delete or overwrite
   unrelated resources.
3. Add a typed `ConsultationMessage` list to `ConsultationResult`. Generate
   deliberate messages from patient facts, explicit physician rules,
   structured evaluations, workup, and access data—not model scratchpads.
4. Preserve current evaluation and ranking behavior. Add one deterministic
   follow-up to make Dr. Onadeko’s nephrology-first rule explicit, followed by
   a synthesis message.
5. Animate the existing network visualization from returned message events and
   render a compact clinical-consult log inside the existing transparency view.

