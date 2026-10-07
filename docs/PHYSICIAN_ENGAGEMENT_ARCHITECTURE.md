# Physician engagement architecture

Pass 4A introduced a shared physician-engagement domain without introducing a
permanent PCP-versus-specialist role flag. `lucy` and `iain` are controlled demo
perspectives; a physician's clinical role remains case-dependent.

Pass 5A adds structured interests, progressive initialization, persisted branching
training assignments, draft public-profile enrichment, and a generalized
professional-post contract. These remain representation systems, not referral
ranking systems.

Pass 6A makes routine calibration ternary (`Yes / Depends / No`). Initialization
and the lazy question bank are structured; `short_text` remains only as an optional
escape hatch after structured choices are exhausted. `Depends` selects a curated
child when one exists, otherwise it may request one bounded structured Responses
question and persists either that validated result or a deterministic fallback.

Pass 6B simplifies the product model to **initialize once, train forever**. A normal
session has an immutable, configurable answer target of 10. Assigned and generated
questions may outnumber the remaining cards internally, but physician-facing progress
is always `answered_count / answer_target`. A branch answer consumes the next card;
a branch opened by the final answer is saved at high priority and becomes the first
question of the next new session rather than extending the current one.

Pass 7A makes training status a single backend-owned state machine consumed by Home,
My Agent → Train, Agent Overview, and the immersive training route. The canonical
projection returns `state`, `action`, active/review session IDs, current answer count
and target, review/init flags, grounded availability, and last training time. Its
controlled mapping is:

- `initialization_needed` → `continue_setup`
- `ready` → `start_training`
- `active_unstarted` → `start_training`
- `active_in_progress` → `resume_training`
- `review_pending` → `review_training`
- `caught_up` → `none`

An active zero-answer session is ready to start, never “unfinished.” `caught_up` is
valid only when there is no usable active session, no undeferred question-complete
review, and the lazy grounded planner reports no available questions. The absence of
a currently materialized queue is not evidence that the lazy bank is exhausted.

Starting ordinary or initialization training is idempotent and always targets 10.
A valid active session is reused. A zero-answer pre-6B ordinary/init session with a
different target is normalized to 10 and replenished from the same lazy planner. A
partially answered legacy session retains its original target so physician work is
not reinterpreted or discarded. Duplicate/stale active rows are archived with
`lifecycle_state=abandoned`; response and assignment audit rows remain intact, and
abandoned recovery artifacts do not appear in user-facing completion history. If a
legacy active session has already reached its target, or has responses but no further
grounded question that can be materialized, it is completed into the normal learning-
review lifecycle rather than mislabeled as caught up.

Home current work now represents consultations and specialist case work. Legacy
case-raised `AgentLearning` preferences remain stored and deep-link compatible, but
they no longer create an ordinary Home work item. The Home agent card uses canonical
training state and confirmed Practice Representation facts; it does not use legacy
calibration counts as primary work.

## State boundaries

The public synthetic demo combines immutable synthetic base profiles with
workspace-local overlays. Profile edits, interests, training responses and branch
paths, enrichment candidates, proposed learnings, and posts never write to the shared synthetic directory,
`provider_claims`, or `provider_agent_state`.

The authenticated private physician sandbox now retains the same repository and
projection contracts through a `PhysicianOwnerScope`. Its opaque storage/physician
keys occupy the legacy-named `workspace_id`/`persona_id` columns, while the binding
to account plus owned provider claim is resolved server-side. It does not require
verification for private professional setup, never treats an NPI supplied by a
browser as authorization, and never joins demo workspace state.

Demo scope remains anonymous workspace plus controlled Lucy/Iain persona. Owner
scope remains authenticated account plus selected owned provider claim. Demo base
fixtures stay persona-specific; owner projections instead use the stored NPPES base
identity, physician-confirmed overlays/interests/learnings, and generic controlled
synthetic scenarios. Neither scope can read the other's state.

## Professional identity and practice representation

Professional Profile answers “Who am I?” using provenance-bearing structured
items. Practice Representation answers “How does my agent represent my practice?”
using explicit practice facts and confirmed learnings. Professional profile content
does not silently become a referral rule.

Training responses produce suggestions only. Confirm, Edit, or Reject is required;
only confirmed learnings appear in confirmed representation. Engagement and profile
completeness are descriptive and are not inputs to candidate generation, physician
evaluation, referral ordering, or recommendation ranking.

Interests are a separate structure with clinical, case, research, and teaching
types. “Interested in seeing this case” does not mean “accepts every such referral,”
prove expertise, or override specialty fit, an explicit not-a-fit rule, or access
constraints. A future matcher may consider a confirmed case interest only after
clinical appropriateness and explicit constraints are satisfied. Interest count,
training activity, profile completeness, publication count, and posting activity
must never become paid, popularity, or engagement boosts.

Initialization is progressive and non-blocking before first completion, then durable.
The required baseline is professional identity, basic specialty/practice context, at
least one confirmed interest, and completion of the first 10-question initialization
session. Controlled Lucy and Iain base data supplies the first three requirements.
Completion persists `initialized_at`; optional profile changes cannot reverse it. The
older six-section projection remains response-compatible for existing clients but is
not the completion rule and should not be presented as six blocking chores.

Training sessions persist assigned root and child questions with root/parent IDs,
depth, path, trigger, and priority. Deterministic priorities favor actual network
ambiguities, cases, unresolved branches, representation gaps, initialization, then
profile confirmation. Branch depth is capped at three and each session prevents
duplicates/cycles. The queue advertises capacity from lazy grounded question-source
families (network demand, cases, gaps, rules, profile/interests), so 100+ future
questions do not require loading or seeding meaningless rows.

Completing the question budget creates one proposed learning per root branch rather
than one per intermediate answer and moves the session to `questions_complete`.
Confirm, Edit, and Reject are part of that same Train experience. When all proposals
are reviewed, or the physician explicitly leaves review for later, the session moves
to `review_complete`; deferred review remains discoverable through Train/Practice.
The canonical history projection supplies counts for answers, targets, proposed and
reviewed learnings, and deferred branches without client-side reconstruction.

The controlled-demo reset endpoint deletes only the selected workspace/persona's
sessions, responses, assignments, generated/deferred questions, focused correction
seeds, persisted initialization marker, and training-derived learnings (including
confirmed ones). It preserves professional profile, interests, cases, posts, network
state, enrichment, and synthetic/practice chat history. This intentionally returns a
controlled persona to initial setup without creating a broad destructive "reset
agent" operation.

Existing rows are migrated additively. An existing session receives its previous
question limit as its answer target, including targets greater than 10; only newly
created ordinary sessions default to 10. Existing completed sessions are interpreted
as question-complete. Calibration tables, specialist calibration endpoints, proposed
learning records, and old deep links remain compatible. Calibration is now an
internal persistence concept: Train owns suggestion review, Practice exposes the
confirmed result, and chat/case corrections route back into Train.

## Agent overview, test cases, and chat

The Agent Overview is a canonical server projection of persona identity, specialty,
location, a deterministic portrait, initialization, training/activity statistics,
and one next action. Its statistics are descriptive only: answers, completed
sessions, confirmed learnings, case interests, network cases, last training, posts,
and network physicians. No quality, intelligence, visibility, referral, or ranking
score is produced. Practice Representation remains the source of truth and includes
only confirmed learnings, never pending or rejected suggestions.

Agent chat is limited to questions about the physician's represented practice and a
small persona-specific library of controlled synthetic test scenarios. Selecting a
scenario is read-only and creates no patient, case, consultation, referral, network
edge, or recommendation record. Requests explicitly marked `real_patient` are
rejected, obvious identifier-shaped free text is rejected, and no patient chart is
loaded. Supported chat is stored workspace/persona-locally only for this synthetic
and practice context; this is not a durable general-purpose clinical-chat store.

When enabled, the existing Responses API client receives a tightly bounded identity
summary, confirmed representation, allowed reference IDs, the user's question, and
optional controlled scenario facts. A structured response is accepted only when its
evidence references are within that supplied set; otherwise a deterministic response
is used. Responses distinguish represented facts from explicit uncertainty and do
not expose hidden reasoning. Overview never depends on an OpenAI call.

Synthetic-case feedback has two actions. `reflects` records feedback without learning.
`not_quite` creates a grounded focused-training seed. Starting that seed creates a
bounded session (maximum 10 answers) in the same question, branching, proposed-
learning, and review engine used by normal training; it may end as soon as the focused
boundary resolves. It does not create a parallel calibration mechanism.

Profile enrichment stores sourced candidate facts separately from confirmed profile
items. Strong identity context (name, specialty, geography, institution/NPI when
available) belongs at the enrichment boundary. An online result is never “verified”
merely because a model found it. Confirm or Edit + Confirm copies a candidate into
the workspace overlay; Reject retains an audit record.

## Updates and feed

Profile changes and confirmed learnings may create deterministic agent-drafted
posts. Existing practice-update routes are backward-compatible aliases. Posts record
physician authorship, whether the physician or Lamina agent drafted them, network
visibility, and explicit physician approval. Drafts are private until explicitly published. Feed eligibility comes from
explicit network membership or canonical agent participation in saved consultations.
Directory searches alone create no relationship. The feed is chronological and has
no popularity or activity score.

The optional Responses API boundary is backend-only, feature-gated by
`LAMINA_OPENAI_ENABLED`, `LAMINA_OPENAI_MODEL`, and `OPENAI_API_KEY`, and has
deterministic fallbacks. The legacy `LAMINA_RESPONSES_ENABLED` flag remains an
alias. Calls occur only on an explicit profile-enrichment action, an explicit
professional-post draft action, or a `Depends` answer for which no curated child
exists. There are no boot, page-load, feed-load, or ordinary Yes/No model calls.
Successful Responses-backed enrichment is reused for 30 minutes within the same
workspace/persona, and structured outputs are bounded to at most 12 candidate facts.
Structured JSON Schema output is validated before persistence; profile enrichment
uses the Responses `web_search` tool and retains public source metadata. Safe logs
record use case, success/failure, model, latency, and fallback use, never keys,
tokens, raw future PHI, or hidden reasoning. The service may format supplied facts
but may not invent claims or publish. Public-demo case posts accept only explicitly
synthetic source material; real-patient publication requires a future separate
privacy/de-identification workflow and is disabled here.

## Patients and cases

Patients are people for whom the current physician has a direct care relationship
and patient-panel access. Cases are network consultations in which the physician's
agent participated. Recommendation of Dr. Iain Jung for Jordan Lee creates a case,
not an Iain-owned patient record.

