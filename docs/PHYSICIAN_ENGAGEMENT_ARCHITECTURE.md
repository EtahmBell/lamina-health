# Physician engagement architecture

Pass 4A introduced a shared physician-engagement domain without introducing a
permanent PCP-versus-specialist role flag. `lucy` and `iain` are controlled demo
perspectives; a physician's clinical role remains case-dependent.

Pass 5A adds structured interests, progressive initialization, persisted branching
training assignments, draft public-profile enrichment, and a generalized
professional-post contract. These remain representation systems, not referral
ranking systems.

## State boundaries

The public synthetic demo combines immutable synthetic base profiles with
workspace-local overlays. Profile edits, interests, training responses and branch
paths, enrichment candidates, proposed learnings, and posts never write to the shared synthetic directory,
`provider_claims`, or `provider_agent_state`.

A future authenticated implementation can retain the same profile, representation,
training, learning, update, and feed contracts while replacing the workspace/persona
owner key with a verified active provider-claim owner key. That binding must be
resolved server-side from authentication and a verified claim; an NPI supplied by a
browser is not authorization.

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

Initialization is progressive and non-blocking. Its six projections are professional
identity, clinical focus, case interests, referral preferences, workup preferences,
and access/practice context.

Training sessions persist assigned root and child questions with root/parent IDs,
depth, path, trigger, and priority. Deterministic priorities favor actual network
ambiguities, cases, unresolved branches, representation gaps, initialization, then
profile confirmation. Branch depth is capped at three and each session prevents
duplicates/cycles. The queue advertises capacity from lazy grounded question-source
families (network demand, cases, gaps, rules, profile/interests), so 100+ future
questions do not require loading or seeding meaningless rows.

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

The optional Responses API boundary is backend-only, feature-gated, and has
deterministic fallbacks. It may format supplied facts but may not invent claims or
publish. Public-demo case posts accept only explicitly synthetic source material;
real-patient publication requires a future separate privacy/de-identification
workflow and is disabled here.

## Patients and cases

Patients are people for whom the current physician has a direct care relationship
and patient-panel access. Cases are network consultations in which the physician's
agent participated. Recommendation of Dr. Iain Jung for Jordan Lee creates a case,
not an Iain-owned patient record.

