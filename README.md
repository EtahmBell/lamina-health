# Lamina

Lamina is a physician-agent network for specialty care. Each physician's configured agent can represent their practice and consult other physician agents around a patient. **Consult Network** is the first specialty-referral application: it creates a concise clinical representation, exchanges deliberate structured messages, and returns a grounded, inspectable recommendation.

This rebuild is intentionally different from the YC × Medplum hackathon prototype in `../lamina-og/`: there is no social feed, public agent conversation, or chatbot-first workflow. V1 is a small, deterministic demonstration using synthetic patients and physicians only—no PHI.

## Clinical demos

Lamina includes two deliberately different synthetic consultation patterns:

- **Jordan Lee — ownership:** resistant hypertension with progressive stage 3b
  CKD. The network recommends Dr. Iain Jung in nephrology, keeps hypertension
  cardiology as an alternative, and requests a current BMP and UPCR.
- **Maria Santos — sequencing:** persistent microcytic iron-deficiency anaemia
  despite oral iron, without documented prior endoscopic source evaluation. The
  network recommends gastroenterology first, even though haematology has faster
  synthetic access. Haematology remains appropriate later for persistent
  anaemia, unusual blood-count findings, or IV iron management.

Each case uses a controlled five-agent synthetic network and returns concise,
inspectable consultation messages rather than hidden reasoning.

NPPES supplies public provider identity and reserved Lamina agent identities. Medplum can supply synthetic FHIR clinical context. Lamina keeps those layers separate and supplies the physician-agent orchestration between them.

The clinician workspace has Home, Patients, Consultations, My Agent, and Physician Network. My Agent exposes the synthetic Dr. Lianne Cha profile, source-labelled facts, access boundaries, bounded calibration scenarios, and confirm/edit/reject controls for demo preference suggestions. A small Lamina-owned local SQLite record (`data/workflow.sqlite`, gitignored) holds patient open/consult recency, completed consultation results, and these demo preferences; it is separate from Medplum clinical data. Confirmed preferences are inspectable in My Agent but do not silently alter the deterministic V1 consult rules. Consultation History is populated only by completed Lamina consultations, not fixture timestamps.

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

Seed all current demo patients into the configured project:

```powershell
.\.venv\Scripts\python.exe .\scripts\seed_medplum_demo.py
```

The script upserts stable, explicitly tagged synthetic Patient, Condition,
MedicationRequest, Observation, and Coverage resources. It prints the resulting
resource IDs for Jordan Lee and Maria Santos and never deletes unrelated
resources. Running it again updates the same stable resources rather than
creating duplicates. Never put credentials in source control.

## Tests and build

```powershell
pytest
ruff check backend tests
cd frontend
npm run build
```

The core tests are deterministic and offline. They verify both FHIR/source
equivalence paths, renal and anaemia trends, specialty ownership and sequencing,
structured follow-ups, explicit-rule precedence, workup requirements, evidence
visibility, access ordering, provider-network status, and credential-free API
execution.

## HTTP demo

With the backend running:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/patients/patient-ckd-htn-001
Invoke-RestMethod -Method Post -ContentType application/json -Body '{"pcp_guidance":null}' http://127.0.0.1:8000/api/patients/patient-ckd-htn-001/consultations
Invoke-RestMethod http://127.0.0.1:8000/api/patients/patient-ida-002
Invoke-RestMethod -Method Post -ContentType application/json -Body '{"pcp_guidance":null}' http://127.0.0.1:8000/api/patients/patient-ida-002/consultations
```

## Intentionally unfinished

- Production EHR authorization and live Epic/Cerner integration.
- Persistent consultation storage and real referral submission.
- Live payer eligibility, scheduling, and availability integrations.
- LLM augmentation beyond the deterministic structured demonstration.
