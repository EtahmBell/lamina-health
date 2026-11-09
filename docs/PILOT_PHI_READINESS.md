# Pilot PHI readiness

**Status: the current deployment is NOT approved for real PHI.** The pilot code is
architected for PHI-safe operation (authenticated, practice-scoped access, private
document storage, append-only audit events, no PHI to models by default), but the
infrastructure below must be in place — with signed BAAs where noted — before any
real patient referral is entered. Until then, use test data only.

## Infrastructure audit

| Dependency | Today (repo as built) | What must change before real PHI |
|---|---|---|
| **Hosting (API)** | Any Python host; local `uvicorn`. Frontend has a `vercel.json`. | HIPAA-eligible host with a signed BAA (e.g. AWS/GCP/Azure under BAA, Aptible, or an equivalent). TLS everywhere, private networking, no PHI in request logs. Vercel serves only the static frontend bundle (no PHI passes through it) — confirm no edge functions/logging touch API traffic. |
| **Database** | SQLite file (`data/workflow.sqlite`) shared with workflow/claims; WAL-less, single writer. | Encrypted-at-rest volume under BAA, automated encrypted backups with tested restore, single-writer deployment (one API worker) or migration to managed Postgres under BAA (Supabase Postgres requires the HIPAA add-on + BAA). Restrict file permissions; never on ephemeral disk. |
| **File storage** | Local disk `data/pilot_documents/` (`LAMINA_PILOT_DOCUMENT_DIR`), random keys, never statically served, downloads only via authenticated practice-checked route with `no-store`. | Encrypted volume or private object bucket under BAA (S3 with SSE-KMS + BAA, GCS + BAA); bucket access logging; no public ACLs; lifecycle/retention policy agreed with the practice. Implement `DocumentStorage` for the bucket (interface already exists). |
| **Model provider** | OpenAI Responses API, off by default. Pilot document extraction is behind a **separate** flag `LAMINA_PILOT_LLM_EXTRACTION_ENABLED` (default `false`). Pilot triage is fully deterministic without it. | Only enable extraction after a BAA + zero-data-retention agreement with the provider (OpenAI offers BAAs for eligible API customers; alternatives: Azure OpenAI or Anthropic via a HIPAA-eligible cloud under BAA). Keep `LAMINA_OPENAI_ENABLED` off in pilot unless the same agreement covers it. Never send documents to web-search tools. |
| **Auth** | Supabase Auth (email/password); JWT verified in FastAPI. Stores emails, not PHI. | Supabase BAA (HIPAA add-on) recommended since accounts identify clinicians at a practice; enforce MFA for pilot accounts; set session/refresh lifetimes; disable public sign-up if invite-only is preferred. |
| **Email provider** | None. No email is sent by Lamina in this pass (information requests are drafted, not sent). | Before the missing-information send loop: a provider under BAA (e.g. Paubox, AWS SES under BAA) or send only PHI-free notifications with authenticated links. |
| **Logging / observability** | Python logging to stdout; the AI client logs metadata only (use case, latency, model). Pilot events store IDs and metadata, not clinical text. | Log sink under BAA (or none); scrub request bodies; no APM that captures payloads unless under BAA; alerting on 5xx; access-log retention policy. Frontend: no third-party analytics on pilot pages. |
| **NPPES** | Public CMS API for physician lookup (no PHI sent). | None (public directory data only). |

## Controls already implemented

- Authenticated, server-derived access: account → membership → practice; no client-supplied IDs.
- Manual pilot approval gate preserved; staff inherit it; disabled physicians lose access immediately.
- Practice isolation on every read/write (cross-practice IDs return 404).
- Private document storage: magic-byte type check, 15 MB cap, random storage keys, sanitized
  filenames, attachment downloads with `no-store` and a sandbox CSP; `document_viewed` events.
- Append-only `pilot_events`, `triage_recommendations`, `recommendation_decisions` (DB triggers).
- Invitation and sender-status tokens stored only as SHA-256 hashes.
- Model never moves workflow state or satisfies a requirement; extraction off by default.
- `data/pilot_documents/` and `*.sqlite` are gitignored.

## Before-PHI checklist

- [ ] BAAs signed: hosting, database/storage, Supabase (if used for PHI-adjacent data), any model
      provider used, email provider (when added), log sink.
- [ ] Production deployment on encrypted storage with automated, tested backups.
- [ ] Document storage moved to a BAA-covered private bucket or encrypted volume.
- [ ] Single API worker (SQLite) or migration to managed Postgres; in-process throttles reviewed.
- [ ] HTTPS only; `LAMINA_CORS_ORIGINS` limited to the pilot frontend origin.
- [ ] MFA enforced for pilot accounts; pilot admin allow-list (`LAMINA_PILOT_ADMIN_USER_IDS`) set.
- [ ] `LAMINA_OPENAI_ENABLED=false` and `LAMINA_PILOT_LLM_EXTRACTION_ENABLED=false` unless covered.
- [ ] Request-body logging disabled everywhere; log retention defined.
- [ ] Practice agreement (BAA between Lamina and the practice), data retention and deletion terms,
      breach-notification process, and an access-review cadence.
- [ ] Risk assessment (HIPAA Security Rule) documented for the pilot deployment.
