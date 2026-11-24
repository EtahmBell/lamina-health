# Readiness review and physician-approved activation (Step 18)

After shadowing, a physician sees an honest comparison of the agent's recommendations with
their own decisions, then turns on specific capabilities, one at a time, and can pause or revoke
them at any time. Trust is earned capability by capability: never by a timer, never by one
master switch. Eligibility only *allows* the physician to turn something on; nothing turns on
by itself.

## Data model (all additive, created on startup)

| Table | Kind | Purpose |
|---|---|---|
| `capability_states` | current state (updatable) | `(practice_id, owner_scope_id, capability)` → `state` (`off` / `shadow` / `active`), `config_json` (e.g. excluded referral types, question frequency), who/when, representation version at the change |
| `capability_events` | **append-only** (triggers) | every activation, return to shadow, turn-off, pause-all, practice-maximum change, flag, flag resolution and automatic return — actor, role, time, representation version, reason |
| `practice_capability_limits` | current setting | an admin's practice-wide maximum per capability (`off` / `shadow` / `active`) |
| `agent_prepared_items` | append-only (triggers) | what the agent prepared, per capability: `mode` `shadow` (**never shown to referring offices, never sent** — recorded only for the review) or `active` (the real draft it created, linked by id) |
| `agent_item_flags` | flag rows; resolution columns only | "This was wrong" on an agent-prepared item; `serious` (physicians only); resolved by a physician |

A missing `capability_states` row means the capability's **default** (below). Nothing about the
existing sign-off, correction, conflict or recommendation tables changes.

## Agreement metrics (physician decisions only)

Source: `referral_signoffs` (one per decided referral, `actor_role = 'physician'`, storing the
agent's recommendation at that moment, the effective triage after corrections, and the
representation version). Only the physician whose agent it is (`actor = user:<their id>`) is
counted. **Excluded**: staff reviews and every row of the retired approval step
(`recommendation_decisions`), carry-overs, and anything without a sign-off.

| Dimension | Agent said (`recommendation_json`) | Physician did | Agree / disagree / deferred |
|---|---|---|---|
| **Fit** | `fit` | accept / redirect / decline | see mapping below |
| **Priority** | `suggested_priority` | final `suggested_priority` in `effective_triage_json` (after corrections) | agree if equal, else disagree |
| **Visit type** | `suggested_modality` | final `suggested_modality` (after corrections) | agree if equal; `unspecified` from the agent = deferred |
| **Readiness** | `missing_items` on the referral's **first** recommendation | items the team later asked for beyond that list (`information_requested.extra_items`), or an accept while the agent still listed required items missing | agree if neither happened; otherwise disagree ("asked for more" / "accepted without") |

**Fit mapping** (explicit):

| Agent fit | Accept | Redirect | Decline |
|---|---|---|---|
| strong | agree | disagree | disagree |
| possible | agree | *possible → redirected* | *possible → declined* |
| outside_scope | disagree | agree | agree |
| **needs judgment** (`unknown`, or the physician's own *case by case* policy) | deferred | deferred | deferred |

Deferred items are shown with their own count and are never part of "agreed on N of M".
*Possible → declined/redirected* (decision of 2026-11-22) is also outside "agreed on N of M": a
"possible fit" leaves room for a decline, so it is neither agreement nor a hard disagreement. It
has its own count and its own list under the disagreements, never mixed into them.

**Conflict choices** (`correction_conflict_resolutions`, physician only): "Keep my correction"
= the physician still disagrees with the newer rule; "Apply the rule" = the rule change resolved
the earlier disagreement. Shown as their own row, with counts.

**Segmentation**: by referral type and by representation version. Two windows:
*since your current rules* (sign-offs made against the current representation version) and
*all time*. **Small numbers**: raw counts always ("agreed on 3 of 4"); a percentage only when
the denominator ≥ `LAMINA_REVIEW_MIN_FOR_PERCENT` (default 10). **No overall score.**

**Disagreement list**: every disagreement links to its referral with what the agent
recommended, what the physician did, the rule + version involved (from the recommendation's
rules snapshot), and whether a learning has since been proposed or confirmed from it (a
correction-pattern proposal whose evidence includes that referral).

Reproducible: `python -m scripts.activation_metrics --practice <id> --owner <owner_scope_id>`
recomputes the same numbers read-only from the database.

## Readiness (per capability)

A capability is **eligible for review** only when all hold:

1. **Shadow period** ≥ `LAMINA_READINESS_MIN_SHADOW_DAYS` (default 3), counted from
   `agent_lifecycle.shadow_at` — not signup.
2. **Volume** ≥ `LAMINA_READINESS_MIN_DECIDED` (default 10) physician-decided referrals overall,
   and ≥ `LAMINA_READINESS_MIN_PER_TYPE` (default 3) for each referral type it will act on.
   Types below that are **coverage gaps** ("not enough cases yet"); the capability can be turned
   on with them excluded (stored in `config_json.excluded_types`).
3. **No unresolved serious flag** on that capability, and no unresolved flag among those behind an
   automatic return to shadow (three non-serious flags in 7 days). Each is resolved by the
   physician **with a note** (`POST /activation/flags/{id}/resolve {note}`; stored in
   `agent_item_flags.resolution_note`); the review marks them "needs resolving".
4. **No open conflict** in the representation it depends on (layer conflicts in the confirmed
   representation).

The review always says why: "Needs 4 more decided referrals", "2 days of shadowing left".

## Capability registry (only what exists in code)

| Key | Name | Risk | States | Default | What it does when active | Never does |
|---|---|---|---|---|---|---|
| `auto_draft_requests` | Draft missing-information requests | low | off / shadow / active | shadow | On triage with required items missing and no open request, creates the **draft** in the staff queue, attributed to "Dr. X's agent" | send anything; staff review and send |
| `learning_questions` | Ask one learning question | low | off / active | active (today's behaviour) | Asks at most one question a day (or week) about a repeated pattern | change any rule without the physician's answer |

Left out: **pre-filling visit type and priority** — the agent's suggested priority/visit type
already *is* the working triage shown on the referral (there is no separate set of referral
fields to pre-fill), so there is nothing separable to gate.

**Always yours** (never activatable here): accept / redirect / decline; sending any message
outside Lamina; scheduling; confirming rules or representation statements.
**Coming later** (no toggles): daily briefings, email/fax, waitlist and scheduling.

**Gating is in the backend**: the triage hook checks the stored state before doing anything —
`off` does nothing, `shadow` writes only a shadow record, `active` creates the draft. The learning
question source returns nothing when the capability is off.

Who controls what: a physician controls **their own** agent's capabilities (a non-admin
physician included); staff see a read-only view; a practice admin sets practice-wide maximums
that no physician can exceed (lowering a maximum lowers anyone above it, recorded, and each
affected physician gets a Home item until they acknowledge it; the admin isn't told about their
own agent).

## Safety

* **Pause everything**: one action returns every active capability to shadow, recorded.
* **Per capability**: turn off or return to shadow individually.
* **"This was wrong"**: physicians and staff can flag an agent-prepared item; a physician can
  mark it **serious**, which returns that capability to shadow at once and adds a Home item
  saying why. Non-serious flags appear in the review. **Three non-serious flags on one
  capability within 7 days** (counted since it was last turned on) also return it to shadow,
  with a Home item explaining why; the physician acknowledges it ("Got it"). Physicians still
  mark serious flags explicitly. Nothing is silently ignored.
* **Status**: an agent-drafted request does **not** change the referral's status. It shows
  "Triaged · draft request ready for staff" until staff send the request, then "Needs
  information". The history reads "Information request drafted by Dr. X's agent (not sent)".
  (A request staff draft themselves still moves the referral to "Needs information" as before.)
* **Staff "Ready" with required items open**: allowed only after a confirmation that names them
  (the API refuses unless `confirm_missing` names every one). Items still missing and items
  received but not yet verified (office-reported, or possibly in a document) are listed
  separately ("Still missing: …", "Received, not verified: TSH"), and both are recorded in the
  history event and the hand-off note (`missing_items`, `unverified_items`).
* Agreement keeps being measured while capabilities are active.

## Screens

* **Your Agent → Readiness** (physician): a short summary at the top (status, what's eligible
  and what isn't yet with every reason, one recommended action that jumps to the right section)
  · notices about changes the physician didn't make · status line · what the agent observed (by type, gaps)
  · how its recommendations compared with your decisions (per dimension, raw counts, current
  rules / all time) · where you disagreed (links) · open questions and pending learnings ·
  capability cards (state, eligibility and reasons, what it will / will never do, shadow
  examples, Turn on / Keep in shadow / Turn off with a confirmation that restates the change)
  · always yours · coming later.
* **Your Agent → Capabilities** (staff, read-only): what is active, what it does, and who made
  the last change ("Last changed by …").
* **Home**: "Your agent's readiness review is available" once something is eligible; a
  capability returned to shadow by a serious flag or by repeated flags; a capability lowered by
  a practice limit.
* **Lifecycle line**: "Shadow mode" / "Partly active · 1 capability on".
* Auto-drafted requests show "Drafted by Dr. X's agent" and a "This was wrong" control.
