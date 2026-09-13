# Legacy NPPES directory audit

This audit was completed before the current Lamina repository was modified. The
reference implementation is `../lamina-og/lamina-starter` and remains read only.

## What exists in the legacy project

- `src/lamina_directory/download_nppes.py` discovers and downloads the latest
  monthly CMS NPPES V2 archive.
- `src/lamina_directory/download_taxonomy.py` downloads the NUCC taxonomy CSV.
- `src/lamina_directory/build_directory.py` streams the NPPES CSV in chunks,
  keeps active individual providers, and filters taxonomy codes to the NUCC
  “Allopathic & Osteopathic Physicians” grouping.
- The builder preserves NPI as text, selects a marked primary physician taxonomy
  (falling back to the first physician taxonomy), normalizes practice-location
  fields, creates one reserved agent identity per physician, and populates an
  SQLite FTS5 index after bulk ingestion.
- `sql/schema.sql` stores directory identity separately from agent claims,
  configuration, audit events, forum content, organizations, and Medplum links.
- `api/main.py` exposes physician search/profile endpoints plus claim, synthetic
  demo verification, configuration, readiness, activation, and pause endpoints.
- `frontend/src/components/PhysiciansPage.tsx`, `ClaimAgentFlow.tsx`, and
  `AgentSetupPage.tsx` implement the old search and activation experience.
- `scripts/build-demo.ps1` and `scripts/build-all.ps1` orchestrate directory
  refreshes; the full builder reads the provider CSV directly from the archive.

The inspected snapshot contains 1,262,313 NPPES physician records and 1,262,313
reserved directory-agent identities. The downloaded archive and generated
SQLite database are intentionally ignored by Git.

## Reuse or adapt directly

- NPI remains an opaque string.
- The existing read-only `physicians`, `agents`, and `physician_fts` schema is a
  useful import boundary and can be queried without migrating the 772 MB file.
- NUCC physician-only filtering, NPI active/reactivated filtering, primary
  taxonomy selection, and post-load indexes are sound ingestion choices.
- Public NPPES provenance and the default reserved/unactivated status are kept
  explicit.
- Stable agent identity is derived from NPI, but loading an identity does not
  create a running model or imply physician participation.

## Rewrite cleanly in the current architecture

- A provider-network domain service owns directory search, Lamina physician
  profiles, agent status, activation preferences, and practice footprints.
- The public lifecycle is reduced to `reserved`, `verification_pending`,
  `verified`, `active`, and `disabled`.
- Demo activation state is a local overlay; the NPPES database remains read only.
- Search and profile API responses expose only useful directory fields, not raw
  NPPES rows or legacy forum permissions.
- Controlled synthetic consult physicians share the provider-network identity
  abstraction, while the consult engine keeps its existing eligibility and
  practice-footprint controls.

## Discard

- Forum posts, responses, social connections, public posting flags, monitoring,
  reports, and publication settings are outside the current product.
- The hackathon email/code interaction is not identity verification and is not
  presented as such.
- Imported NPPES physicians cannot be demo-verified or activated. A claim may be
  placed into `verification_pending`, but only explicitly synthetic profiles can
  complete the local demo flow.
- NPPES directory data is never stored in Medplum, sent to consultation models,
  or made automatically eligible for clinical recommendations.

## Runtime boundary

The new adapter opens the SQLite index in read-only mode. It checks
`LAMINA_NPPES_DATABASE`, then a current-repository `data/processed/lamina.sqlite`
location, and finally the sibling legacy snapshot as a local migration bridge.
Production deployments should set `LAMINA_NPPES_DATABASE` explicitly and run the
audited ingestion pipeline outside the application process.
