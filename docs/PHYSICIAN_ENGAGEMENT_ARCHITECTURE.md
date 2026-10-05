# Physician engagement architecture

Pass 4A introduces a shared physician-engagement domain without introducing a
permanent PCP-versus-specialist role flag. `lucy` and `iain` are controlled demo
perspectives; a physician's clinical role remains case-dependent.

## State boundaries

The public synthetic demo combines immutable synthetic base profiles with
workspace-local overlays. Profile edits, training responses, proposed learnings,
and practice updates never write to the shared synthetic directory,
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

## Updates and feed

Profile changes and confirmed learnings may create deterministic agent-drafted
updates. Drafts are private until explicitly published. Feed eligibility comes from
explicit network membership or canonical agent participation in saved consultations.
Directory searches alone create no relationship. The feed is chronological and has
no popularity or activity score.

## Patients and cases

Patients are people for whom the current physician has a direct care relationship
and patient-panel access. Cases are network consultations in which the physician's
agent participated. Recommendation of Dr. Iain Jung for Jordan Lee creates a case,
not an Iain-owned patient record.

