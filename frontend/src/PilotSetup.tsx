import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AgentAvatar } from './AgentAvatar.tsx'
import { ApiError } from './api.ts'
import {
  confirmRepresentation, finishSetupStage, getRepresentation, getSetup, leaveProposalUnknown, saveSetupDelegation,
  saveSetupIdentity, saveSetupRequirements, saveSetupScope, skipSetupStage,
  type DelegationAnswer, type PilotStatus, type Proposal, type Representation, type ScopeChoice, type SetupStageId, type SetupView,
} from './pilotApi.ts'
import {
  AUTONOMY_LABELS, HANDLED_BY_LABELS, MODALITY_LABELS, pilotErrorCopy, pilotPaths, representationGroups, SCOPE_CHOICE_LABELS,
  itemKindEffect, itemKindLabel, SETUP_STAGES, setupProgressLine, STAGE_STATUS_LABELS, STATEMENT_KIND_LABELS, TOPIC_LABELS,
} from './pilotState.ts'
import { ProposalCard } from './PilotAgent.tsx'
import { notifyPilotDataChanged } from './pilotSync.ts'

type Navigate = (path: string) => void
const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
// Aliases and urgency signals: one per line or comma separated. Locations and interests contain
// commas themselves ("1 Test Way, Palo Alto"), so they split on new lines only.
const lines = (text: string) => text.split(/\n|,/).map((line) => line.trim()).filter(Boolean)
const rows = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/**
 * Guided initialization (Step 17). Five stages, each skippable and resumable; "Unknown" is
 * always an acceptable answer. Every answer becomes a PROPOSAL the physician confirms in
 * Stage E — nothing here changes triage by itself. Progress is shown by stage, never as a
 * score or percentage.
 */
export function SetupPage({ status, navigate, stage }: { status: PilotStatus; navigate: Navigate; stage: SetupStageId | null }) {
  const [setup, setSetup] = useState<SetupView | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => getSetup().then((next) => { setSetup(next); setError('') }).catch((err) => setError(errorText(err, 'Could not open setup'))), [])
  useEffect(() => { if (status.role === 'physician') void load() }, [load, status.role])

  if (status.role !== 'physician') {
    return <main className="page-shell pilot-setup-page"><header className="selector-header"><div><p className="eyebrow">Agent setup</p><h1>Only the physician sets up their agent</h1>
      <p>You can see the practice-level requirements that apply to your work under Your Agent.</p></div></header>
      <button className="button-primary" onClick={() => navigate(pilotPaths.agent)}>Open Your Agent <span>→</span></button></main>
  }
  if (error && !setup) return <main className="page-shell pilot-setup-page"><div className="error-banner" role="alert">{error}</div><button className="text-button" onClick={() => void load()}>Try again</button></main>
  if (!setup) return <main className="page-shell pilot-setup-page"><div className="page-state embedded"><div className="loading-line" /><p>Opening setup…</p></div></main>

  const current: SetupStageId = stage ?? setup.lifecycle.next_stage ?? 'review'
  const go = (next: SetupStageId) => navigate(pilotPaths.setup(next))
  const nextOf = (id: SetupStageId): SetupStageId => SETUP_STAGES[Math.min(SETUP_STAGES.indexOf(id) + 1, SETUP_STAGES.length - 1)]
  const after = (next: SetupView, from: SetupStageId) => { setSetup(next); notifyPilotDataChanged(); go(nextOf(from)) }
  const skip = async (id: SetupStageId) => {
    try { after(await skipSetupStage(id), id) } catch (err) { setError(errorText(err, 'Could not skip this stage')) }
  }
  const info = setup.lifecycle.stages.find((item) => item.id === current)

  return <main className="page-shell pilot-setup-page">
    <section className="agent-hero pilot-setup-hero"><div className="agent-hero-mark"><AgentAvatar tone="copper" /></div><div>
      <p className="eyebrow">Set up your agent</p>
      <h1>How your agent will represent you</h1>
      <p>About 5–10 minutes for a first useful version. Skip anything and finish it later under Your Agent → Train; “Unknown” is always a fine answer. Nothing is used for triage until you confirm it.</p>
    </div></section>
    <nav className="pilot-setup-stages" aria-label="Setup stages">
      <p className="pilot-setup-progress">{setupProgressLine(setup.lifecycle)}</p>
      <ol>{setup.lifecycle.stages.map((item, index) => <li key={item.id} className={`status-${item.status}${item.id === current ? ' current' : ''}`}>
        <button type="button" onClick={() => go(item.id)} aria-current={item.id === current ? 'step' : undefined}>
          <span className="pilot-setup-stage-index">{String.fromCharCode(65 + index)}</span>
          <span className="pilot-setup-stage-text"><strong>{item.label}</strong><small>{STAGE_STATUS_LABELS[item.status]} · ~{item.minutes} min</small></span>
        </button>
      </li>)}</ol>
    </nav>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <section className="pilot-setup-stage" aria-labelledby="setup-stage-heading">
      <h2 id="setup-stage-heading">{info?.label}</h2>
      {current === 'identity' && <IdentityStage setup={setup} onDone={(next) => after(next, 'identity')} onSkip={() => void skip('identity')} />}
      {current === 'scope' && <ScopeStage setup={setup} onDone={(next) => after(next, 'scope')} onSkip={() => void skip('scope')} />}
      {current === 'requirements' && <RequirementsStage onDone={(next) => after(next, 'requirements')} onSkip={() => void skip('requirements')} onChanged={(next) => setSetup(next)} />}
      {current === 'delegation' && <DelegationStage setup={setup} onDone={(next) => after(next, 'delegation')} onSkip={() => void skip('delegation')} />}
      {current === 'review' && <ReviewStage navigate={navigate} onConfirmed={() => void load()} />}
    </section>
  </main>
}

function StageActions({ busy, primary, onSkip, children }: { busy: boolean; primary: string; onSkip?: () => void; children?: ReactNode }) {
  return <div className="onboarding-actions pilot-setup-actions">
    <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : primary} <span>→</span></button>
    {children}
    {onSkip && <button className="text-button" type="button" disabled={busy} onClick={onSkip}>Skip for now</button>}
  </div>
}

/* ------------------------------------------------------------------ A identity */

function IdentityStage({ setup, onDone, onSkip }: { setup: SetupView; onDone: (next: SetupView) => void; onSkip: () => void }) {
  const profile = setup.profile
  const [specialty, setSpecialty] = useState(profile?.specialty ?? setup.prefill.specialty.value ?? '')
  const [subspecialty, setSubspecialty] = useState(profile?.subspecialty ?? '')
  const [locations, setLocations] = useState((profile?.locations ?? setup.prefill.locations.value).join('\n'))
  const [interests, setInterests] = useState((profile?.clinical_interests ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prefilledSpecialty = !profile && Boolean(setup.prefill.specialty.value) && specialty === setup.prefill.specialty.value
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      onDone(await saveSetupIdentity({
        specialty, subspecialty, locations: rows(locations), clinical_interests: rows(interests),
        sources: { specialty: specialty === setup.prefill.specialty.value ? setup.prefill.specialty.source : 'You' },
      }))
    } catch (err) { setError(errorText(err, 'Could not save')) } finally { setBusy(false) }
  }
  return <form className="auth-form pilot-form pilot-card" onSubmit={(event) => void submit(event)}>
    <p className="page-intro">Check what we prefilled from public records. Change anything that’s wrong — nothing here is published.</p>
    <label><span>Specialty</span><input value={specialty} onChange={(event) => setSpecialty(event.target.value)} disabled={busy} /></label>
    {prefilledSpecialty && <p className="pilot-source-label">Prefilled from {setup.prefill.specialty.source} — please check</p>}
    <label><span>Subspecialty or focus (optional)</span><input value={subspecialty} onChange={(event) => setSubspecialty(event.target.value)} disabled={busy} /></label>
    <label><span>Where you see patients — one per line</span><textarea rows={2} value={locations} onChange={(event) => setLocations(event.target.value)} disabled={busy} /></label>
    {!profile && setup.prefill.locations.value.length > 0 && <p className="pilot-source-label">Prefilled from {setup.prefill.locations.source} — please check</p>}
    <label><span>Clinical interests (optional) — one per line</span><textarea rows={2} value={interests} onChange={(event) => setInterests(event.target.value)} disabled={busy} placeholder="Cases you particularly want to see" /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <StageActions busy={busy} primary="Looks right — continue" onSkip={onSkip} />
  </form>
}

/* --------------------------------------------------------------------- B scope */

type ScopeRow = { referral_type: string; aliases: string; policy: ScopeChoice; suggested: boolean }

function ScopeStage({ setup, onDone, onSkip }: { setup: SetupView; onDone: (next: SetupView) => void; onSkip: () => void }) {
  const [rows, setRows] = useState<ScopeRow[]>(() => [
    ...setup.referral_types.map((name) => ({ referral_type: name, aliases: '', policy: 'unknown' as ScopeChoice, suggested: false })),
  ])
  const [suggestions, setSuggestions] = useState(setup.starter_suggestions)
  const [newType, setNewType] = useState('')
  const [newAliases, setNewAliases] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const update = (index: number, patch: Partial<ScopeRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const add = () => {
    const name = newType.trim()
    if (!name) return
    setRows((current) => [...current, { referral_type: name, aliases: newAliases, policy: 'accept', suggested: false }])
    setNewType(''); setNewAliases('')
  }
  const addSuggestion = (name: string) => {
    setRows((current) => [...current, { referral_type: name, aliases: '', policy: 'unknown', suggested: true }])
    setSuggestions((current) => current.filter((item) => item !== name))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await saveSetupScope(rows.map((row) => ({ referral_type: row.referral_type, aliases: lines(row.aliases), policy: row.policy })))
      onDone(result.setup)
    } catch (err) { setError(errorText(err, 'Could not save')) } finally { setBusy(false) }
  }
  return <form className="pilot-card pilot-setup-scope" onSubmit={(event) => void submit(event)}>
    <p className="page-intro">Which kinds of referral do you receive, and what do you want done with each? Your answers become items you confirm at the end.</p>
    {rows.length === 0 && <p className="agent-empty-note">No referral types yet. Add the ones you receive below{suggestions.length ? ', or start from a suggestion' : ''}.</p>}
    <ul className="pilot-scope-list">{rows.map((row, index) => <li key={`${row.referral_type}-${index}`} className="pilot-scope-row">
      <div className="pilot-scope-name">
        <strong>{row.referral_type}</strong>
        {row.suggested && <span className="pilot-suggested-tag">Suggested — not confirmed</span>}
        <label className="pilot-inline-label"><span>Also called (optional)</span><input value={row.aliases} onChange={(event) => update(index, { aliases: event.target.value })} placeholder="Other names, comma separated" disabled={busy} /></label>
      </div>
      <div className="pilot-choice" role="radiogroup" aria-label={`What to do with ${row.referral_type}`}>
        {(Object.keys(SCOPE_CHOICE_LABELS) as ScopeChoice[]).map((choice) => <label key={choice} className={row.policy === choice ? 'selected' : ''}>
          <input type="radio" name={`scope-${index}`} checked={row.policy === choice} onChange={() => update(index, { policy: choice })} disabled={busy} />{SCOPE_CHOICE_LABELS[choice]}
        </label>)}
      </div>
    </li>)}</ul>
    {suggestions.length > 0 && <div className="pilot-suggestions">
      <p className="practice-subheading">Common for your specialty — suggested, not confirmed</p>
      <div className="practice-chip-group">{suggestions.map((name) => <button type="button" key={name} className="practice-chip pilot-suggestion-chip" onClick={() => addSuggestion(name)} disabled={busy}>+ {name}</button>)}</div>
    </div>}
    <div className="pilot-form pilot-add-type">
      <div className="pilot-form-row">
        <label><span>Add a referral type</span><input value={newType} onChange={(event) => setNewType(event.target.value)} placeholder="As referring offices usually write it" disabled={busy} /></label>
        <label><span>Also called (optional)</span><input value={newAliases} onChange={(event) => setNewAliases(event.target.value)} placeholder="Comma separated" disabled={busy} /></label>
      </div>
      <button className="button-secondary" type="button" onClick={add} disabled={busy || !newType.trim()}>Add type</button>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <StageActions busy={busy} primary="Save and continue" onSkip={onSkip} />
  </form>
}

/* --------------------------------------------------------------- C requirements */

function RequirementsStage({ onDone, onSkip, onChanged }: { onDone: (next: SetupView) => void; onSkip: () => void; onChanged: (next: SetupView) => void }) {
  const [representation, setRepresentation] = useState<Representation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { getRepresentation().then(setRepresentation).catch((err) => setError(errorText(err, 'Could not load your referral types'))) }, [])
  if (error && !representation) return <div className="error-banner" role="alert">{error}</div>
  if (!representation) return <div className="page-state embedded"><div className="loading-line" /><p>Loading your referral types…</p></div>
  // Types you see (confirmed or answered in Stage B). Out-of-scope and case-by-case types need no workup.
  const accepted = representation.types.filter((type) => type.scope_policy === 'accept'
    || type.items.some((item) => item.status === 'proposed' && item.value === 'accept'))
  const finish = async () => {
    setBusy(true)
    try { onDone(await finishSetupStage('requirements')) } catch (err) { setError(errorText(err, 'Could not save')) } finally { setBusy(false) }
  }
  return <div className="pilot-setup-requirements">
    <p className="page-intro">For each type you see: what must be present before review, what’s helpful, what makes one urgent, and your preferred visit type. Answer in your own words or item by item — I’ll show you exactly what I understood.</p>
    {accepted.length === 0 && <p className="agent-empty-note">No types marked “I see these” yet. Go back to Case scope, or skip this for now.</p>}
    {accepted.map((type) => <RequirementsCard key={type.referral_type} referralType={type.referral_type} onSaved={onChanged} />)}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions pilot-setup-actions">
      <button className="button-primary" type="button" disabled={busy} onClick={() => void finish()}>Done — continue <span>→</span></button>
      <button className="text-button" type="button" disabled={busy} onClick={onSkip}>Skip for now</button>
    </div>
  </div>
}

function RequirementsCard({ referralType, onSaved }: { referralType: string; onSaved: (next: SetupView) => void }) {
  const [text, setText] = useState('')
  const [required, setRequired] = useState('')
  const [helpful, setHelpful] = useState('')
  const [urgent, setUrgent] = useState('')
  const [modality, setModality] = useState<keyof typeof MODALITY_LABELS>('unspecified')
  const [nothingRequired, setNothingRequired] = useState(false)
  const [noUrgency, setNoUrgency] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ proposal: Proposal | null; review_notes: string[]; clarification: { question: string; item: string } | null } | null>(null)
  const [answer, setAnswer] = useState('')
  const parseItems = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [label, days] = line.split('|').map((part) => part.trim())
    return { label, freshness_days: days && /^\d+$/.test(days) ? Number(days) : null }
  })
  const save = async (event?: FormEvent, clarified?: { item: string; days: number }) => {
    event?.preventDefault(); setBusy(true); setError('')
    try {
      let requiredItems = parseItems(required)
      if (clarified) requiredItems = [...requiredItems.filter((item) => item.label !== clarified.item), { label: clarified.item, freshness_days: clarified.days }]
      const saved = await saveSetupRequirements({
        referral_type: referralType, text: text || null, required: requiredItems, helpful: parseItems(helpful),
        urgent_signals: lines(urgent), modality: modality === 'unspecified' ? null : modality,
        nothing_required: nothingRequired, no_urgency_signals: noUrgency,
      })
      setResult(saved); onSaved(saved.setup); notifyPilotDataChanged()
      if (clarified) { setRequired((current) => [...current.split('\n').filter((line) => line.trim() && !line.startsWith(clarified.item)), `${clarified.item} | ${clarified.days}`].join('\n')); setAnswer('') }
    } catch (err) { setError(errorText(err, 'Could not save')) } finally { setBusy(false) }
  }
  const proposal = result?.proposal
  return <section className="pilot-card pilot-requirements-card">
    <h3>{referralType}</h3>
    <form className="auth-form pilot-form" onSubmit={(event) => void save(event)}>
      <label><span>In your own words (optional)</span><textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="e.g. I need an ultrasound and a recent lab result within 90 days. I prefer eConsult for stable questions." disabled={busy} /></label>
      <div className="pilot-form-row">
        <label><span>Required before review — one per line, optional “| days”</span><textarea rows={3} value={required} onChange={(event) => setRequired(event.target.value)} disabled={busy || nothingRequired} placeholder={'Item name | 90'} /></label>
        <label><span>Helpful but optional — one per line</span><textarea rows={3} value={helpful} onChange={(event) => setHelpful(event.target.value)} disabled={busy} /></label>
      </div>
      <div className="pilot-form-row">
        <label><span>Treat as urgent if — one per line</span><textarea rows={2} value={urgent} onChange={(event) => setUrgent(event.target.value)} disabled={busy || noUrgency} /></label>
        <label><span>Preferred visit type</span><select value={modality} onChange={(event) => setModality(event.target.value as keyof typeof MODALITY_LABELS)} disabled={busy}>
          <option value="unspecified">Unknown / no preference</option><option value="econsult">eConsult</option><option value="in_person">In-person</option><option value="either">Either</option>
        </select></label>
      </div>
      <label className="pilot-check"><input type="checkbox" checked={nothingRequired} onChange={(event) => setNothingRequired(event.target.checked)} disabled={busy} /> Nothing is required before I review these</label>
      <label className="pilot-check"><input type="checkbox" checked={noUrgency} onChange={(event) => setNoUrgency(event.target.checked)} disabled={busy} /> No urgency signals for this type</label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="onboarding-actions"><button className="button-secondary" type="submit" disabled={busy}>{busy ? 'Reading…' : proposal ? 'Update what I understood' : `Save for ${referralType}`}</button></div>
    </form>
    {result && <div className="pilot-panel pilot-understood" aria-live="polite">
      {proposal ? <>
        <p><strong>What I understood</strong> — shown for confirmation at the end, not used yet:</p>
        <ul>
          {proposal.content.required.map((item) => <li key={`r-${item.key}`}><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.hard_requirement}</span> {item.label}{item.freshness_days ? ` — within ${item.freshness_days} days` : ' — no time window'}</li>)}
          {proposal.content.helpful.map((item) => <li key={`h-${item.key}`}><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.soft_preference}</span> Helpful: {item.label}</li>)}
          {proposal.content.urgent_signals.map((item) => <li key={`u-${item}`}><span className="pilot-kind-tag">Urgency</span> Urgent if: {item}</li>)}
          {proposal.content.modality !== 'unspecified' && <li><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.soft_preference}</span> Prefers {MODALITY_LABELS[proposal.content.modality]}</li>}
          {(proposal.content.preferences ?? []).map((item) => <li key={`p-${item}`}><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.soft_preference}</span> {item}</li>)}
          {(proposal.content.exceptions ?? []).map((item) => <li key={`e-${item}`}><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.exception}</span> {item}</li>)}
          {(proposal.content.judgment ?? []).map((item) => <li key={`j-${item}`}><span className="pilot-kind-tag">{STATEMENT_KIND_LABELS.physician_judgment}</span> {item}</li>)}
        </ul>
      </> : <p className="muted-note">Nothing to record yet — this type stays unknown until you answer.</p>}
      {result.review_notes.length > 0 && <ul className="pilot-review-notes">{result.review_notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {result.clarification && <div className="pilot-inline-form">
        <label><span>{result.clarification.question}</span><input inputMode="numeric" value={answer} onChange={(event) => setAnswer(event.target.value.replace(/\D/g, ''))} placeholder="Days" disabled={busy} /></label>
        <button className="text-button" type="button" disabled={busy || !answer} onClick={() => void save(undefined, { item: result.clarification!.item, days: Number(answer) })}>Set window</button>
      </div>}
    </div>}
  </section>
}

/* ----------------------------------------------------------------- D delegation */

function DelegationStage({ setup, onDone, onSkip }: { setup: SetupView; onDone: (next: SetupView) => void; onSkip: () => void }) {
  const [answers, setAnswers] = useState<Record<string, DelegationAnswer>>(() => Object.fromEntries(setup.delegation_tasks.map((task) => [
    task.id, setup.delegation[task.id] ?? { handled_by: 'staff', autonomy: 'observe' },
  ])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { onDone(await saveSetupDelegation(answers)) } catch (err) { setError(errorText(err, 'Could not save')) } finally { setBusy(false) }
  }
  return <form className="pilot-card" onSubmit={(event) => void submit(event)}>
    <p className="page-intro">Who handles each kind of work today, and how much you’d eventually like your agent to do. These are preferences for later — today every capability stays in shadow: your agent recommends; you and your staff decide.</p>
    <div className="pilot-delegation-list">{setup.delegation_tasks.map((task) => <div key={task.id} className="pilot-delegation-row">
      <strong>{task.label}</strong>
      <label><span>Usually handled by</span><select value={answers[task.id].handled_by} disabled={busy}
        onChange={(event) => setAnswers((current) => ({ ...current, [task.id]: { ...current[task.id], handled_by: event.target.value as DelegationAnswer['handled_by'] } }))}>
        {(Object.keys(HANDLED_BY_LABELS) as Array<keyof typeof HANDLED_BY_LABELS>).map((key) => <option key={key} value={key}>{HANDLED_BY_LABELS[key]}</option>)}
      </select></label>
      <label><span>Eventually, your agent should</span><select value={answers[task.id].autonomy} disabled={busy}
        onChange={(event) => setAnswers((current) => ({ ...current, [task.id]: { ...current[task.id], autonomy: event.target.value as DelegationAnswer['autonomy'] } }))}>
        {(Object.keys(AUTONOMY_LABELS) as Array<keyof typeof AUTONOMY_LABELS>).map((key) => <option key={key} value={key}>{AUTONOMY_LABELS[key]}</option>)}
      </select></label>
    </div>)}</div>
    <p className="muted-note">Your agent never makes clinical decisions or sends anything outside the practice on its own.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <StageActions busy={busy} primary="Save and continue" onSkip={onSkip} />
  </form>
}

/* --------------------------------------------------------------------- E review */

function ReviewStage({ navigate, onConfirmed }: { navigate: Navigate; onConfirmed: () => void }) {
  const [representation, setRepresentation] = useState<Representation | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ version: number } | null>(null)
  const load = useCallback(() => {
    getRepresentation().then(setRepresentation).catch((err) => setError(errorText(err, 'Could not load your representation')))
    getSetup().then((next) => setProposals(next.pending)).catch(() => setProposals([]))
  }, [])
  useEffect(load, [load])
  if (error && !representation) return <div className="error-banner" role="alert">{error}</div>
  if (!representation) return <div className="page-state embedded"><div className="loading-line" /><p>Gathering what you told me…</p></div>
  const confirm = async () => {
    setBusy(true); setError('')
    try { const result = await confirmRepresentation(); setDone({ version: result.version.version }); notifyPilotDataChanged(); onConfirmed() }
    catch (err) { setError(errorText(err, 'Could not confirm')) } finally { setBusy(false) }
  }
  const leaveUnknown = async (id: string) => {
    try { await leaveProposalUnknown(id); notifyPilotDataChanged(); load() } catch (err) { setError(errorText(err, 'Could not update')) }
  }
  const types = representation.types
  const delegation = Object.entries(representation.delegation)
  return <div className="pilot-setup-review">
    <p className="page-intro">This is how your agent will represent you. Confirm, edit, reject, or leave each answer unknown. Only confirmed items are used — and triage only uses confirmed requirements and scope.</p>
    {proposals.length > 0 && <section className="pilot-review-section">
      <h3>Waiting for your confirmation</h3>
      {proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} referralTypes={types.map((type) => type.referral_type)}
        onChange={() => { notifyPilotDataChanged(); load() }}
        extraActions={<button className="text-button" type="button" onClick={() => void leaveUnknown(proposal.id)}>Leave unknown</button>} />)}
    </section>}
    <section className="pilot-review-section">
      <h3>Confirmed, by referral type</h3>
      {types.filter((type) => representationGroups(type).confirmed.length > 0).length === 0
        ? <p className="agent-empty-note">Nothing confirmed yet. That’s fine — your agent will say it doesn’t know, and you can add more later.</p>
        : types.map((type) => { const { confirmed } = representationGroups(type); return confirmed.length > 0 && <div key={type.referral_type} className="pilot-representation-type">
          <h4>{type.referral_type}{type.aliases.length > 0 && <small> · also {type.aliases.join(', ')}</small>}</h4>
          <ul>{confirmed.map((item, index) => <li key={`${item.rule_id}-${index}`}><span className={`pilot-kind-tag kind-${item.kind}`}>{itemKindLabel(item)}</span> {item.text} <small className="muted-note">{itemKindEffect(item)} · v{item.version}{item.layer === 'physician' ? ' · just you' : ''}</small></li>)}</ul>
          {type.unknown_topics.length > 0 && <p className="pilot-unknown-line">Unknown: {type.unknown_topics.map((topic) => TOPIC_LABELS[topic].toLowerCase()).join(', ')}</p>}
        </div> })}
    </section>
    {representation.conflicts.length > 0 && <section className="pilot-review-section"><h3>Conflicts to review</h3>
      <ul>{representation.conflicts.map((conflict, index) => <li key={index}>{conflict.referral_type}: {conflict.kind === 'scope_policy' ? `the practice says “${String(conflict.practice)}”, your own statement says “${String(conflict.physician)}”` : `you made “${String(conflict.item_key).replace(/_/g, ' ')}” optional, but the practice requires it`}. Your agent won’t choose between them.</li>)}</ul></section>}
    <section className="pilot-review-section"><h3>Delegation</h3>
      {delegation.length === 0 ? <p className="muted-note">Not answered yet.</p>
        : <ul>{delegation.map(([task, answer]) => <li key={task}>{representation.delegation_tasks[task] ?? task}: {HANDLED_BY_LABELS[answer.handled_by]} · eventually “{AUTONOMY_LABELS[answer.autonomy].toLowerCase()}”</li>)}</ul>}
      <p className="muted-note">Stored for later. Nothing is enabled now.</p>
    </section>
    <section className="pilot-review-section"><h3>Still unknown</h3>
      {representation.unknowns.length === 0 ? <p className="muted-note">Nothing open.</p>
        : <ul className="pilot-unknown-list">{representation.unknowns.map((item) => <li key={item}>{item}</li>)}</ul>}
      <p className="muted-note">Your agent will say it doesn’t know these, and may ask you later.</p>
    </section>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {done ? <div className="pilot-panel pilot-setup-done" role="status">
      <p><strong>Representation confirmed (version {done.version}).</strong> Shadow mode — your agent recommends; you and your staff decide.</p>
      <button className="button-primary" onClick={() => navigate(pilotPaths.agent)}>Open Your Agent <span>→</span></button>
    </div> : <div className="onboarding-actions pilot-setup-actions">
      <button className="button-primary" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Confirming…' : 'Confirm representation'} <span>→</span></button>
      <p className="muted-note">Saves a version of what’s confirmed. Items still waiting stay unconfirmed.</p>
    </div>}
  </div>
}
