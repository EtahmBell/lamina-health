# Legacy audit

Scope inspected: `../lamina-og/lamina-starter/` and its relationship to the vendored `../lamina-og/medplum/` tree. The legacy tree was treated as read-only.

## Reusable

- **FastAPI and typed request models:** the prototype validates API boundaries with Pydantic and tests endpoints through FastAPI's test client. V1 preserves those conventions.
- **Bounded clinical-data interface:** `api/medplum.py` defines a `Protocol` for Medplum access and normalizes Patient, Condition, MedicationRequest, and Observation resources into a small case context. V1 preserves the interface boundary with `ClinicalDataSource` and a deterministic synthetic implementation.
- **Synthetic-data guardrails:** the old Medplum adapter checks explicit synthetic tags, limits searches and response sizes, uses stable identifiers, and scopes patient access to a practitioner panel. These are useful requirements for a future adapter.
- **Privacy-minded context reduction:** legacy tests verify that opaque patient references and bounded clinical facts reach downstream services instead of names or raw FHIR identifiers. Preserve that approach when a production-backed source is added.
- **Frontend toolchain:** React, TypeScript, and Vite remain an appropriate lightweight stack. Only the toolchain and general API-client pattern were retained, not the feed UI.
- **Testing discipline:** mocked HTTP transports and credential-free test paths are strong patterns worth carrying forward.

## Rewrite

- **Backend composition:** the old `api/main.py` combines directory search, identity claims, organizations, feeds, approval workflows, Medplum, monitoring, and referral suggestions in one large module. The new backend separates clinical representation, candidate generation, physician evaluation, orchestration, fixtures, and HTTP routing.
- **Agent abstraction:** the legacy OpenAI layer is designed around generating forum drafts and monitoring responses. Consult Network needs small structured physician evaluations governed by explicit practice rules, so this was rebuilt as deterministic domain logic for V1.
- **Referral logic:** the old recommendation path infers a specialty and ranks directory records using exact text match, network activity, connection status, and location. V1 instead compares physician practice footprints against the patient's clinical trajectory and makes the evidence hierarchy visible.
- **Physician model:** NPPES directory rows and agent-claim state are not a practice footprint. The new synthetic profile explicitly represents focus areas, current referral rules, workup, synthetic case mix, insurance, location, and availability.
- **Persistence:** the legacy SQLite schema is dominated by forum and directory concerns. V1 deliberately returns an inspectable consultation record without introducing a database; persistence can be added when requirements are known.
- **Authentication and organizations:** legacy demo identity and organization membership are tightly coupled to old workflows. V1 omits authentication rather than copying demo authorization into a new product shape. Production authorization remains future work.
- **Configuration:** keep narrowly scoped environment variables and fail safely when future integrations are enabled. V1's local synthetic path requires none.

## Discard

- Social feed, posts, responses, publication inbox, connections, and public agent conversation UX.
- Voice dictation and Deepgram integration for creating posts.
- Agent monitoring that drafts responses to newly published posts.
- Claim-agent and physician social-profile flows.
- Feed-oriented OpenAI prompts, publication provenance, and approval schemas.
- NPPES bulk ingestion in the core demo. It may later support discovery, but directory metadata alone is not sufficient for grounded referral fit.
- The vendored full Medplum source tree, deployment Terraform, tunnels, and production infrastructure. V1 only needs a clean future adapter seam.

## Secret-reference review

Legacy source and example configuration reference credentials for services including Medplum, OpenAI, and Deepgram. No credential values were copied or printed during the audit. The new repository includes placeholders only in `.env.example`, ignores `.env`, and does not require any of these services for its core flow.

