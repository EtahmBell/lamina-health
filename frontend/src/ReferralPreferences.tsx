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
  type PhysicianIdentity, type PhysicianReferralPreference, type ReferralRequirementItem,
  type StructuredReferralPreference,
} from './api.ts'

const MODALITY_LABELS: Record<StructuredReferralPreference['modality'], string> = {
  in_person: 'In-person preferred', econsult: 'E-consult preferred',
  either: 'Either; no strong preference', unspecified: 'Not specified',
}

const EMPTY_RULES: StructuredReferralPreference = { good_fit: [], required: [], helpful: [], redirect: [], modality: 'unspecified' }

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
    {rules.modality !== 'unspecified' && <div className="referral-pref-group">
      <p className="section-label">Modality</p>
      <p>{MODALITY_LABELS[rules.modality]}</p>
    </div>}
    {rules.good_fit.length === 0 && rules.required.length === 0 && rules.helpful.length === 0 && rules.redirect.length === 0 && rules.modality === 'unspecified'
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

export function ReferralPreferenceSection({ personaId }: { personaId: PhysicianIdentity }) {
  const [preferences, setPreferences] = useState<PhysicianReferralPreference[] | null>(null)
  const [sourceText, setSourceText] = useState('')
  const [draft, setDraft] = useState<PhysicianReferralPreference | null>(null)
  const [editing, setEditing] = useState(false)
  const [editedRules, setEditedRules] = useState<StructuredReferralPreference>(EMPTY_RULES)
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
      const result = await interpretReferralPreference(personaId, trimmed)
      setDraft(result)
      setEditedRules(result.structured_rules)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not interpret that description.')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!draft || busy) return
    setBusy(true); setError('')
    try {
      await confirmReferralPreference(personaId, draft.id)
      setDraft(null); setSourceText(''); setEditing(false)
      setConfirmedNote('Confirmed. Your agent now uses this.')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm this preference.')
    } finally {
      setBusy(false)
    }
  }

  const saveEdits = async () => {
    if (!draft || busy) return
    setBusy(true); setError('')
    try {
      const result = await editReferralPreference(personaId, draft.id, editedRules)
      setDraft(result)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those edits.')
    } finally {
      setBusy(false)
    }
  }

  const startOver = async () => {
    if (!draft || busy) return
    setBusy(true); setError('')
    try {
      await rejectReferralPreference(personaId, draft.id)
    } catch {
      // A discarded draft is not operational either way; proceed regardless.
    } finally {
      setDraft(null); setSourceText(''); setEditing(false); setBusy(false)
    }
  }

  return <section className="profile-section referral-preference-section" id="profile-section-referral-preferences">
    <h2>How I receive referrals</h2>
    <p className="muted-note">
      Describe what makes a referral useful to you, what information you usually need, and which
      cases are a good fit for your practice.
    </p>

    {confirmedNote && <p className="profile-save-note" role="status">{confirmedNote}</p>}
    {confirmedPreference && !draft && <ConfirmedPreferenceSummary preference={confirmedPreference} />}

    {!draft && <div className="referral-pref-input">
      <label htmlFor="referral-pref-source-text" className="sr-only">Describe how you receive referrals</label>
      <textarea
        id="referral-pref-source-text"
        rows={4}
        value={sourceText}
        onChange={(event) => setSourceText(event.target.value)}
        placeholder={
          'For diabetes referrals, I usually need a recent A1c, current diabetes medications, and ' +
          "recent kidney function. Glucose logs or CGM are useful when available, but aren't required. " +
          'I commonly see patients whose diabetes remains poorly controlled despite treatment escalation.'
        }
      />
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <button type="button" className="button-primary" disabled={busy || !sourceText.trim()} onClick={() => void interpret()}>
        {busy ? 'Interpreting…' : 'Interpret preferences'} <span>→</span>
      </button>
    </div>}

    {draft && <div className="referral-pref-review-card">
      <p className={`eyebrow referral-pref-status-${draft.status}`}>{draft.status === 'draft' ? 'Draft -- not yet operational' : draft.status}</p>
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
    </div>}
  </section>
}
