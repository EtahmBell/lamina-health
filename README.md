# Lamina

Lamina is a specialty-care orchestration product built around one primary action: **Consult Network**. From a patient chart, Lamina creates a concise clinical representation, asks relevant physician agents to evaluate fit using their practice footprints, and returns a grounded, inspectable recommendation.

This rebuild is intentionally different from the YC × Medplum hackathon prototype in `../lamina-og/`: there is no social feed, public agent conversation, or chatbot-first workflow. V1 is a small, deterministic demonstration using synthetic patients and physicians only—no PHI.

## Primary demo

The included 62-year-old synthetic patient has resistant hypertension on three medications, diabetes, and a creatinine/eGFR trajectory consistent with progressive stage 3b CKD. Five synthetic physician agents respond differently. The network recommends Dr. Mina Jung in nephrology, places Dr. Tayo Onadeko in hypertension cardiology as a reasonable alternative, rejects electrophysiology as a poor fit, and requests a current BMP and UPCR before referral.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain flow and [docs/LEGACY_AUDIT.md](docs/LEGACY_AUDIT.md) for migration decisions.

## Requirements

- Python 3.11+
- Node.js 20+

No API key, database, network connection, Medplum project, or production credential is required after dependencies are installed.

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

## Tests and build

```powershell
pytest
ruff check backend tests
cd frontend
npm run build
```

The core tests are deterministic and offline. They verify patient parsing, renal decline, resistant hypertension, candidate coverage, structured physician outputs, explicit-rule precedence, the expected recommendation and alternative, workup requirements, evidence visibility, and credential-free API execution.

## HTTP demo

With the backend running:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/patients/patient-ckd-htn-001
Invoke-RestMethod -Method Post -ContentType application/json -Body '{"pcp_guidance":null}' http://127.0.0.1:8000/api/patients/patient-ckd-htn-001/consultations
```

## Intentionally unfinished

- Production Medplum/FHIR adapter and real EHR authorization.
- Persistent consultation storage and real referral submission.
- Live payer eligibility, scheduling, and availability integrations.
- LLM augmentation and a second demo case.

