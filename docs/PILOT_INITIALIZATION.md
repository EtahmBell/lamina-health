# Pilot initialization and practice representation (Step 17)

Goal: a newly approved physician finishes a short guided setup (5–10 minutes for a first useful
version) and leaves with an agent that *represents* how they practise, in **shadow mode**: it
recommends; people decide. This step builds the representation and the data foundation Step 18
(readiness review + physician-approved activation) relies on. It does not add activation, new
autonomy, briefings, publishing changes, or any integration.

## Reused (unchanged in role)

| Piece | Where | Role in Step 17 |
|---|---|---|
| NPI lookup, self-attestation, practice setup, approval gate | `physician_onboarding.py`, `pilot/practice.py` | Stage A starts from this; nothing re-asked |
| **Canonical rule store** (`physician_referral_preferences`, versioned rows, `supersedes_id`, immutable content) | `pilot/rules.py` | The ONE store for every representation statement. No parallel store. |
| Teaching parser (per-item windows, negation, exceptions) | `pilot/teaching.py` | Stage B/C natural-language answers; chat teaching |
| Proposal → confirm/edit/reject lifecycle (`operational_status` inferred → confirmed / rejected) | `pilot/teaching.py` | Every setup answer is a *proposal* until the physician confirms it |
| Canonical referral types + aliases | `pilot/vocabulary.py`, `rules.resolve_type` | Stage B type list and matching |
| Correction learning + one-question-a-day limit | `pilot/learning.py` | Pending learnings (extended with one new pattern) |
| Recommendations, decisions, carry-overs, events (append-only) | `pilot/store.py`, `pilot/intake.py` | Linkage for Step 18 agreement metrics |

## Extended

* **Rule content** (`PracticeRuleContent`, additive optional fields — old rows load unchanged):
  `scope_policy` (`accept` / `out_of_scope` / `case_by_case`, absent = legacy rule ⇒ accept),
  `preferences` (soft, free text), `exceptions` (“unless…” notes), `judgment` (decisions the
  physician keeps), `make_optional` (a proposal that demotes a required item), and
  `answered_topics` (which questions were answered — so “nothing required” ≠ “unknown”).
* **Rule layers** via a new `layer` column (+ `owner_scope_id`): `practice` (all existing rows)
  and `physician` (one physician's own statements). Both keep `scope='practice'`: the demo already
  uses `scope='physician'` for its own rows (with legacy-sync triggers), and only `scope='practice'`
  rows get the content-immutability trigger. Triage merges both layers for that physician's referrals.
* **Triage** applies `scope_policy`, merges layers with explicit precedence, surfaces layer
  conflicts, and records `statements_used` (kind, rule, version, layer) and the
  representation version on every recommendation.
* **Teaching** stores exceptions in `exceptions`, keeps negations as notes, and supports the
  new kinds when confirming/merging.
* **Learning** gains one pattern: “accepted N referrals while item X was missing → make X
  optional?” Still a proposal, still rate-limited.
* **Assistant** gets a `representation` read tool and cites statement kind + version.
* **Your Agent**: the Teach tab becomes **Train** (same route); Overview shows lifecycle,
  representation summary, and a learned-this-week panel from one backend source.

## New

* `backend/pilot/representation.py` — `RepresentationService`: lifecycle, guided-setup state,
  statement view (kinds, layers, status, unknowns, conflicts), versioned snapshots, the
  learned-this-week summary (single source of truth for every count), and decision linkage.
* `frontend/src/PilotSetup.tsx` — stages A–E, resumable, each skippable.
* API: `/api/me/practice/representation/*` (see `pilot/api.py`).

## Statement kinds → storage → effect

| Kind | Stored as | Drives |
|---|---|---|
| Hard requirement | `required[]` (per-item `freshness_days`) | Deterministic readiness |
| Scope policy | `scope_policy` + `good_fit[]` / `redirect[]` criteria | Deterministic fit |
| Soft preference | `modality` (suggested only) + `preferences[]` | Suggestion text only; never blocks |
| Exception | `exceptions[]` | Nothing (reviewable note) until restructured and confirmed |
| Physician judgment | `judgment[]`; policy `case_by_case` | Conversation; `case_by_case` flags physician review |
| Unknown | *derived*: a type/topic with no confirmed answer | Assistant says it doesn't know |

Status: **proposed** = `inferred` row, **confirmed** = `confirmed` row, **rejected** =
`rejected`, **unknown** = derived (or a proposal the physician chose to “leave unknown”).
Only confirmed rows reach triage (unchanged rule). Visibility: private; publication reads only
explicit public fields of practice-layer rules the physician marked publishable.

## Precedence

* Practice layer = whole practice; edited by the practice admin (the physician who created the
  practice — `practices.created_by_user_id`). Physician layer = edited by that physician.
* A physician-layer `make_optional` of a practice requirement applies only if the practice
  setting `allow_physician_loosening` is on; otherwise it is a **conflict**, shown in review and
  in the recommendation rationale, and the practice requirement stays required.
* Differing scope policies between layers are a **conflict**: triage does not pick one; fit is
  unknown, physician review is required, and the conflict is cited.

## Data model changes (all additive, created on startup)

* `physician_referral_preferences.layer TEXT NOT NULL DEFAULT 'practice'` and `.owner_scope_id TEXT`.
* Rule content JSON gains optional fields (old rows load unchanged): `scope_policy`, `preferences`,
  `exceptions`, `judgment`, `make_optional`, `answered_topics` (and Step 16's `aliases`).
* `practices.allow_physician_loosening INTEGER DEFAULT 0`.
* `triage_recommendations.representation_version_id TEXT` (set on insert; table stays append-only).
* `agent_lifecycle` — `(practice_id, owner_scope_id)` → `state` (`initializing` | `shadow`),
  `setup_json` (stage status + Stage A profile + Stage D delegation), timestamps.
  Existing physicians with confirmed rules start in `shadow`; others in `initializing`.
* `representation_versions` — append-only snapshots: version, content hash, snapshot JSON,
  `reason` (`confirmed_by_physician` | `triage`), created by/at. A version is recorded when the
  physician confirms the representation, and whenever triage finds the confirmed representation
  differs from the latest version — so every recommendation points at the exact version it used.

## Delegation (Stage D) — preferences only

Tasks: check completeness · draft missing-information requests · summarise referrals · flag
out-of-scope referrals. For each: who usually handles it (physician / staff / agent prepares for
review) and desired eventual autonomy (off / observe only / prepare drafts for review / ask me
before acting). Stored for Step 18; **nothing is enabled**. No option allows autonomous clinical
decisions or autonomous external sending.

## Out of scope here

Readiness review UI, capability activation, briefings, public-agent preview/publishing,
email/calendar/fax/EHR/Medplum, scheduling, network.
