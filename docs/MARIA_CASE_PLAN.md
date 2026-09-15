# Maria Santos case extension plan

The second demo case will reuse the existing `ClinicalDataSource`, strict patient
record, deterministic physician profiles, consultation result/message schemas,
Medplum client, and React workspace. The smallest required extensions are:

1. Add anaemia laboratory kinds and explicit synthetic clinical-history notes to
   the bounded patient record, then derive a Maria-specific clinical context.
2. Add one controlled Maria physician slate and select it by patient ID; keep the
   Jordan slate and its recommendation rules unchanged.
3. Extend the existing FHIR resource builder/upsert loop to seed both patients
   with stable identifiers and synthetic tags.
4. Make the current workspace, network visual, and recommendation wording depend
   on the returned patient and structured consultation events.
5. Add Maria source-equivalence, sequencing, message, access, API, and regression
   coverage, then run the existing verification workflow.

This pass does not change the clinical-data abstraction, NPPES boundary,
authentication, persistence model, or referral behavior.
