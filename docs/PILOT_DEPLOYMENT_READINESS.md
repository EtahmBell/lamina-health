# Pilot deployment readiness (go-live prep, run 2)

What exists in code after run 2, and what remains before the pilot can hold real patient data.
**Nothing has been deployed and no cloud resources exist.** Every check below was run locally with
synthetic data; AWS was only ever mocked (moto, stub clients).

## 1. What the code now enforces

| Area | In code | How it is checked |
|---|---|---|
| Profiles | `LAMINA_PROFILE` = `dev` \| `e2e` \| `production` (`backend/profiles.py`) | `create_app` refuses to start in production with any problem below |
| Database | Postgres via `LAMINA_DATABASE_URL`; schema and every guarantee in Alembic migrations (`backend/migrations`) | production refuses SQLite or a URL without TLS; the app refuses a database not at the migration head |
| Append-only audit | PL/pgSQL triggers (no UPDATE/DELETE/TRUNCATE) **and** privileges (`lamina_app` has no UPDATE/DELETE/TRUNCATE on those tables) | `tests/test_database_postgres.py` |
| Documents | `S3DocumentStorage`: SSE-KMS on every object, private bucket, presigned GET ≤ 5 min after the practice check | production refuses local storage; at startup it refuses a bucket without a full public-access block or SSE-KMS default encryption |
| Model provider | `openai` \| `bedrock` \| `disabled` behind one interface; `LAMINA_MODEL_PATIENT_DATA_APPROVED` | production refuses an unapproved provider at startup, and any patient-data call to one at runtime |
| Test/dev switches | e2e test sign-in, MFA exemptions, fictional NPPES, dev outbox, debug flags | production refuses any of them |
| Secrets | from the environment only (inject from AWS Secrets Manager) | in production the repo `.env` is never read, and its presence is refused |
| Identity | Supabase JWT (JWKS) + TOTP MFA (`aal2`) on every pilot route | production requires `LAMINA_SUPABASE_MFA_TOTP_ENABLED=true` (an operator attestation) |

Verified locally on Postgres 16.4 (container from `docker-compose.dev.yml`, loopback only): the
migrations reach head with 36 tables and 43 triggers; every pilot test runs on its own database
cloned from a migrated template; e2e runs on `lamina_e2e`, dropped and re-migrated each run.

## 2. Model-provider feature audit

What the code calls, per provider, and what is not something to rely on under a BAA.

### Call sites

| Call site | Use case | Carries patient data | Gate |
|---|---|---|---|
| `backend/pilot/assistant.py` plan | practice agent: turn planning (message + referral index with patient names) | **yes** | production refuses unless approved |
| `backend/pilot/assistant.py` compose | practice agent: phrasing the answer over referral facts | **yes** | same |
| `backend/pilot/public_agent.py` | public practice page Q&A (an office may type patient details) | **yes** | same; also off unless `LAMINA_PILOT_PUBLIC_AGENT_LLM_ENABLED` |
| `backend/pilot/triage.py` evidence extraction | quotes from referral documents | **yes** | same; also off unless `LAMINA_PILOT_LLM_EXTRACTION_ENABLED` |
| `backend/pilot/teaching.py` interpretation | turning a physician's rule ("I need an A1c…") into a structured rule | declared **no** | runs with any provider (see residual risk) |
| `backend/professional_services.py`, `referral_preferences.py`, `referrals/coordination_chat.py` | **demo only** (synthetic personas) | no | never runs in pilot mode |

Every pilot call site declares `contains_patient_data` explicitly (a test fails if one is missing).

### OpenAI (Responses API) — features used and not used

| Feature | Used? | Notes |
|---|---|---|
| Responses API, structured outputs (`text.format` json_schema) | **yes**, all calls | the only endpoint the code calls |
| Stored responses (`store`, default on) | **no, now off**: every call sends `store=False` | before run 2 the calls used the default, so responses were stored by the provider |
| Conversations / `previous_response_id` | no | the pilot keeps its own history (`agent_messages`, 30-day retention) |
| Files, uploads, vector stores, file search | no | referral documents never leave Lamina except as page text in extraction |
| Hosted tools: **web search** | demo only (`ProfileEnrichmentService`, public physician info) | refused on any patient-data call by the provider layer; never in pilot mode |
| Assistants/threads, batch, background mode, code interpreter, fine-tuning, embeddings, images, realtime | no | — |

**Not to rely on under a BAA (gated or removed):** stored responses (now off everywhere),
conversation state, files/vector stores, and hosted tools such as web search (never with patient
data; demo only). Which OpenAI endpoints and features a BAA / zero-data-retention arrangement covers
is per account and per feature — **confirm in writing with OpenAI** that the Responses API with
`store=false` and structured outputs is covered for this account before setting
`LAMINA_MODEL_PATIENT_DATA_APPROVED=true` with the `openai` provider.

### Anthropic Claude on Amazon Bedrock

| Feature | Used? | Notes |
|---|---|---|
| Converse API (system + one user message) | yes | structured output via one forced tool whose input schema is the JSON schema |
| Tool use | yes (that one forced tool) | no external tool runs; the "tool" is only the output shape |
| Bedrock Agents, Knowledge Bases, Guardrails, batch inference, prompt caching | no | — |
| Model invocation logging (account setting) | must stay **off**, or go to a KMS-encrypted, access-restricted bucket | otherwise prompts (with PHI) are logged |

Bedrock is covered by the AWS BAA (confirm it is on the current *HIPAA Eligible Services
Reference* for the region, and that the chosen Claude model is offered in that region).

### Residual risks
* Teaching interpretation is declared non-patient-data; a physician could still type identifiers
  into a rule. Either route it like patient data (simplest: approved provider only) or keep the
  model off for it (`LAMINA_MODEL_PROVIDER=disabled` until approved).
* Model output is never stored as a fact without the existing validators; that is unchanged.

## 3. AWS services (HIPAA-eligible only)

Use only services on the current AWS *HIPAA Eligible Services Reference*, under an executed AWS
BAA (AWS Artifact). Proposed:

| Need | Service | Configuration |
|---|---|---|
| API runtime | Amazon ECS on AWS Fargate | private subnets; task role (no static keys); image from ECR |
| Database | Amazon RDS for PostgreSQL 16 (Multi-AZ) | encryption at rest (KMS), TLS required (`sslmode=verify-full`), automated backups + PITR, no public access; app user is a member of `lamina_app` only |
| Documents | Amazon S3 | one private bucket; Block Public Access (all four); default SSE-KMS with a customer-managed key; versioning; access logging; bucket policy denying non-TLS |
| Keys | AWS KMS | customer-managed keys for RDS and S3; key policy limited to the task role |
| Secrets | AWS Secrets Manager | injected as environment variables into the task (never files) |
| Model | Amazon Bedrock (Anthropic Claude) | invocation logging off; VPC endpoint |
| Ingress | Application Load Balancer + AWS Certificate Manager (+ AWS WAF) | HTTPS only |
| Logs / audit | Amazon CloudWatch Logs (KMS-encrypted), AWS CloudTrail | the app logs metadata only (no prompts, tokens, links) |
| Network | VPC with private subnets, VPC endpoints for S3, Secrets Manager, Bedrock, ECR, Logs | no NAT path needed for AWS APIs |
| Email (when added) | Amazon SES | only behind `MailSender`, after a BAA review |

The frontend is static (Vite build) and holds no PHI; host it on S3 + CloudFront or keep the
current host — it must still send only HTTPS API calls and never cache API responses.

## 4. Supabase

* Authentication → **Multi-Factor Authentication: TOTP enabled** (the API rejects sessions
  without `aal2`; users can't enrol if TOTP is off). Then set `LAMINA_SUPABASE_MFA_TOTP_ENABLED=true`.
* Sign-ups stay enabled (invitees create their own accounts); Lamina enforces invite-only.
* Email confirmation on; Redirect URLs allow-list: the app origin's `/me/join` and `/me`.
* Sessions: set an inactivity timeout and a time-box in addition to the app's idle sign-out.
* **BAA:** Supabase holds account emails and auth metadata. Decide whether that is ePHI for this
  pilot; if it is (or to be safe), use Supabase's HIPAA offering under a signed BAA — confirm the
  plan and terms with Supabase.

## 5. Environment variables (production)

| Variable | Required | Notes |
|---|---|---|
| `LAMINA_PROFILE` | yes | `production` |
| `LAMINA_PRODUCT_MODE` | yes | `pilot` |
| `LAMINA_DATABASE_URL` | yes | `postgresql://…?sslmode=verify-full` (app user; secret) |
| `LAMINA_DOCUMENT_STORAGE` | yes | `s3` |
| `LAMINA_S3_BUCKET`, `LAMINA_S3_KMS_KEY_ID`, `AWS_REGION` | yes | |
| `LAMINA_MODEL_PROVIDER` | yes | `bedrock`, `openai` or `disabled` |
| `LAMINA_MODEL_PATIENT_DATA_APPROVED` | if a provider is set | `true` only with a signed BAA covering that provider |
| `LAMINA_BEDROCK_MODEL_ID` | if bedrock | |
| `OPENAI_API_KEY`, `LAMINA_OPENAI_MODEL` | if openai | secret |
| `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE` | yes | https |
| `LAMINA_SUPABASE_MFA_TOTP_ENABLED` | yes | `true` after checking the project setting |
| `LAMINA_PILOT_ADMIN_USER_IDS` | yes | Lamina operators (allow-list) |
| `LAMINA_CORS_ORIGINS`, `LAMINA_PUBLIC_APP_URL` | yes | https origins |
| `LAMINA_PILOT_LLM_EXTRACTION_ENABLED`, `LAMINA_PILOT_PUBLIC_AGENT_LLM_ENABLED` | optional | off unless the provider is approved |
| Never set | — | `LAMINA_E2E*`, `LAMINA_DEV_FAKE_NPPES`, `LAMINA_DEBUG`, `DEBUG`, `LAMINA_WORKFLOW_DATABASE`, `LAMINA_PILOT_DOCUMENT_DIR`, `LAMINA_MAIL_ADAPTER=dev` |

## 6. BAA checklist

- [ ] **AWS** BAA executed (AWS Artifact) for the account; every service used is on the HIPAA
      Eligible Services Reference.
- [ ] **Model provider**: Bedrock (covered by the AWS BAA — confirm Bedrock and the model/region),
      or OpenAI BAA / zero-data-retention confirmed in writing for the Responses API with
      `store=false`. Only then `LAMINA_MODEL_PATIENT_DATA_APPROVED=true`.
- [ ] **Supabase**: decision on whether auth data is ePHI; HIPAA offering + BAA if so.
- [ ] **Email provider** (when information requests are emailed): BAA before any patient detail
      leaves through `MailSender`.
- [ ] **Hosting of the frontend**: no PHI; confirm no API response caching.
- [ ] Each BAA's breach-notification terms recorded in the incident runbook.

## 7. Still to do before go-live

1. Provision (infrastructure as code, reviewed): VPC, RDS, S3 + KMS, ECS, ALB/ACM/WAF, Secrets
   Manager, CloudWatch, CloudTrail, Bedrock access. **Not done** (no cloud resources were created).
2. Database roles: migration user (owner) vs app login user (member of `lamina_app` only).
3. Run `alembic upgrade head` from a one-off task; then, if pilot data exists in SQLite,
   `python -m scripts.migrate_sqlite_to_postgres --sqlite <file> --dry-run`, then without
   `--dry-run` (integrity + foreign-key check of the source, counts and SHA-256 per table, rolled
   back on any mismatch; the target must be empty and at the migration head). The SQLite store's
   own one-time startup upgrades (sender-token scrub, rule-author backfill, column additions) run
   on the source *before* it is copied; Postgres starts at the migration head and never holds
   pre-fix data, so those upgrades have no Postgres equivalent and are tested on an explicit
   SQLite store (`sqlite_pilot` fixture). The operator scripts `scripts/activation_metrics.py`
   and `scripts/check_rule_keys.py` read Postgres (`LAMINA_DATABASE_URL`) in a read-only session.
4. Bucket: Block Public Access, SSE-KMS default, versioning, access logs, TLS-only policy; the app
   refuses to start otherwise.
5. Supabase settings above; Supabase admin user ids for `LAMINA_PILOT_ADMIN_USER_IDS`.
6. Backups and restore drill (RDS PITR, S3 versioning); retention policy for documents and
   `agent_messages`.
7. Monitoring: 5xx/latency alarms; alert on `PatientDataNotApprovedError` and on refused starts.
8. A penetration test and a review of `docs/PILOT_PHI_READINESS.md` against this list.
9. Operator runbook: MFA reset (remove the factor in the Supabase dashboard after an out-of-band
   identity check), deactivation, invitation hygiene.
