/** First NLP physician-representation feature (Part B/C/F/G/H/I): "How I
 * receive referrals." A physician describes, in ordinary language, how they
 * prefer to receive referrals; Lamina interprets that into a DRAFT
 * structured rule set. A draft is never operational -- only explicitly
 * confirming it (via "Looks right") makes it part of the physician's
 * durable representation. Lives on the physician's own private Profile,
 * never a patient-facing surface. */

import { useEffect, useState } from 'react'
import {
  confirmReferralPreference, editReferralPreference, interpretReferralPreference,
  listReferralPreferences, rejectReferralPreference,
  type ModalityRule, type PhysicianIdentity, type PhysicianReferralPreference,
  type ReferralRequirementItem, type StructuredReferralPreference,
} from './api.ts'
import { ModalPortal } from './ModalPortal.tsx'

const MODALITY_LABELS: Record<StructuredReferralPreference['modality'], string> = {
  in_person: 'In-person preferred', econsult: 'E-consult preferred',
  either: 'Either; no strong preference', unspecified: 'Not specified',
}

/** Demo UX + semantic polish pass, Part 7/10: a conditional modality rule
 * renders as its own small labeled block -- never collapsed into the flat
 * MODALITY_LABELS line above, which is only shown when there are no real
 * conditional rules to display instead. */
const MODALITY_RULE_HEADING: Record<ModalityRule['modality'], string> = {
  econsult: 'E-consult can be appropriate when',
  in_person: 'In-person preferred when',
}

function RequirementRow({ item, onToggleRequired, onRemove }: {
  item: ReferralRequirementItem; onToggleRequired?: () => void; onRemove?: () => void
}) {
  return <li className="referral-pref-requirement-row">
    <span>{item.label}{item.freshness_days !== null && <small> · within {item.freshness_days} days</small>}</span>
    {(onToggleRequired || onRemove) && <span className="referral-pref-requirement-actions">
      {onToggleRequired && <button type="button" className="text-button" onClick={onToggleRequired}>{item.required ? 'Move to helpful' : 'Move to required'}</button>}
      {onRemove && <button type="button" className="text-button" onClick={onRemove} aria-label={`Remove ${item.label}`}>Remove</button>}
    </span>}
  </li>
}

function ReadOnlyInterpretation({ rules }: { rules: StructuredReferralPreference }) {
  return <div className="referral-pref-interpretation">
    {rules.good_fit.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Good fit</p>
      <ul className="referral-pref-chip-list">{rules.good_fit.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>}
    {rules.required.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Required before review</p>
      <ul className="referral-pref-requirement-list">{rules.required.map((item) => <RequirementRow key={item.key} item={item} />)}</ul>
    </div>}
    {rules.helpful.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Helpful when available</p>
      <ul className="referral-pref-requirement-list">{rules.helpful.map((item) => <RequirementRow key={item.key} item={item} />)}</ul>
    </div>}
    {rules.redirect.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Generally prefers routed elsewhere</p>
      <ul className="referral-pref-chip-list">{rules.redirect.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>}
    {rules.modality_rules.length > 0
      ? rules.modality_rules.map((rule, index) => <div className="referral-pref-group" key={`${rule.modality}-${index}`}>
        <p className="section-label">{MODALITY_RULE_HEADING[rule.modality]}</p>
        <p>{rule.condition.replace(/\.?$/, '.')}</p>
      </div>)
      : rules.modality !== 'unspecified' && <div className="referral-pref-group">
        <p className="section-label">Modality</p>
        <p>{MODALITY_LABELS[rules.modality]}</p>
      </div>}
    {rules.good_fit.length === 0 && rules.required.length === 0 && rules.helpful.length === 0 && rules.redirect.length === 0
      && rules.modality === 'unspecified' && rules.modality_rules.length === 0
      && <p className="muted-note">Nothing could be interpreted from that description -- try adding more detail.</p>}
  </div>
}

function StructuredRulesEditor({ rules, onChange }: {
  rules: StructuredReferralPreference; onChange: (next: StructuredReferralPreference) => void
}) {
  const toggleRequired = (key: string) => {
    const fromRequired = rules.required.find((item) => item.key === key)
    const fromHelpful = rules.helpful.find((item) => item.key === key)
    if (fromRequired) {
      onChange({ ...rules, required: rules.required.filter((item) => item.key !== key), helpful: [...rules.helpful, { ...fromRequired, required: false }] })
    } else if (fromHelpful) {
      onChange({ ...rules, helpful: rules.helpful.filter((item) => item.key !== key), required: [...rules.required, { ...fromHelpful, required: true }] })
    }
  }
  const removeRequirement = (key: string) => onChange({
    ...rules,
    required: rules.required.filter((item) => item.key !== key),
    helpful: rules.helpful.filter((item) => item.key !== key),
  })
  return <div className="referral-pref-editor">
    {rules.good_fit.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Good fit</p>
      <ul className="referral-pref-chip-list">{rules.good_fit.map((item) => <li key={item}>{item}
        <button type="button" className="text-button" onClick={() => onChange({ ...rules, good_fit: rules.good_fit.filter((x) => x !== item) })} aria-label={`Remove ${item}`}>×</button>
      </li>)}</ul>
    </div>}
    {rules.required.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Required before review</p>
      <ul className="referral-pref-requirement-list">{rules.required.map((item) => <RequirementRow key={item.key} item={item} onToggleRequired={() => toggleRequired(item.key)} onRemove={() => removeRequirement(item.key)} />)}</ul>
    </div>}
    {rules.helpful.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Helpful when available</p>
      <ul className="referral-pref-requirement-list">{rules.helpful.map((item) => <RequirementRow key={item.key} item={item} onToggleRequired={() => toggleRequired(item.key)} onRemove={() => removeRequirement(item.key)} />)}</ul>
    </div>}
    {rules.redirect.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Generally prefers routed elsewhere</p>
      <ul className="referral-pref-chip-list">{rules.redirect.map((item) => <li key={item}>{item}
        <button type="button" className="text-button" onClick={() => onChange({ ...rules, redirect: rules.redirect.filter((x) => x !== item) })} aria-label={`Remove ${item}`}>×</button>
      </li>)}</ul>
    </div>}
    {rules.modality_rules.length > 0 && <div className="referral-pref-group">
      <p className="section-label">Conditional modality guidance</p>
      <ul className="referral-pref-chip-list">{rules.modality_rules.map((rule, index) => <li key={`${rule.modality}-${index}`}>{MODALITY_RULE_HEADING[rule.modality]} {rule.condition.toLowerCase()}.</li>)}</ul>
      <p className="muted-note">Edit the full description above and re-interpret to change this.</p>
    </div>}
    <div className="referral-pref-group">
      <label htmlFor="referral-pref-modality-select" className="section-label">Modality preference</label>
      <select
        id="referral-pref-modality-select"
        value={rules.modality}
        onChange={(event) => onChange({ ...rules, modality: event.target.value as StructuredReferralPreference['modality'] })}
      >
        <option value="unspecified">Not specified</option>
        <option value="in_person">In-person preferred</option>
        <option value="econsult">E-consult preferred</option>
        <option value="either">Either; no strong preference</option>
      </select>
    </div>
  </div>
}

function ConfirmedPreferenceSummary({ preference }: { preference: PhysicianReferralPreference }) {
  return <div className="referral-pref-confirmed-summary">
    <p className="eyebrow">Currently confirmed</p>
    <ReadOnlyInterpretation rules={preference.structured_rules} />
    <small className="referral-pref-provenance">
      Confirmed {preference.confirmed_at ? new Date(preference.confirmed_at).toLocaleDateString() : ''} from a physician-authored referral preference.
    </small>
  </div>
}

type Navigate = (path: string) => void

/** The one review step every natural-language teaching path shares
 * (routing consolidation pass, Part Q/R/U): proactive "Tell your agent
 * something", clarification answers, and Test "Not quite" corrections all
 * land here as a DRAFT -- interpreted, shown as structured proposed
 * learning, and operational only once the physician confirms it. */
export function PreferenceDraftReview({ personaId, draft, onDraftChange, onConfirmed, onDiscarded }: {
  personaId: PhysicianIdentity; draft: PhysicianReferralPreference
  onDraftChange: (next: PhysicianReferralPreference) => void
  onConfirmed: () => void; onDiscarded: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [editedRules, setEditedRules] = useState<StructuredReferralPreference>(draft.structured_rules)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const confirm = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await confirmReferralPreference(personaId, draft.id)
      onConfirmed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm this preference.')
    } finally {
      setBusy(false)
    }
  }

  const saveEdits = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      onDraftChange(await editReferralPreference(personaId, draft.id, editedRules))
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those edits.')
    } finally {
      setBusy(false)
    }
  }

  const startOver = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await rejectReferralPreference(personaId, draft.id)
    } catch {
      // A discarded draft is not operational either way; proceed regardless.
    } finally {
      setBusy(false); onDiscarded()
    }
  }

  return <div className="referral-pref-review-card">
    <p className={`eyebrow referral-pref-status-${draft.status}`}>{draft.status === 'draft' ? 'Proposed learning · not yet operational' : draft.status}</p>
    <h3>We interpreted this as</h3>
    {editing
      ? <StructuredRulesEditor rules={editedRules} onChange={setEditedRules} />
      : <ReadOnlyInterpretation rules={draft.structured_rules} />}
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    <div className="referral-pref-review-actions">
      {editing
        ? <>
          <button type="button" className="button-primary" disabled={busy} onClick={() => void saveEdits()}>Save edits</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => { setEditedRules(draft.structured_rules); setEditing(false) }}>Cancel</button>
        </>
        : <>
          <button type="button" className="button-primary" disabled={busy} onClick={() => void confirm()}>Looks right</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(true)}>Edit interpretation</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => void startOver()}>Start over</button>
        </>}
    </div>
  </div>
}

/** Placeholder and example are deliberately separate (Part W): the
 * textarea itself is always truly empty until the physician types, and
 * the example is shown as quiet helper text that can never be mistaken for
 * physician-entered content. */
export const TEACHING_PLACEHOLDER = 'Type here…'
const DEFAULT_TEACHING_EXAMPLE = 'For diabetes referrals, I usually need a recent A1c, current medications, and recent kidney function.'

/** Mirrors Engagement.tsx's own agentPracticePath exactly -- duplicated
 * (not imported) to avoid a circular import, since Engagement.tsx already
 * imports ReferralPreferenceSection from this file. */
function practiceRepresentationPath(perspective: PhysicianIdentity): string {
  return perspective === 'iain' ? '/specialist/agent'
    : perspective === 'chen' ? '/chen/agent'
      : perspective === 'owner' ? '/me/agent?tab=practice'
        : '/agent?tab=knowledge'
}

export function ReferralPreferenceSection({
  personaId, navigate, heading = 'How I receive referrals',
  intro = 'Describe what makes a referral useful to you, what information you usually need, and which cases are a good fit for your practice.',
  placeholder = TEACHING_PLACEHOLDER,
  example = DEFAULT_TEACHING_EXAMPLE,
  submitLabel = 'Interpret',
  showConfirmedSummary = true,
  onConfirmed,
  onDone,
}: {
  personaId: PhysicianIdentity; navigate?: Navigate; heading?: string; intro?: string
  placeholder?: string; example?: string | null; submitLabel?: string; showConfirmedSummary?: boolean
  onConfirmed?: () => void; onDone?: () => void
}) {
  const [preferences, setPreferences] = useState<PhysicianReferralPreference[] | null>(null)
  const [sourceText, setSourceText] = useState('')
  const [draft, setDraft] = useState<PhysicianReferralPreference | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmedNote, setConfirmedNote] = useState('')

  const load = () => { listReferralPreferences(personaId).then(setPreferences).catch(() => setPreferences([])) }
  useEffect(load, [personaId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!confirmedNote) return; const timer = window.setTimeout(() => setConfirmedNote(''), 3200); return () => window.clearTimeout(timer) }, [confirmedNote])

  const confirmedPreference = preferences?.find((item) => item.status === 'confirmed') ?? null

  const interpret = async () => {
    const trimmed = sourceText.trim()
    if (!trimmed || busy) return
    setBusy(true); setError('')
    try {
      setDraft(await interpretReferralPreference(personaId, trimmed))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not interpret that description.')
    } finally {
      setBusy(false)
    }
  }

  const confirmed = () => {
    setDraft(null); setSourceText('')
    setConfirmedNote('Added to how your agent represents your practice.')
    load()
    onConfirmed?.()
  }

  const discarded = () => { setDraft(null); setSourceText('') }

  const finishConfirmation = () => { setConfirmedNote(''); onDone?.() }

  return <section className="profile-section referral-preference-section" id="profile-section-referral-preferences">
    <h2>{heading}</h2>
    <p className="muted-note">{intro}</p>

    {confirmedNote
      ? <div className="referral-pref-success" role="status">
        <p className="profile-save-note">✓ {confirmedNote}</p>
        <div className="referral-pref-success-actions">
          {navigate && <button type="button" className="text-button" onClick={() => navigate(practiceRepresentationPath(personaId))}>View in Practice Representation →</button>}
          <button type="button" className="button-primary" onClick={finishConfirmation}>Done</button>
        </div>
      </div>
      : <>
        {showConfirmedSummary && confirmedPreference && !draft && <ConfirmedPreferenceSummary preference={confirmedPreference} />}

        {!draft && <div className="referral-pref-input">
          <label htmlFor="referral-pref-source-text" className="sr-only">{heading}</label>
          <textarea
            id="referral-pref-source-text"
            className="lamina-textarea"
            rows={4}
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder={placeholder}
          />
          {example && <p className="referral-pref-example"><span>Example</span>“{example}”</p>}
          {error && <p className="demo-reset-error" role="alert">{error}</p>}
          <button type="button" className="button-primary" disabled={busy || !sourceText.trim()} onClick={() => void interpret()}>
            {busy ? 'Interpreting…' : submitLabel} <span>→</span>
          </button>
        </div>}

        {draft && <PreferenceDraftReview personaId={personaId} draft={draft} onDraftChange={setDraft} onConfirmed={confirmed} onDiscarded={discarded} />}
      </>}
  </section>
}

/** Demo coherence pass, Part D/J: reuses ReferralPreferenceSection inside a
 * modal/overlay shell -- the SAME NLP interpret/review/confirm pipeline,
 * never a duplicated backend or a second component. Used both from My
 * Agent -> Train ("Describe how you receive referrals") and from the
 * "Clarify" action on a surfaced representation gap, each with its own
 * framing via props rather than a forked implementation. */
export function ReferralPreferenceModal({
  personaId, navigate, onClose, heading, intro, placeholder, example,
}: {
  personaId: PhysicianIdentity; navigate?: Navigate; onClose: () => void
  heading?: string; intro?: string; placeholder?: string; example?: string | null
}) {
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog referral-preference-modal-dialog" role="dialog" aria-modal="true" aria-label={heading ?? 'Describe how you receive referrals'}>
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      {/* Part F/6: does NOT auto-close the instant confirm() resolves --
       * the physician sees the "Added to how your agent represents your
       * practice" success state first, with its own Done action that
       * closes the modal cleanly (never left sitting in a large editable
       * "currently confirmed" form as the next state). */}
      <ReferralPreferenceSection
        personaId={personaId}
        navigate={navigate}
        heading={heading}
        intro={intro}
        placeholder={placeholder}
        example={example}
        onDone={onClose}
      />
    </div>
  </div></ModalPortal>
}
