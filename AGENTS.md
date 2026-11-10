# Lamina product and engineering rules

These instructions apply to all work in this repository.

## Two product modes — read this first

Lamina runs in exactly one of two modes, selected by `LAMINA_PRODUCT_MODE`
(backend) and `VITE_LAMINA_PRODUCT_MODE` (frontend build). Unknown backend values
fail at startup; they never fall back.

| | `demo` (default) | `pilot` |
|---|---|---|
| Purpose | Synthetic YC/investor demonstration | Real authenticated specialist-practice pilot |
| Users | Anonymous cookie workspaces (Lucy, Chen, Iain personas) | Supabase-authenticated physicians and invited staff |
| Data | Synthetic fixtures only, never PHI | Real practice data; PHI only under the deployment assumptions in `docs/PILOT_PHI_READINESS.md` |
| Backend routes | Every demo router (`backend/main.py: DEMO_ROUTERS`) | Onboarding, internal pilot approval/metrics, `/api/me/practice/*`, and `/api/public/p|r/*` (`PILOT_ROUTERS`) |
| Frontend | Existing demo `App` routes | `PilotApp` (`frontend/src/Pilot.tsx`) only |
| Code | `backend/` demo modules, `frontend/src/*` demo surfaces | `backend/pilot/`, `frontend/src/Pilot.tsx`, `pilotApi.ts`, `pilotState.ts` |

Rules that keep the modes separate:

- Pilot code (`backend/pilot/`, `Pilot.tsx`, `pilotApi.ts`, `pilotState.ts`) must never import
  or reference synthetic/demo data: `backend.synthetic_data`, `backend.demo_identity`,
  `backend.demo_workspace`, `backend.fhir`, `backend.clinical`, `backend.engagement`,
  `PERSONAS`, `DEMO_PATIENTS`, `physician-chen`, Lucy/Chen/Iain/Tonjit identifiers, or seeded
  demo referral state. Static tests enforce this (`tests/test_pilot_foundation.py`,
  `frontend/test/pilotFoundation.test.mjs`). An empty pilot practice shows empty states —
  never fixture fallbacks.
- Pilot referrals are `backend.pilot.models.IntakeReferral`, not the demo `Referral`, and never
  require a `ClinicalDataSource` patient: a real referral can arrive for a patient Lamina has
  never seen.
- Do not change demo behavior while building pilot features. If a shared module must change
  (for example `backend/workflow.py`), make it additive and keep every existing demo test green.
- Demo mode remains synthetic, isolated, and labeled as such. Never add real PHI to demo code,
  fixtures, tests, or seed scripts.

## Product

- Lamina is agent-first, not chat-only. The physician's (and, in pilot, the practice's)
  persistent agent is the primary product object. Structured workflow surfaces remain important
  for reviewing context, actions, and state.
- The agent works on the physician's behalf and surfaces only what it cannot or should not finish
  alone. Conversation is one way in, never a replacement for structured referral and patient screens.
- Demo: `Consult Network` remains the core synthetic workflow (patient context → relevant physician
  agents → inspectable recommendation). Keep the demo small and strong.
- Pilot: the core workflow is specialist referral intake triage — practice fit, readiness, missing
  information, priority, modality, physician-required flag, next step — NOT diagnosis or treatment.
- Pilot shadow mode: observe → recommend → physician/staff correct → agent learns. Consequential
  actions (sending messages, accepting/declining referrals, contacting patients, moving
  appointments, sharing PHI externally, finalizing handoffs) require explicit human action. The
  agent may automatically read permitted data, classify, summarize, prepare drafts, and flag gaps.
- Do not add a social feed, physician posts, or broad network discovery in either mode.
- Public referral-facing agent conversations are allowed **in pilot mode only**, and only from
  explicitly published practice information (internal representation → explicit publication layer
  → public practice representation → public agent). Never expose internal rules, unpublished
  preferences, or any patient data publicly. Implemented in `backend/pilot/publication.py`
  (versioned immutable snapshots) and `backend/pilot/public_agent.py` (snapshot-only, deterministic
  by default). Unauthenticated routes live only in `backend/pilot/public_api.py`.
- Do not introduce time-series language models (TSLMs) unless explicitly requested.

## Clinical data and claims

- Demo uses synthetic data only and labels synthetic patients, physicians, histories, availability,
  and network data clearly.
- Pilot may hold real PHI only once the checklist in `docs/PILOT_PHI_READINESS.md` is satisfied for
  the deployment. Until then, use test data. Never claim a deployment is HIPAA-ready unless it is.
- Never commit PHI, uploaded documents (`data/pilot_documents/`), local databases, or `.env` files.
- Physician-specific claims must be grounded in supplied practice data (demo: practice footprints;
  pilot: the practice's own confirmed rules).
- Evidence hierarchy: patient facts, explicit physician rules, historical-practice similarity,
  operational constraints, then bounded inference. Explicit rules override inferred preferences.
- Historical case similarity is a fit signal, not proof of physician quality.
- Recommendations must be inspectable: show the facts, rules (with version), documents (with page),
  constraints, and conclusions used. Never expose hidden chain-of-thought.
- LLMs may assist extraction, reasoning, and orchestration but must not be the sole source of
  truth. In pilot triage an LLM may only *propose* evidence with a verbatim, page-cited quote; it
  never marks a requirement satisfied and never moves workflow state. Unknown → missing / needs a human.
- Sending referral documents to a model provider is a PHI disclosure: it stays behind
  `LAMINA_PILOT_LLM_EXTRACTION_ENABLED` (default off) and requires a BAA/zero-retention agreement.

## Identity, verification, and access (pilot)

- Supabase authenticates users; FastAPI verifies the JWT and derives the account only from `sub`.
  Never accept a user id, practice id, owner-scope id, NPI-as-authority, or role from the client.
- NPPES lookup is identity *discovery*; "This is me" is *self-attestation*; Lamina pilot approval is a
  *manual gate*. None is credentialing. Product copy says "Confirm your professional profile", not
  "verified". Keep room for stronger verification later.
- One active claim per NPI and per account (DB-enforced). Practice membership roles are `physician`
  (full access) and `staff` (intake and triage review; no rule edits, membership changes, identity
  changes, publication, or final accept/redirect/decline). Staff inherit the practice's approval gate.
- All practice-scoped routes go through `backend/pilot/api.py: require_practice`.

## Pilot workflow integrity

- Intake status transitions are explicit (`backend/pilot/intake.py: ALLOWED_TRANSITIONS`) and applied
  with an optimistic status check in one transaction with their decision row and events.
- Triage recommendations, recommendation decisions, and `pilot_events` are append-only (DB triggers).
- `physician_referral_preferences` is the ONE operational rule store triage reads. Practice rules use
  `scope='practice'`; their content is immutable per row — edits create a new version with
  `supersedes_id`. Every recommendation stores the exact rules snapshot it used. Do not add a second
  rule source for triage; legacy learning tables stay intact and are not read by pilot triage.
- Emit a `pilot_events` row for every meaningful pilot action (see `docs/PILOT_FOUNDATION.md`).
- External messages leave Lamina ONLY through `MissingInformationService.approve_and_send` after a
  human approval; the model never sends anything. Real email providers go behind `MailSender`
  (`backend/pilot/messaging.py`) and need a BAA first.
- Teaching and correction learning only ever create `inferred` proposals; a physician confirms.
  Unstructured instructions stay notes and can never be confirmed as rules.
- `scripts/dev_pilot_server.py` (fictional NPPES) is for local trials only; never deploy it.

## Clinical interoperability (demo)

- Keep NPPES provider identity separate from Medplum/FHIR patient context.
- Consultation code consumes only the bounded `ClinicalDataSource` interface; never pass raw FHIR
  resources or credentials to physician agents.
- The default clinical source must remain deterministic and offline. An explicitly configured
  Medplum source must fail visibly rather than silently falling back.
- Medplum demo resources must be tagged synthetic, use stable identifiers, and be upserted without
  deleting unrelated resources.
- Consultation messages are deliberate structured records, not hidden reasoning.

## Engineering

- Keep domain logic separate from API and UI code.
- Prefer simple, interpretable implementations and avoid unnecessary dependencies.
- Core tests must be deterministic, run offline, and require no production credentials. Run them
  with `LAMINA_OPENAI_ENABLED=false` if your local `.env` enables a model.
- Keep FHIR/Medplum behind a bounded clinical-data interface; never expose credentials or raw FHIR
  records to models.
- Do not commit `.env` files, credentials, local databases, uploaded documents, generated artifacts,
  or sensitive data.
- The sibling `../lamina-og/` tree is read-only reference material. Never modify it.
