import { useEffect, useState } from 'react'
import { ApiError } from './api.ts'
import {
  getActivation, pauseAllCapabilities, resolveAgentFlag, setCapabilityLimit, setCapabilityState,
  type ActivationReview, type AgreementDimension, type AgreementTally, type AgreementWindow, type CapabilityState, type CapabilityView,
} from './pilotApi.ts'
import { pilotErrorCopy, pilotPaths } from './pilotState.ts'
import { useOnPilotDataChange } from './pilotSync.ts'
import { PageError, PageLoading } from './pilotUi.tsx'

/* Step 18: the readiness review (physician) and a read-only capability view (staff).
 * Language: "recommendations", "your decisions", "agreed on N of M" -- nothing that grades the agent
 * or claims it is clever. Eligible only ALLOWS turning something on; nothing turns on by itself. */

type Navigate = (path: string) => void
const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const formatDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const DIMENSIONS: Array<{ key: AgreementDimension; label: string; help: string }> = [
  { key: 'fit', label: 'Fit', help: 'Its fit call against your accept, redirect or decline' },
  { key: 'priority', label: 'Priority', help: 'Its priority against the priority you kept (after any correction)' },
  { key: 'visit_type', label: 'Visit type', help: 'Its visit type against the one you kept (after any correction)' },
  { key: 'readiness', label: 'Readiness', help: 'The items it flagged as missing against what was later asked for or accepted without' },
]
const STATE_LABELS: Record<CapabilityState, string> = { off: 'Off', shadow: 'Shadow', active: 'On' }
const DIMENSION_WORDS: Record<AgreementDimension, string> = { fit: 'Fit', priority: 'Priority', visit_type: 'Visit type', readiness: 'Readiness' }
// Stored values in plain words (never a raw code on screen).
const VALUE_WORDS: Record<string, string> = {
  strong: 'a strong fit', possible: 'a possible fit', outside_scope: 'out of scope', unknown: 'needs your judgment',
  accept: 'accepted', redirect: 'redirected', decline: 'declined',
  routine: 'routine', soon: 'soon', urgent: 'urgent',
  in_person: 'in-person', econsult: 'eConsult', either: 'either', unspecified: 'not specified',
}
const plain = (value: string | null) => (value ? VALUE_WORDS[value] ?? value : '—')

function Tally({ tally }: { tally: AgreementTally }) {
  // Raw counts always; a percentage only when the denominator is big enough to mean something.
  return <span>{tally.text}{tally.percent !== null ? ` (${tally.percent}%)` : ''}{tally.deferred ? <span className="muted-note"> · {tally.deferred} left to your judgment</span> : null}</span>
}

export function ReadinessTab({ physician, doctor, navigate }: { physician: boolean; doctor: string; navigate: Navigate }) {
  const [review, setReview] = useState<ActivationReview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [windowKey, setWindowKey] = useState<'current_rules' | 'all_time'>('current_rules')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const load = () => { getActivation().then((data) => { setReview(data); setError('') }).catch((err) => setError(errorText(err, 'Could not load the readiness review'))) }
  useEffect(load, [])
  useOnPilotDataChange(load)
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError('')
    try { await action(); setConfirming(null); load() } catch (err) { setActionError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  if (error && !review) return <PageError title="Couldn’t open the readiness review" detail={error} onRetry={load} />
  if (!review) return <PageLoading label="Opening the readiness review…" />
  if (!review.available) return <p className="agent-empty-note">The readiness review opens once {physician ? 'your agent is' : `${doctor}’s agent is`} set up.</p>

  if (!physician) {
    // Staff: what is on and what it does. No controls.
    return <div className="pilot-readiness pilot-readiness-staff">
      <p className="page-intro">What {doctor}’s agent is allowed to do. Only {doctor} can change this.</p>
      <p className="pilot-readiness-status">{review.status?.line ?? 'Shadow mode'}</p>
      <div className="pilot-capability-list">{review.capabilities.map((cap) => <section key={cap.key} className="pilot-card pilot-capability">
        <div className="pilot-section-head"><h3>{cap.name}</h3><span className={`pilot-capability-state state-${cap.state}`}>{STATE_LABELS[cap.state]}</span></div>
        <p>{cap.description}</p>
        {cap.updated_at && <p className="muted-note">Last changed {formatDate(cap.updated_at)} (only {doctor} or a practice limit can change it)</p>}
        {cap.state === 'active' && cap.key === 'auto_draft_requests' && <p className="muted-note">Drafts it creates appear in your queue as “Drafted by {doctor}’s agent”. You review, edit and send them — it never sends anything.</p>}
        <p className="muted-note"><strong>Never:</strong> {cap.never.join('; ')}.</p>
      </section>)}</div>
      <AlwaysYours review={review} doctor={doctor} />
    </div>
  }

  const metrics = review.metrics!
  const view: AgreementWindow = metrics[windowKey]
  const gaps = review.capabilities.find((cap) => cap.key === 'auto_draft_requests')?.eligibility?.coverage.gaps ?? []
  const active = (review.status?.active ?? []).length > 0
  return <div className="pilot-readiness">
    <section className="pilot-readiness-head" aria-label="Status">
      <p className="pilot-readiness-status">{review.status?.shadow_since ? `Shadow mode since ${formatDate(review.status.shadow_since)}` : 'Not in shadow mode yet'} · {review.status?.decided ?? 0} referral{review.status?.decided === 1 ? '' : 's'} you’ve decided{active ? ` · ${review.status?.line}` : ''}</p>
      {active && <button className="button-secondary" disabled={busy} onClick={() => void act(pauseAllCapabilities)}>Pause everything</button>}
    </section>
    {actionError && <p className="error-banner" role="alert">{actionError}</p>}

    <section className="pilot-readiness-section" aria-labelledby="readiness-observed">
      <h2 id="readiness-observed">What your agent observed</h2>
      {Object.keys(metrics.all_time.by_type).length === 0
        ? <p className="agent-empty-note">No decided referrals yet. Your agent compares its recommendations with your decisions once you accept, redirect or decline referrals.</p>
        : <table className="pilot-readiness-table"><thead><tr><th scope="col">Referral type</th><th scope="col">You decided</th><th scope="col">Coverage</th></tr></thead>
          <tbody>{Object.entries(metrics.all_time.by_type).map(([type, row]) => <tr key={type}><th scope="row">{type}</th><td>{row.decided}</td>
            <td>{gaps.includes(type) ? <span className="pilot-gap">Not enough cases yet</span> : 'Enough to review'}</td></tr>)}</tbody></table>}
    </section>

    <section className="pilot-readiness-section" aria-labelledby="readiness-compared">
      <div className="pilot-section-head"><h2 id="readiness-compared">How its recommendations compared with your decisions</h2>
        <div className="pilot-segmented" role="group" aria-label="Which decisions">
          <button className={windowKey === 'current_rules' ? 'active' : ''} aria-pressed={windowKey === 'current_rules'} onClick={() => setWindowKey('current_rules')}>Since your current rules</button>
          <button className={windowKey === 'all_time' ? 'active' : ''} aria-pressed={windowKey === 'all_time'} onClick={() => setWindowKey('all_time')}>All time</button>
        </div></div>
      <p className="muted-note">{view.decided} decided referral{view.decided === 1 ? '' : 's'} in this view. Counts are shown as they are; a percentage appears once there are at least {metrics.min_for_percent} to compare. There is no overall score.</p>
      {windowKey === 'current_rules' && metrics.all_time.decided > view.decided && <p className="muted-note">Decisions made under earlier versions of your rules are under “All time” — a rule change can settle an earlier disagreement.</p>}
      <table className="pilot-readiness-table"><thead><tr><th scope="col">What it recommended</th><th scope="col">Compared with your decisions</th></tr></thead>
        <tbody>{DIMENSIONS.map((dimension) => <tr key={dimension.key}><th scope="row">{dimension.label}<small className="muted-note">{dimension.help}</small></th><td><Tally tally={view.dimensions[dimension.key]} /></td></tr>)}
          <tr><th scope="row">Your correction vs a newer rule<small className="muted-note">When a rule changed after you corrected a referral</small></th>
            <td>{metrics.conflict_choices.keep_correction + metrics.conflict_choices.apply_rule === 0 ? 'none yet'
              : `kept your correction ${metrics.conflict_choices.keep_correction} time${metrics.conflict_choices.keep_correction === 1 ? '' : 's'} · applied the rule ${metrics.conflict_choices.apply_rule} time${metrics.conflict_choices.apply_rule === 1 ? '' : 's'}`}</td></tr></tbody></table>
      {Object.keys(view.by_type).length > 1 && <details className="pilot-readiness-by-type"><summary>By referral type</summary>
        <table className="pilot-readiness-table"><thead><tr><th scope="col">Type</th>{DIMENSIONS.map((dimension) => <th key={dimension.key} scope="col">{dimension.label}</th>)}</tr></thead>
          <tbody>{Object.entries(view.by_type).map(([type, row]) => <tr key={type}><th scope="row">{type}</th>{DIMENSIONS.map((dimension) => <td key={dimension.key}><Tally tally={row[dimension.key]} /></td>)}</tr>)}</tbody></table></details>}
    </section>

    <section className="pilot-readiness-section" aria-labelledby="readiness-disagreed">
      <h2 id="readiness-disagreed">Where you disagreed</h2>
      {metrics.disagreements.length === 0
        ? <p className="agent-empty-note">No disagreements yet.</p>
        : <ul className="pilot-disagreements">{metrics.disagreements.slice(0, 20).map((item) => <li key={`${item.referral_id}-${item.dimension}`}>
          <button type="button" className="text-button" onClick={() => navigate(pilotPaths.referral(item.referral_id))}>{item.patient_name ?? 'Referral'} · {item.referral_type}</button>
          <span><strong>{DIMENSION_WORDS[item.dimension]}:</strong> it recommended {plain(item.agent_said)}; you {item.dimension === 'fit' ? '' : 'kept '}{plain(item.physician_did)}</span>
          <small className="muted-note">{item.rule ? `${item.rule.referral_type} rule v${item.rule.version}` : 'No rule'}{item.current ? '' : ' · under earlier rules'}{item.learning ? ` · a learning was ${item.learning.status} from this` : ''}</small>
        </li>)}</ul>}
    </section>

    {(review.open?.questions ?? 0) + (review.open?.pending_learnings ?? 0) > 0 && <section className="pilot-readiness-section" aria-labelledby="readiness-open">
      <h2 id="readiness-open">Open questions and pending learnings</h2>
      <p>{review.open?.questions ?? 0} question{review.open?.questions === 1 ? '' : 's'} and {review.open?.pending_learnings ?? 0} pending learning{review.open?.pending_learnings === 1 ? '' : 's'} are waiting for you. <button type="button" className="text-button" onClick={() => navigate(pilotPaths.agentTab('teach'))}>Review them →</button></p>
    </section>}

    <section className="pilot-readiness-section" aria-labelledby="readiness-capabilities">
      <h2 id="readiness-capabilities">What your agent may do</h2>
      <p className="muted-note">Off: it does nothing. Shadow: it notes privately what it would have done, for this review. On: it prepares the work for a person to review. Drafting is turned on only by you, separately; nothing else turns on with it. You can pause or turn anything off at any time.</p>
      <div className="pilot-capability-list">{review.capabilities.map((cap) => <CapabilityCard key={cap.key} cap={cap} busy={busy}
        confirming={confirming === cap.key} onConfirm={() => setConfirming(cap.key)} onCancel={() => setConfirming(null)}
        onSet={(state, extra) => void act(() => setCapabilityState(cap.key, { state, ...extra }))}
        onResolve={(flagId) => void act(() => resolveAgentFlag(flagId))} />)}</div>
    </section>

    <AlwaysYours review={review} />
    {review.can_set_limits && <PracticeLimits review={review} busy={busy} onSet={(key, state) => void act(() => setCapabilityLimit(key, state))} />}
  </div>
}

function CapabilityCard({ cap, busy, confirming, onConfirm, onCancel, onSet, onResolve }: {
  cap: CapabilityView; busy: boolean; confirming: boolean; onConfirm: () => void; onCancel: () => void
  onSet: (state: CapabilityState, extra?: { confirm?: boolean; frequency?: 'daily' | 'weekly' }) => void; onResolve: (flagId: string) => void
}) {
  const eligibility = cap.eligibility
  const canActivate = cap.states?.includes('active') && cap.practice_limit === 'active'
  const openFlags = (cap.flags ?? []).filter((flag) => !flag.resolved_at)
  return <section className="pilot-card pilot-capability" aria-labelledby={`cap-${cap.key}`}>
    <div className="pilot-section-head"><h3 id={`cap-${cap.key}`}>{cap.name}</h3><span className={`pilot-capability-state state-${cap.state}`}>{STATE_LABELS[cap.state]}</span></div>
    <p>{cap.description}</p>
    {eligibility?.always_available && cap.state === 'active' && !cap.updated_at && <p className="muted-note">On by default — this is how your agent already worked. Turn it off or change how often here.</p>}
    {eligibility && !eligibility.always_available && <div className="pilot-eligibility">
      {eligibility.eligible
        ? <p><strong>Eligible to turn on.</strong> That allows it; it stays as it is until you choose.</p>
        : <><p><strong>Not eligible yet:</strong></p><ul>{eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
      {eligibility.coverage.gaps.length > 0 && <p className="muted-note">Not enough cases yet (fewer than {eligibility.coverage.min_per_type} decided): {eligibility.coverage.gaps.join(', ')}.{eligibility.eligible ? ' If you turn it on, these types are left out.' : ''}</p>}
    </div>}
    {cap.practice_limit && cap.practice_limit !== 'active' && <p className="muted-note">Your practice allows this up to “{STATE_LABELS[cap.practice_limit]}”.</p>}
    <div className="pilot-capability-scope">
      <div><p className="practice-subheading">What it will do</p><ul>{cap.will.map((line) => <li key={line}>{line}</li>)}</ul></div>
      <div><p className="practice-subheading">What it will never do</p><ul>{cap.never.map((line) => <li key={line}>{line}</li>)}</ul></div>
    </div>
    {(cap.shadow_examples ?? []).length > 0 && <div className="pilot-shadow-examples">
      <p className="practice-subheading">In shadow, it would have drafted</p>
      <ul>{(cap.shadow_examples ?? []).map((example) => <li key={`${example.recommendation_id}`}>{example.patient_name ?? 'A referral'} ({example.referral_type}): asking for {example.items.join(', ')} <small className="muted-note">· {formatDate(example.created_at)} · not sent, not shown to anyone outside the practice</small></li>)}</ul>
    </div>}
    {(cap.flags ?? []).length > 0 && <div className="pilot-capability-flags">
      <p className="practice-subheading">“This was wrong” flags</p>
      <ul>{(cap.flags ?? []).map((flag) => <li key={flag.id}>{flag.serious ? <strong>Serious · </strong> : null}{flag.note ?? 'No note'} <small className="muted-note">· by {flag.actor_role} · {formatDate(flag.created_at)}{flag.resolved_at ? ' · resolved' : ''}</small>
        {flag.serious && !flag.resolved_at && <button type="button" className="text-button" disabled={busy} onClick={() => onResolve(flag.id)}>Mark resolved</button>}</li>)}</ul>
    </div>}
    {confirming
      ? <div className="pilot-panel pilot-capability-confirm" role="group" aria-label={`Turn on ${cap.name}`}>
        <p><strong>Turn on {cap.name.toLowerCase()}?</strong> {cap.confirm_text}</p>
        {(eligibility?.coverage.gaps.length ?? 0) > 0 && <p className="muted-note">Left out: {eligibility?.coverage.gaps.join(', ')} (not enough cases yet).</p>}
        <p className="muted-note">Recorded with your name, the time and your current rules. You can return it to shadow or turn it off at any time.</p>
        <div className="pilot-actions"><button className="button-primary" disabled={busy} onClick={() => onSet('active', { confirm: true })}>Turn on</button><button className="button-secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
      </div>
      : <div className="pilot-actions" role="group" aria-label={`${cap.name} controls`}>
        {cap.state !== 'active' && canActivate && (eligibility?.eligible || eligibility?.always_available) && <button className="button-primary" disabled={busy} onClick={onConfirm}>Turn on</button>}
        {cap.state === 'active' && cap.states?.includes('shadow') && <button className="button-secondary" disabled={busy} onClick={() => onSet('shadow')}>Return to shadow</button>}
        {cap.state === 'off' && cap.states?.includes('shadow') && <button className="button-secondary" disabled={busy} onClick={() => onSet('shadow')}>Keep in shadow</button>}
        {cap.state !== 'off' && <button className="button-secondary" disabled={busy} onClick={() => onSet('off')} aria-label={`Turn off ${cap.name.toLowerCase()}`}>{cap.state === 'shadow' ? 'Turn off (stop noting)' : 'Turn off'}</button>}
        {cap.key === 'learning_questions' && cap.state === 'active' && <label className="pilot-inline-label"><span>How often</span>
          <select value={cap.config?.frequency ?? 'daily'} disabled={busy} onChange={(event) => onSet('active', { confirm: true, frequency: event.target.value as 'daily' | 'weekly' })}>
            <option value="daily">At most one a day</option><option value="weekly">At most one a week</option></select></label>}
      </div>}
  </section>
}

function AlwaysYours({ review, doctor }: { review: ActivationReview; doctor?: string }) {
  return <section className="pilot-readiness-section pilot-always-yours" aria-labelledby="readiness-always">
    <h2 id="readiness-always">{doctor ? `Always ${doctor}’s` : 'Always yours'}</h2>
    <p className="muted-note">These never become something the agent does.</p>
    <ul>{review.always_yours.map((line) => <li key={line}>{line}</li>)}</ul>
    {review.coming_later.length > 0 && <p className="muted-note pilot-coming-later">Coming later (not available yet): {review.coming_later.join(' · ')}.</p>}
  </section>
}

function PracticeLimits({ review, busy, onSet }: { review: ActivationReview; busy: boolean; onSet: (key: string, state: CapabilityState) => void }) {
  return <section className="pilot-readiness-section" aria-labelledby="readiness-limits">
    <h2 id="readiness-limits">Practice-wide limits</h2>
    <p className="muted-note">As practice admin you can cap what any physician’s agent in this practice may do. Lowering a limit also lowers any physician above it, and that change is recorded.</p>
    <ul className="pilot-limit-list">{review.capabilities.map((cap) => <li key={cap.key}><span>{cap.name}</span>
      <select aria-label={`Practice limit for ${cap.name}`} value={review.limits?.[cap.key] ?? 'active'} disabled={busy} onChange={(event) => onSet(cap.key, event.target.value as CapabilityState)}>
        <option value="active">Allowed (physicians choose)</option><option value="shadow">Shadow at most</option><option value="off">Off for everyone</option></select></li>)}</ul>
  </section>
}
