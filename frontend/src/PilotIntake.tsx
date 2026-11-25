import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ApiError } from './api.ts'
import {
  attachIntakeItem, createReferralFromIntake, dismissIntakeItem, getIntakeItem, getPatient, getPracticeRules, intakeDocumentUrl,
  listIntakeItems, listReferrals, mergePatient, replyFromIntake, restoreIntakeItem, splitIntakeItem, undoPatientMerge, uploadIntakeFile,
  type IntakeDocument, type IntakeField, type IntakeItemDetail, type IntakeItemSummary, type PatientDetail, type PilotStatus, type ReferralSummary,
} from './pilotApi.ts'
import {
  DISMISS_REASON_LABELS, INTAKE_CHANNEL_LABELS, INTAKE_FIELD_LABELS, INTAKE_STATUS_LABELS, ROUTED_LABELS, intakeFormFrom, intakeSourceLine,
  parsePageRanges, pilotErrorCopy, pilotPaths, referralFormErrors, referralPayload, regionStyle, type ReferralForm,
} from './pilotState.ts'
import { useOnPilotDataChange } from './pilotSync.ts'
import { PageError, PageLoading } from './pilotUi.tsx'

type Navigate = (path: string) => void
type View = 'open' | 'routed' | 'dismissed'
const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff'

/** Run 3: the staff Intake inbox. Every received document -- upload, fax, email -- waits here until
 * a person routes it (create a referral, attach, answer a request, split) or dismisses it with a
 * reason. Extracted fields are proposals shown beside the document; nothing is verified by them.
 * Physicians see it read-only unless they choose to act on an item. */
export function IntakePage({ status, navigate, params }: { status: PilotStatus; navigate: Navigate; params: URLSearchParams }) {
  const physician = status.role === 'physician'
  const selected = params.get('item')
  const [view, setView] = useState<View>('open')
  const [items, setItems] = useState<IntakeItemSummary[] | null>(null)
  const [error, setError] = useState('')
  // Only the latest request may set the list: switching tabs quickly must not show the old tab's items.
  const latest = useRef(0)
  const load = useCallback(() => {
    const ticket = ++latest.current
    listIntakeItems(view).then((found) => { if (ticket === latest.current) { setItems(found); setError('') } })
      .catch((err) => { if (ticket === latest.current) setError(errorText(err, 'Could not load Intake.')) })
  }, [view])
  useEffect(load, [load])
  useOnPilotDataChange(load)
  if (error && !items) return <main className="page-shell"><PageError title="Intake didn’t load" detail={error} onRetry={load} /></main>
  return <main className="page-shell pilot-intake-page">
    <header className="pilot-intake-header">
      <div>
        <p className="eyebrow">Intake</p>
        <h1>Received documents</h1>
        <p className="page-intro">Faxes, emails and uploads land here first. Check what was read from each one, then create a referral, attach it, split it or dismiss it. Nothing is verified until a person confirms it.</p>
      </div>
    </header>
    {physician && <p className="pilot-intake-readonly" role="note">You’re viewing Intake read-only — your team routes these. Open an item and choose “Act on this item” if you want to handle it yourself.</p>}
    {!physician && <UploadZone onUploaded={(item) => { load(); navigate(pilotPaths.intakeItem(item.id)) }} />}
    <div className="pilot-intake-layout">
      <section className="pilot-intake-list" aria-label="Intake items">
        <div className="pilot-tabs" role="tablist">
          {(['open', 'routed', 'dismissed'] as View[]).map((option) => <button key={option} role="tab" aria-selected={view === option} className={view === option ? 'active' : ''} onClick={() => setView(option)}>
            {option === 'open' ? 'To route' : option === 'routed' ? 'Routed' : 'Dismissed'}
          </button>)}
        </div>
        {!items ? <PageLoading label="Loading Intake…" /> : items.length === 0
          ? <p className="agent-empty-note">{view === 'open' ? 'Nothing waiting. New faxes, emails and uploads appear here.' : 'Nothing here yet.'}</p>
          : <ul className="pilot-intake-items">{items.map((item) => <li key={item.id}>
            <button className={`pilot-intake-row${item.id === selected ? ' selected' : ''}`} onClick={() => navigate(pilotPaths.intakeItem(item.id))}>
              <span className={`pilot-channel-tag channel-${item.channel}`}>{INTAKE_CHANNEL_LABELS[item.channel] ?? item.channel}</span>
              <strong>{item.patient_name ?? (item.extraction_problem ? 'Couldn’t read this document' : 'No patient name found')}</strong>
              <span className="muted-note">{[item.referral_type, `${item.page_count || '?'} page${item.page_count === 1 ? '' : 's'}`, when(item.received_at)].filter(Boolean).join(' · ')}</span>
              <span className="pilot-intake-flags">
                {item.parent_item_id && <em>Split part (pages {item.page_from}–{item.page_to})</em>}
                {(item.several_patients ?? 0) > 1 && <em>{item.several_patients} patients — split?</em>}
                {item.has_request_match && <em>May answer a request</em>}
                {item.has_patient_match && <em>Possible existing patient</em>}
                {item.status === 'needs_review' && <em>Needs a look</em>}
              </span>
            </button>
          </li>)}</ul>}
      </section>
      <section className="pilot-intake-detail" aria-label="Selected item">
        {selected ? <IntakeItem key={selected} id={selected} physician={physician} navigate={navigate} onChange={load} />
          : <p className="agent-empty-note">Choose an item to see the document and what was read from it.</p>}
      </section>
    </div>
  </main>
}

function UploadZone({ onUploaded }: { onUploaded: (item: IntakeItemDetail) => void }) {
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const upload = async (files: File[]) => {
    if (!files.length) return
    setBusy(true); setError('')
    try {
      // Several files dropped together belong to one referral: the first makes the item, the rest join it.
      let item = await uploadIntakeFile(files[0])
      for (const file of files.slice(1)) item = await uploadIntakeFile(file, item.id)
      onUploaded(item)
    } catch (err) { setError(errorText(err, 'Could not upload that file.')) } finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  const drop = (event: DragEvent) => { event.preventDefault(); setOver(false); void upload([...event.dataTransfer.files]) }
  return <div className={`pilot-dropzone${over ? ' over' : ''}`} onDragOver={(event) => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
    <p><strong>Drop referral documents here</strong> — PDF, TIFF, PNG or JPG, up to 15 MB each. Several files dropped together become one referral.</p>
    <label className="button-secondary"><input ref={input} type="file" multiple accept={ACCEPT} aria-label="Upload referral documents" disabled={busy}
      onChange={(event) => void upload([...(event.target.files ?? [])])} />{busy ? 'Uploading…' : 'Choose files'}</label>
    {error && <p className="error-banner" role="alert">{error}</p>}
  </div>
}

function IntakeItem({ id, physician, navigate, onChange }: { id: string; physician: boolean; navigate: Navigate; onChange: () => void }) {
  const [item, setItem] = useState<IntakeItemDetail | null>(null)
  const [error, setError] = useState('')
  const [acting, setActing] = useState(!physician)
  const [mode, setMode] = useState<'' | 'create' | 'attach' | 'split' | 'dismiss'>('')
  const [highlight, setHighlight] = useState<IntakeField | null>(null)
  const load = useCallback(() => { getIntakeItem(id).then(setItem).catch((err) => setError(errorText(err, 'Could not open this item.'))) }, [id])
  useEffect(load, [load])
  if (error) return <p className="error-banner" role="alert">{error}</p>
  if (!item) return <PageLoading label="Opening…" />
  const open = ['received', 'extracted', 'needs_review'].includes(item.status)
  const canAct = item.can_act && acting && open
  const done = (next: IntakeItemDetail) => { setItem(next); setMode(''); onChange() }
  const fields = Object.entries(item.extraction.fields ?? {}) as Array<[string, IntakeField]>
  return <article className="pilot-intake-item" aria-label={`Intake item: ${item.patient_name ?? 'unidentified document'}`}>
    <header>
      <span className={`pilot-channel-tag channel-${item.channel}`}>{INTAKE_CHANNEL_LABELS[item.channel]}</span>
      <h2>{item.patient_name ?? 'No patient name found'}</h2>
      <p className="muted-note">{intakeSourceLine(item)} · received {when(item.received_at)} · {INTAKE_STATUS_LABELS[item.status]}</p>
    </header>
    {item.status === 'routed' && item.routed_kind && <p className="pilot-intake-outcome" role="status">{ROUTED_LABELS[item.routed_kind]}. <button className="text-button" onClick={() => navigate(pilotPaths.referral(item.routed_referral_id ?? ''))}>Open the referral →</button></p>}
    {item.status === 'dismissed' && <p className="pilot-intake-outcome" role="status">Dismissed: {DISMISS_REASON_LABELS[item.dismissed_reason ?? ''] ?? item.dismissed_reason}{item.dismissed_note ? ` — “${item.dismissed_note}”` : ''}.
      {item.can_act && <button className="text-button" onClick={() => void restoreIntakeItem(item.id).then(done)}>Restore to Intake</button>}</p>}
    {item.status === 'split' && <div className="pilot-intake-outcome" role="status"><p>Split into {item.children.length} items:</p><ul>{item.children.map((child) =>
      <li key={child.id}><button className="text-button" onClick={() => navigate(pilotPaths.intakeItem(child.id))}>Pages {child.page_from}–{child.page_to}: {child.patient_name ?? 'unidentified'}</button></li>)}</ul></div>}
    {(item.extraction.patients_found ?? []).length > 1 && open && <p className="pilot-intake-multiple" role="note">
      <strong>This looks like {item.extraction.patients_found?.length} referrals:</strong> {(item.extraction.patients_found ?? []).map((found) => `${found.name} (from page ${found.page})`).join(', ')}. Split it by page so each becomes its own referral.
    </p>}
    {physician && open && !acting && <p className="pilot-intake-readonly">Read-only. <button className="button-secondary" onClick={() => setActing(true)}>Act on this item</button></p>}
    <div className="pilot-intake-columns">
      <div className="pilot-intake-documents" aria-label="Received document">
        {item.documents.map((document) => <DocumentPreview key={document.id} document={document} highlight={highlight} />)}
      </div>
      <div className="pilot-intake-extraction" aria-label="What was read from it">
        <h3>Read from the document <small>proposals — check before using</small></h3>
        {fields.length === 0 ? <p className="muted-note">Nothing could be read automatically{item.extraction_problem ? ' (this file has no readable text)' : ''}. Fill in the referral from the document.</p>
          : <dl className="pilot-intake-fields">{fields.map(([name, field]) => <div key={name} onMouseEnter={() => setHighlight(field)} onMouseLeave={() => setHighlight(null)} onFocus={() => setHighlight(field)} tabIndex={0}>
            <dt>{INTAKE_FIELD_LABELS[name] ?? name}</dt>
            <dd>{field.value}<small> · page {field.page}{field.source === 'model' ? ' · model-read' : ''}</small></dd>
          </div>)}</dl>}
        {(item.extraction.results ?? []).length > 0 && <>
          <h4>Attached results</h4>
          <ul className="pilot-intake-results">{(item.extraction.results ?? []).map((result, index) => <li key={index}>{result.text}<small> · {result.date ? `dated ${result.date}` : 'no date found'} · page {result.page}</small></li>)}</ul>
          <p className="muted-note">Results stay documents: after the referral is created, triage proposes them and a person confirms each one.</p>
        </>}
        <Suggestions item={item} canAct={canAct} navigate={navigate} onReplied={(referralId) => { onChange(); navigate(pilotPaths.referral(referralId)) }} />
      </div>
    </div>
    {canAct && <div className="pilot-intake-actions">
      <div className="pilot-actions">
        <button className="button-primary" onClick={() => setMode('create')}>Create referral…</button>
        <button className="button-secondary" onClick={() => setMode('attach')}>Attach to a referral…</button>
        {item.documents.length === 1 && (item.documents[0].page_count ?? 0) > 1 && <button className="button-secondary" onClick={() => setMode('split')}>Split by page…</button>}
        <button className="text-button" onClick={() => setMode('dismiss')}>Dismiss…</button>
      </div>
      {mode === 'create' && <CreateReferralForm item={item} onCancel={() => setMode('')} onCreated={(referralId) => { onChange(); navigate(pilotPaths.referral(referralId)) }} />}
      {mode === 'attach' && <AttachForm item={item} onCancel={() => setMode('')} onAttached={(referralId) => { onChange(); navigate(pilotPaths.referral(referralId)) }} />}
      {mode === 'split' && <SplitForm item={item} onCancel={() => setMode('')} onSplit={done} />}
      {mode === 'dismiss' && <DismissForm item={item} onCancel={() => setMode('')} onDismissed={done} />}
    </div>}
  </article>
}

function DocumentPreview({ document, highlight }: { document: IntakeDocument; highlight: IntakeField | null }) {
  const [url, setUrl] = useState<string | null>(null)
  const image = document.content_type.startsWith('image/') && document.content_type !== 'image/tiff'
  useEffect(() => {
    if (!image) return undefined
    let live = true
    let made: string | null = null
    intakeDocumentUrl(document.id).then((found) => { made = found; if (live) setUrl(found) }).catch(() => undefined)
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [document.id, image])
  const openOriginal = async () => { const found = await intakeDocumentUrl(document.id); window.open(found, '_blank', 'noopener') }
  const pageOf = (index: number) => document.first_page + index
  return <figure className="pilot-intake-document">
    <figcaption><strong>{document.role === 'email_body' ? 'Email text' : document.filename}</strong>
      <small> · {document.page_count ?? '?'} page{document.page_count === 1 ? '' : 's'}{document.extraction_status !== 'extracted' ? ' · no readable text' : ''}</small>
      <button className="text-button" onClick={() => void openOriginal()}>Open original</button></figcaption>
    {image && url ? <div className="pilot-intake-page image">
      <img src={url} alt={`Received document ${document.filename}`} />
      {highlight && highlight.page === document.first_page && <span className="pilot-intake-region" style={regionStyle(highlight.bbox)} aria-hidden="true" />}
    </div> : document.pages.map((page, index) => <div className="pilot-intake-page text" key={index} aria-label={`Page ${pageOf(index)}`}>
      <span className="pilot-intake-page-number">Page {pageOf(index)}</span>
      {page.lines.map((line, row) => <p key={row} className={highlight && highlight.page === pageOf(index) && highlight.bbox.join() === line.bbox.join() ? 'highlighted' : ''}>{line.text}</p>)}
    </div>)}
  </figure>
}

function Suggestions({ item, canAct, navigate, onReplied }: { item: IntakeItemDetail; canAct: boolean; navigate: Navigate; onReplied: (referralId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requests = item.suggestions.requests ?? []
  const patients = item.suggestions.patients ?? []
  const reply = async (requestId: string) => {
    setBusy(true); setError('')
    try { const detail = await replyFromIntake(item.id, requestId); onReplied(detail.referral.id) }
    catch (err) { setError(errorText(err, 'Could not attach the reply.')) } finally { setBusy(false) }
  }
  if (!requests.length && !patients.length && !item.suggestions.referral_type) return null
  return <div className="pilot-intake-suggestions">
    <h3>Suggestions <small>a person confirms</small></h3>
    {item.suggestions.referral_type && <p>Referral type: <strong>{item.suggestions.referral_type}</strong> (one of your practice’s types)</p>}
    {requests.map((request) => <div className="pilot-intake-suggestion" key={request.request_id} role="group" aria-label="Possible reply to an information request">
      <p><strong>May answer the information request for {request.patient_name}</strong> ({request.items.join(', ') || 'requested items'}) — {request.reasons.join(', ')}.</p>
      {canAct && <button className="button-secondary" disabled={busy} onClick={() => void reply(request.request_id)}>Yes — attach as the reply</button>}
      <button className="text-button" onClick={() => navigate(pilotPaths.referral(request.referral_id))}>Open that referral</button>
    </div>)}
    {patients.map((match) => <p className="pilot-intake-suggestion" key={match.patient.id}>
      {match.strength === 'strong' ? 'Likely' : 'Possibly'} an existing patient: <button className="text-button" onClick={() => navigate(pilotPaths.patient(match.patient.id))}>{match.patient.name}</button>{match.patient.date_of_birth ? ` (born ${match.patient.date_of_birth})` : ''} — {match.reasons.join(', ')}. Choose it when you create the referral.
    </p>)}
    {error && <p className="error-banner" role="alert">{error}</p>}
  </div>
}

function CreateReferralForm({ item, onCancel, onCreated }: { item: IntakeItemDetail; onCancel: () => void; onCreated: (referralId: string) => void }) {
  const [form, setForm] = useState<ReferralForm>(() => intakeFormFrom(item.extraction as never, item.suggestions.referral_type))
  const [types, setTypes] = useState<string[]>([])
  const [patientId, setPatientId] = useState<string>('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { getPracticeRules().then((rules) => setTypes([...new Set(rules.map((rule) => rule.referral_type))].sort())).catch(() => setTypes([])) }, [])
  const set = (key: keyof ReferralForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const found = referralFormErrors(form)
    setErrors(found)
    if (found.length) return
    setBusy(true)
    try { const detail = await createReferralFromIntake(item.id, referralPayload(form, true), patientId || null); onCreated(detail.referral.id) }
    catch (err) { setErrors([errorText(err, 'Could not create the referral.')]) } finally { setBusy(false) }
  }
  const matches = item.suggestions.patients ?? []
  return <form className="pilot-intake-form" onSubmit={(event) => void submit(event)} aria-label="Create a referral from this document">
    <p className="muted-note">Prefilled from what was read — check every field against the document.</p>
    <div className="pilot-form-grid">
      <label><span>Patient name</span><input value={form.patientName} onChange={set('patientName')} required /></label>
      <label><span>Date of birth</span><input type="date" value={form.patientDob} onChange={set('patientDob')} /></label>
      <label><span>Patient phone</span><input value={form.patientPhone} onChange={set('patientPhone')} /></label>
      <label><span>MRN / external id</span><input value={form.patientExternalId} onChange={set('patientExternalId')} /></label>
      <label><span>Referring clinician</span><input value={form.senderName} onChange={set('senderName')} required /></label>
      <label><span>Referring practice</span><input value={form.senderPractice} onChange={set('senderPractice')} /></label>
      <label><span>Office contact / fax</span><input value={form.senderContact} onChange={set('senderContact')} /></label>
      <label><span>Referral type</span><input list="intake-referral-types" value={form.referralType} onChange={set('referralType')} required /></label>
      <datalist id="intake-referral-types">{types.map((type) => <option key={type} value={type} />)}</datalist>
      <label className="wide"><span>Referral question</span><textarea rows={2} value={form.reason} onChange={set('reason')} required /></label>
    </div>
    <fieldset className="pilot-patient-choice">
      <legend>Patient record</legend>
      <label><input type="radio" name="patient" checked={!patientId} onChange={() => setPatientId('')} /> A new patient record</label>
      {matches.map((match) => <label key={match.patient.id}><input type="radio" name="patient" checked={patientId === match.patient.id} onChange={() => setPatientId(match.patient.id)} /> Existing: {match.patient.name}{match.patient.date_of_birth ? `, born ${match.patient.date_of_birth}` : ''} <small>({match.reasons.join(', ')})</small></label>)}
    </fieldset>
    {errors.length > 0 && <div className="error-banner" role="alert">{errors.map((text) => <p key={text}>{text}</p>)}</div>}
    <div className="onboarding-actions"><button className="button-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create referral and triage'}</button><button type="button" className="text-button" onClick={onCancel}>Cancel</button></div>
  </form>
}

function AttachForm({ item, onCancel, onAttached }: { item: IntakeItemDetail; onCancel: () => void; onAttached: (referralId: string) => void }) {
  const [referrals, setReferrals] = useState<ReferralSummary[]>([])
  const [choice, setChoice] = useState(item.suggestions.referrals?.[0]?.referral_id ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { listReferrals().then((found) => setReferrals(found.filter((referral) => !['accepted', 'redirected', 'declined'].includes(referral.status)))).catch(() => setReferrals([])) }, [])
  const attach = async () => {
    if (!choice) { setError('Choose a referral.'); return }
    setBusy(true); setError('')
    try { const detail = await attachIntakeItem(item.id, choice); onAttached(detail.referral.id) } catch (err) { setError(errorText(err, 'Could not attach it.')) } finally { setBusy(false) }
  }
  return <div className="pilot-intake-form" role="group" aria-label="Attach to an existing referral">
    <label><span>Referral</span><select value={choice} onChange={(event) => setChoice(event.target.value)}>
      <option value="">Choose…</option>
      {referrals.map((referral) => <option key={referral.id} value={referral.id}>{referral.patient_name} — {referral.referral_type}</option>)}
    </select></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void attach()}>{busy ? 'Attaching…' : 'Attach and re-triage'}</button><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

function SplitForm({ item, onCancel, onSplit }: { item: IntakeItemDetail; onCancel: () => void; onSplit: (item: IntakeItemDetail) => void }) {
  const total = item.documents[0]?.page_count ?? 0
  const starts = (item.extraction.patients_found ?? []).map((found) => found.page).filter((page) => page > 1)
  const cut = starts[0] ?? Math.floor(total / 2) + 1
  const [text, setText] = useState(total >= 2 ? `1-${cut - 1}, ${cut}-${total}` : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const split = async () => {
    const ranges = parsePageRanges(text, total)
    if (!ranges) { setError(`Give at least two page ranges that cover pages 1–${total} once each, e.g. “1-2, 3-${total}”.`); return }
    setBusy(true); setError('')
    try { onSplit(await splitIntakeItem(item.id, ranges)) } catch (err) { setError(errorText(err, 'Could not split it.')) } finally { setBusy(false) }
  }
  return <div className="pilot-intake-form" role="group" aria-label="Split by page">
    <label><span>Page ranges, one per referral ({total} pages)</span><input value={text} onChange={(event) => setText(event.target.value)} /></label>
    <p className="muted-note">Every page goes into exactly one part; each part is read again on its own.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void split()}>{busy ? 'Splitting…' : 'Split'}</button><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

function DismissForm({ item, onCancel, onDismissed }: { item: IntakeItemDetail; onCancel: () => void; onDismissed: (item: IntakeItemDetail) => void }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dismiss = async () => {
    if (!reason) { setError('Choose a reason.'); return }
    if (reason === 'other' && !note.trim()) { setError('Say why it is being dismissed.'); return }
    setBusy(true); setError('')
    try { onDismissed(await dismissIntakeItem(item.id, reason, note)) } catch (err) { setError(errorText(err, 'Could not dismiss it.')) } finally { setBusy(false) }
  }
  return <div className="pilot-intake-form" role="group" aria-label="Dismiss this document">
    <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)}>
      <option value="">Choose…</option>{item.dismiss_reasons.map((value) => <option key={value} value={value}>{DISMISS_REASON_LABELS[value] ?? value}</option>)}
    </select></label>
    <label><span>Note {reason === 'other' ? '' : '(optional)'}</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
    <p className="muted-note">Dismissed items stay under “Dismissed” and can be restored.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void dismiss()}>{busy ? 'Dismissing…' : 'Dismiss'}</button><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

/* ------------------------------------------------------------------------ patient record */

/** A patient record: its referrals, possible duplicates (suggested, never merged automatically),
 * and every merge -- each reversible. */
export function PatientPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const [detail, setDetail] = useState<PatientDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const load = useCallback(() => { getPatient(id).then(setDetail).catch((err) => setError(errorText(err, 'Could not open this patient.'))) }, [id])
  useEffect(load, [load])
  useOnPilotDataChange(load)
  const act = async (action: () => Promise<PatientDetail>) => {
    setBusy(true); setError('')
    try { const next = await action(); setConfirming(null); if (next.patient.id !== id) navigate(pilotPaths.patient(next.patient.id)); else setDetail(next) }
    catch (err) { setError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  if (error && !detail) return <main className="page-shell"><PageError title="Patient didn’t load" detail={error} onRetry={load} /></main>
  if (!detail) return <main className="page-shell"><PageLoading label="Opening patient…" /></main>
  const { patient } = detail
  return <main className="page-shell pilot-patient-page">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.patients)}>← All patients</button>
    <p className="eyebrow">Patient record</p>
    <h1>{patient.name}</h1>
    <p className="muted-note">{[patient.date_of_birth && `Born ${patient.date_of_birth}`, patient.mrn && `MRN ${patient.mrn}`, patient.phone_last4 && `phone ending ${patient.phone_last4}`].filter(Boolean).join(' · ') || 'No date of birth recorded'}</p>
    {patient.merged_into_id && <p className="pilot-intake-outcome" role="status">This record was merged into another. <button className="text-button" onClick={() => navigate(pilotPaths.patient(patient.merged_into_id ?? ''))}>Open the current record →</button></p>}
    <section className="clinical-block"><h3>Referrals</h3>
      {detail.referrals.length === 0 ? <p className="muted-note">No referrals on this record.</p>
        : <ul className="pilot-patient-referrals">{detail.referrals.map((referral) => <li key={referral.id}><button className="text-button" onClick={() => navigate(pilotPaths.referral(referral.id))}>{referral.referral_type}</button> <small className="muted-note">received {when(referral.received_at)} · {referral.status.replace(/_/g, ' ')}</small></li>)}</ul>}
    </section>
    {detail.possible_duplicates.length > 0 && <section className="clinical-block" aria-label="Possible duplicates"><h3>Possible duplicate records</h3>
      <p className="muted-note">Suggested from name, date of birth, phone and MRN. Records are only merged when a person confirms — and a merge can be undone.</p>
      {detail.possible_duplicates.map((match) => <div className="pilot-intake-suggestion" key={match.patient.id}>
        <p><strong>{match.patient.name}</strong>{match.patient.date_of_birth ? ` · born ${match.patient.date_of_birth}` : ''} — {match.strength === 'strong' ? 'likely the same patient' : 'possibly the same patient'} ({match.reasons.join(', ')})</p>
        {confirming === match.patient.id ? <div className="pilot-actions">
          <button className="button-primary" disabled={busy} onClick={() => void act(() => mergePatient(patient.id, match.patient.id, 'Confirmed the same patient'))}>Confirm: merge this record into {match.patient.name}</button>
          <button className="text-button" onClick={() => setConfirming(null)}>Cancel</button>
        </div> : <div className="pilot-actions">
          <button className="button-secondary" onClick={() => setConfirming(match.patient.id)}>Same patient — merge…</button>
          <button className="text-button" onClick={() => navigate(pilotPaths.patient(match.patient.id))}>Open that record</button>
        </div>}
      </div>)}
    </section>}
    {detail.merges.length > 0 && <section className="clinical-block" aria-label="Merge history"><h3>Merge history</h3>
      <ul className="pilot-merge-history">{detail.merges.map((merge) => <li key={merge.id}>
        {merge.action === 'merge' ? 'Merged' : 'Unmerged'} · {when(merge.created_at)} · {merge.referral_ids.length} referral{merge.referral_ids.length === 1 ? '' : 's'} moved{merge.reason ? ` — “${merge.reason}”` : ''}
        {merge.action === 'merge' && !merge.undone && <button className="text-button" disabled={busy} onClick={() => void act(() => undoPatientMerge(merge.id, 'Not the same patient'))}>Undo merge</button>}
        {merge.action === 'merge' && merge.undone && <small className="muted-note"> · undone</small>}
      </li>)}</ul>
    </section>}
    {error && <p className="error-banner" role="alert">{error}</p>}
  </main>
}
