# Lamina

Lamina is a specialty-care orchestration product built around one primary action: **Consult Network**. From a patient chart, Lamina creates a concise clinical representation, asks relevant physician agents to exchange deliberate structured consult messages using their practice footprints, and returns a grounded, inspectable recommendation.

This rebuild is intentionally different from the YC × Medplum hackathon prototype in `../lamina-og/`: there is no social feed, public agent conversation, or chatbot-first workflow. V1 is a small, deterministic demonstration using synthetic patients and physicians only—no PHI.

## Primary demo

The included 62-year-old synthetic patient has resistant hypertension on three medications, diabetes, and a creatinine/eGFR trajectory consistent with progressive stage 3b CKD. Five synthetic physician agents respond differently. The network recommends Dr. Mina Jung in nephrology, places Dr. Tayo Onadeko in hypertension cardiology as a reasonable alternative, rejects electrophysiology as a poor fit, and requests a current BMP and UPCR before referral.

NPPES supplies public provider identity and reserved Lamina agent identities. Medplum can supply synthetic FHIR clinical context. Lamina keeps those layers separate and supplies the physician-agent orchestration between them.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain flow, [docs/NPPES_LEGACY_AUDIT.md](docs/NPPES_LEGACY_AUDIT.md) for provider-network decisions, and [docs/MEDPLUM_CONVERSATION_AUDIT.md](docs/MEDPLUM_CONVERSATION_AUDIT.md) for this pass's interoperability decisions.

## Requirements

- Python 3.11+
- Node.js 20+

No API key, database, network connection, Medplum project, or production credential is required for the default offline synthetic mode after dependencies are installed.

## Install

From this directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
cd frontend
npm install
```

On macOS/Linux, activate with `source .venv/bin/activate`.

## Run

Backend, from the repository root:

```powershell
uvicorn backend.main:app --reload
```

Frontend, in another terminal:

```powershell
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173`, review the synthetic patient, and click **Consult Network**. **View Consultation** expands the structured conclusions and evidence; **Start Referral** is deliberately a local demo action and performs no external write.

The frontend defaults to `http://127.0.0.1:8000`. To change it, create `frontend/.env` with `VITE_API_BASE_URL`. Allowed development origins can be configured with `LAMINA_CORS_ORIGINS`; see `.env.example`.

## Synthetic Medplum / FHIR mode

The default is explicit offline fixture mode:

```text
LAMINA_CLINICAL_SOURCE=synthetic
```

To use a Medplum development project, copy `.env.example`, set
`LAMINA_CLINICAL_SOURCE=medplum`, and configure `MEDPLUM_BASE_URL`,
`MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET`, and `MEDPLUM_PROJECT_ID`.
`MEDPLUM_TOKEN_URL` and `MEDPLUM_FHIR_BASE_URL` may override the conventional
Medplum endpoints. The application reports a configured Medplum failure; it
does not silently substitute local fixtures.

Seed Jordan Lee into the configured project:

```powershell
.\.venv\Scripts\python.exe .\scripts\seed_medplum_demo.py
```

The script upserts stable, explicitly tagged synthetic Patient, Condition,
MedicationRequest, Observation, and Coverage resources. It prints the resulting
resource IDs and never deletes unrelated resources. Never put credentials in
source control.

## Tests and build

```powershell
pytest
ruff check backend tests
cd frontend
npm run build
```

The core tests are deterministic and offline. They verify FHIR mapping and source equivalence, patient parsing, renal decline, resistant hypertension, candidate coverage, structured physician messages and follow-up, explicit-rule precedence, the expected recommendation and alternative, workup requirements, evidence visibility, provider-network status, and credential-free API execution.

## HTTP demo

With the backend running:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/patients/patient-ckd-htn-001
Invoke-RestMethod -Method Post -ContentType application/json -Body '{"pcp_guidance":null}' http://127.0.0.1:8000/api/patients/patient-ckd-htn-001/consultations
```

## Intentionally unfinished

- Production EHR authorization and live Epic/Cerner integration.
- Persistent consultation storage and real referral submission.
- Live payer eligibility, scheduling, and availability integrations.
- LLM augmentation and a second demo case.
