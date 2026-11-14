import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { ApiError } from './api.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import {
  askPublicAgent, getPublicProfile, getSenderStatus, markReferralStarted, respondAsSender, submitPublicReferral, uploadAsSender,
  type PublicAnswer, type PublicSnapshot, type SenderView,
} from './pilotApi.ts'
import { MODALITY_LABELS, pilotPaths } from './pilotState.ts'

type Navigate = (path: string) => void

/* Public, account-free surfaces. They read only the published snapshot (/api/public/p/…)
 * or a sender's own token view (/api/public/r/…) and never attach a signed-in token. */

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.status === 429 ? 'Too many requests — please wait a few minutes and try again.' : err.message) : fallback

function PublicShell({ children }: { children: ReactNode }) {
  return <div className="public-shell">
    <header className="public-header"><span className="brand"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></span><span className="muted-note">Lamina for physicians</span></header>
    <main className="public-main">{children}</main>
    <footer className="public-footer">Information on this page is published by the practice. It is not medical advice. In an emergency, call 911.</footer>
  </div>
}

export function PublicProfileView({ profile, slug, navigate, preview = false }: { profile: PublicSnapshot; slug: string; navigate?: Navigate; preview?: boolean }) {
  const startReferral = () => { if (preview || !navigate) return; void markReferralStarted(slug).catch(() => undefined); navigate(pilotPaths.publicRefer(slug)) }
  return <article className="public-profile">
    <header className="public-hero">
      <div>
        <p className="eyebrow">{profile.practice.specialty ?? 'Physician practice'}</p>
        <h1>{profile.practice.name}</h1>
        {profile.physicians.length > 0 && <p>{profile.physicians.map((physician) => physician.name).join(' · ')}</p>}
        {profile.intro && <p className="public-intro">{profile.intro}</p>}
      </div>
      {profile.accepts_public_referrals && <button className="button-primary" onClick={startReferral} disabled={preview}>Start a referral <span>→</span></button>}
    </header>
    <div className="public-grid">
      <section className="pilot-card">
        <h2>Referrals we see</h2>
        {profile.referral_types.length === 0 && <p className="muted-note">This practice hasn’t published referral criteria yet. Contact them before referring.</p>}
        {profile.referral_types.map((type) => <div key={type.name} className="public-type">
          <h3>{type.name}</h3>
          {type.good_fit.length > 0 && <p><strong>Good fit:</strong> {type.good_fit.join('; ')}</p>}
          {type.not_seen.length > 0 && <p><strong>Not usually seen:</strong> {type.not_seen.join('; ')}</p>}
          {type.required.length > 0 && <p><strong>Please include:</strong> {type.required.map((item) => item.within_days ? `${item.label} (within ${item.within_days} days)` : item.label).join('; ')}</p>}
          {type.helpful.length > 0 && <p><strong>Helpful:</strong> {type.helpful.join('; ')}</p>}
          {type.modality !== 'unspecified' && <p><strong>Usually:</strong> {MODALITY_LABELS[type.modality]}</p>}
        </div>)}
      </section>
      <section className="pilot-card">
        <h2>Practice details</h2>
        <dl className="pilot-facts">
          {profile.locations.length > 0 && <div><dt>Locations</dt><dd>{profile.locations.join('; ')}</dd></div>}
          {profile.hours && <div><dt>Hours</dt><dd>{profile.hours}</dd></div>}
          {profile.modalities.length > 0 && <div><dt>Visit types</dt><dd>{profile.modalities.map((m) => MODALITY_LABELS[m]).join(', ')}</dd></div>}
          {profile.insurance && <div><dt>Insurance</dt><dd>{profile.insurance}</dd></div>}
          {profile.practice.phone && <div><dt>Phone</dt><dd>{profile.practice.phone}</dd></div>}
          {profile.practice.contact_email && <div><dt>Referral email</dt><dd>{profile.practice.contact_email}</dd></div>}
          {profile.practice.website && <div><dt>Website</dt><dd>{profile.practice.website}</dd></div>}
        </dl>
        {profile.how_to_refer && <><h3>How to refer</h3><p>{profile.how_to_refer}</p></>}
      </section>
    </div>
    {!preview && <PublicAsk slug={slug} onStart={startReferral} canRefer={profile.accepts_public_referrals} />}
  </article>
}

function PublicAsk({ slug, onStart, canRefer }: { slug: string; onStart: () => void; canRefer: boolean }) {
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')
  const [showContext, setShowContext] = useState(false)
  const [answers, setAnswers] = useState<Array<{ question: string; answer: PublicAnswer }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ask = async (event: FormEvent) => {
    event.preventDefault()
    if (question.trim().length < 2) return
    setBusy(true); setError('')
    try {
      const answer = await askPublicAgent(slug, question.trim(), showContext ? context.trim() : undefined)
      setAnswers((current) => [...current, { question: question.trim(), answer }]); setQuestion('')
    } catch (err) { setError(errorMessage(err, 'Could not get an answer right now.')) } finally { setBusy(false) }
  }
  return <section className="pilot-card public-ask">
    <div className="pilot-triage-head public-agent-head"><AgentAvatar tone="copper" /><div><p className="eyebrow">Ask about this practice</p><h2>Questions about this practice, answered from what it published</h2></div></div>
    <ul className="public-answers">{answers.map((item, index) => <li key={index}>
      <p className="public-q">{item.question}</p><p className="public-a">{item.answer.answer}</p>
      {item.answer.suggest_referral && canRefer && <button className="text-button" onClick={onStart}>Start a referral →</button>}
    </li>)}</ul>
    <form className="auth-form pilot-form" onSubmit={(event) => void ask(event)}>
      <label><span>Your question</span><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="e.g. What labs should I include?" maxLength={500} disabled={busy} /></label>
      <label className="pilot-check"><input type="checkbox" checked={showContext} onChange={(event) => setShowContext(event.target.checked)} /> Check whether a case fits the published scope</label>
      {showContext && <label><span>Brief case description (no names or identifiers)</span><textarea rows={3} value={context} onChange={(event) => setContext(event.target.value)} maxLength={1500} disabled={busy} /></label>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button className="button-secondary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Ask'}</button>
    </form>
    <p className="muted-note">Answers come only from this practice’s published referral information. Not medical advice; no diagnosis or treatment guidance.</p>
  </section>
}

export function PublicProfilePage({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const [data, setData] = useState<{ profile: PublicSnapshot } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getPublicProfile(slug).then(setData).catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'This practice page isn’t available.' : errorMessage(err, 'Could not load this page.'))) }, [slug])
  return <PublicShell>
    {error && <div className="empty-state"><h2>{error}</h2></div>}
    {!data && !error && <p className="muted-note">Loading…</p>}
    {data && <PublicProfileView profile={data.profile} slug={slug} navigate={navigate} />}
  </PublicShell>
}

/* ------------------------------------------------------------- submission */

type ReferralFormState = { senderName: string; senderPractice: string; senderContact: string; senderNpi: string; patientName: string; patientDob: string; referralType: string; reason: string; context: string; website: string }

export function PublicReferralPage({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const [profile, setProfile] = useState<PublicSnapshot | null>(null)
  const [form, setForm] = useState<ReferralFormState>({ senderName: '', senderPractice: '', senderContact: '', senderNpi: '', patientName: '', patientDob: '', referralType: '', reason: '', context: '', website: '' })
  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ statusUrl: string | null; token: string | null; uploadErrors: string[] } | null>(null)
  useEffect(() => { getPublicProfile(slug).then((data) => setProfile(data.profile)).catch(() => setErrors(['This practice page isn’t available.'])) }, [slug])
  const set = (key: keyof ReferralFormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const required = profile?.referral_types.find((type) => type.name === form.referralType)?.required ?? []
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problems = []
    if (!form.senderName.trim()) problems.push('Enter your name.')
    if (!form.senderContact.trim()) problems.push('Enter a fax, phone, or email so the practice can reach you.')
    if (form.senderNpi.trim() && !/^\d{10}$/.test(form.senderNpi.trim())) problems.push('An NPI is exactly 10 digits.')
    if (!form.patientName.trim()) problems.push('Enter the patient’s name.')
    if (!form.referralType.trim()) problems.push('Choose a referral type.')
    if (form.reason.trim().length < 3) problems.push('Enter the reason for referral.')
    setErrors(problems)
    if (problems.length) return
    setBusy(true)
    try {
      const result = await submitPublicReferral(slug, {
        sender: { name: form.senderName.trim(), practice: form.senderPractice.trim() || null, contact: form.senderContact.trim(), npi: form.senderNpi.trim() || null },
        patient: { name: form.patientName.trim(), date_of_birth: form.patientDob || null },
        referral_type: form.referralType, reason: form.reason.trim(), clinical_context: form.context.trim() || null,
        website: form.website || undefined,
      })
      const uploadErrors: string[] = []
      if (result.token) for (const file of files) {
        try { await uploadAsSender(result.token, file) } catch (err) { uploadErrors.push(`${file.name}: ${errorMessage(err, 'upload failed')}`) }
      }
      setDone({ statusUrl: result.status_url, token: result.token, uploadErrors })
    } catch (err) { setErrors([errorMessage(err, 'Could not send the referral.')]) } finally { setBusy(false) }
  }
  if (done) return <PublicShell><section className="pilot-card public-confirm">
    <p className="eyebrow">Referral sent</p>
    <h1>Thank you — {profile?.practice.name ?? 'the practice'} has your referral</h1>
    <p>Keep this secure link. You can use it to check status and add documents or information the practice requests. It’s the only way back to this referral, and it won’t be shown again.</p>
    {done.statusUrl && <><code className="pilot-link">{done.statusUrl}</code><div className="onboarding-actions"><button className="button-secondary" onClick={() => void navigator.clipboard?.writeText(done.statusUrl ?? '')}>Copy link</button>{done.token && <button className="text-button" onClick={() => navigate(pilotPaths.sender(done.token ?? ''))}>Open status page →</button>}</div></>}
    {done.uploadErrors.length > 0 && <div className="error-banner" role="alert">{done.uploadErrors.map((message) => <p key={message}>{message}</p>)}<p>You can add documents from the status page.</p></div>}
  </section></PublicShell>
  return <PublicShell>
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.publicPage(slug))}>← {profile?.practice.name ?? 'Practice'}</button>
    <h1 className="public-title">Start a referral</h1>
    <p className="muted-note">No account needed. Please don’t include more patient information than the referral requires.</p>
    <form className="auth-form pilot-form public-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <fieldset><legend>You (referring clinician)</legend>
        <div className="pilot-form-row"><label><span>Name</span><input value={form.senderName} onChange={set('senderName')} /></label><label><span>Practice</span><input value={form.senderPractice} onChange={set('senderPractice')} /></label></div>
        <div className="pilot-form-row"><label><span>Fax, phone, or email</span><input value={form.senderContact} onChange={set('senderContact')} /></label><label><span>NPI (optional)</span><input inputMode="numeric" value={form.senderNpi} onChange={set('senderNpi')} /></label></div>
      </fieldset>
      <fieldset><legend>Patient</legend>
        <div className="pilot-form-row"><label><span>Name</span><input value={form.patientName} onChange={set('patientName')} /></label><label><span>Date of birth</span><input type="date" value={form.patientDob} onChange={set('patientDob')} /></label></div>
      </fieldset>
      <fieldset><legend>Referral</legend>
        <label><span>Referral type</span><select value={form.referralType} onChange={set('referralType')}><option value="">Choose…</option>{profile?.referral_types.map((type) => <option key={type.name} value={type.name}>{type.name}</option>)}<option value="Other">Other</option></select></label>
        {required.length > 0 && <p className="muted-note">This practice asks for: {required.map((item) => item.within_days ? `${item.label} (within ${item.within_days} days)` : item.label).join('; ')}. Attach them below if you can.</p>}
        <label><span>Reason for referral</span><textarea rows={3} value={form.reason} onChange={set('reason')} maxLength={4000} /></label>
        <label><span>Clinical context (optional)</span><textarea rows={4} value={form.context} onChange={set('context')} maxLength={8000} /></label>
        <label className="public-honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} /></label>
        <label><span>Documents (PDF, image, or text · 15 MB each)</span><input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 5))} /></label>
      </fieldset>
      {errors.length > 0 && <div className="error-banner" role="alert">{errors.map((message) => <p key={message}>{message}</p>)}</div>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send referral'} <span>→</span></button>
    </form>
  </PublicShell>
}

/* ----------------------------------------------------------------- sender */

export function SenderStatusPage({ token }: { token: string }) {
  const [view, setView] = useState<SenderView | null>(null)
  const [error, setError] = useState('')
  const [values, setValues] = useState<Record<string, { value: string; date: string }>>({})
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  // This page's URL carries the sender's access token: never send it to other sites as a Referer.
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'referrer'; meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])
  useEffect(() => { getSenderStatus(token).then(setView).catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'This link is invalid or has expired. Contact the practice for a new one.' : errorMessage(err, 'Could not load this referral.'))) }, [token])
  const act = async (action: () => Promise<SenderView>, success: string) => {
    setBusy(true); setError(''); setNotice('')
    try { setView(await action()); setNotice(success); setValues({}); setMessage('') } catch (err) { setError(errorMessage(err, 'That didn’t go through. Please try again.')) } finally { setBusy(false) }
  }
  const submitResponse = (event: FormEvent) => {
    event.preventDefault()
    const items = Object.entries(values).filter(([, entry]) => entry.value.trim()).map(([key, entry]) => ({ key, value: entry.value.trim(), observed_date: entry.date || null }))
    if (!items.length && !message.trim()) { setError('Add a value for a requested item or a short message.'); return }
    void act(() => respondAsSender(token, message.trim(), items), 'Thank you — the practice has your response.')
  }
  return <PublicShell>
    {error && !view && <div className="empty-state"><h2>{error}</h2></div>}
    {!view && !error && <p className="muted-note">Loading…</p>}
    {view && <section className="pilot-card public-sender">
      <p className="eyebrow">{view.practice.name}</p>
      <h1>Referral for {view.referral.patient_initials} · {view.referral.referral_type}</h1>
      <p>Status: <strong>{view.referral.status}</strong> · received {new Date(view.referral.received_at).toLocaleDateString()}</p>
      {notice && <p className="pilot-decision" role="status">{notice}</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {view.requested_items.length > 0 && <>
        <h2>Information requested</h2>
        <form className="auth-form pilot-form" onSubmit={submitResponse}>
          {view.requested_items.map((item) => <div key={item.label} className="pilot-form-row">
            <label><span>{item.label}{item.state === 'verified' ? ' — received and checked ✓' : item.received ? ' — received, the practice will review it' : ''}</span>{item.key && !item.received
              ? <input value={values[item.key]?.value ?? ''} onChange={(event) => setValues((current) => ({ ...current, [item.key as string]: { value: event.target.value, date: current[item.key as string]?.date ?? '' } }))} placeholder="Value or summary" disabled={busy || !view.can_respond} />
              : <input value={item.state === 'verified' ? 'Received and checked by the practice' : item.received ? 'Received — awaiting the practice’s review' : 'Upload a document or describe below'} disabled />}</label>
            {item.key && !item.received && <label><span>Date of result</span><input type="date" value={values[item.key]?.date ?? ''} onChange={(event) => setValues((current) => ({ ...current, [item.key as string]: { value: current[item.key as string]?.value ?? '', date: event.target.value } }))} disabled={busy || !view.can_respond} /></label>}
          </div>)}
          <label><span>Message to the practice (optional)</span><textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} disabled={busy || !view.can_respond} /></label>
          <button className="button-primary" type="submit" disabled={busy || !view.can_respond}>{busy ? 'Sending…' : 'Send response'}</button>
        </form>
      </>}
      {view.requested_items.length === 0 && !view.referral.closed && <p className="muted-note">Nothing has been requested right now. You can still add documents below.</p>}
      {view.can_respond && <label className="pilot-upload"><span>Add a document (PDF, image, or text · 15 MB)</span><input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void act(() => uploadAsSender(token, file), `Uploaded ${file.name}.`); event.target.value = '' }} /></label>}
      {view.your_uploads.length > 0 && <><h3>Your uploads</h3><ul className="pilot-documents">{view.your_uploads.map((upload, index) => <li key={index}>{upload.filename}<span className="muted-note"> · {new Date(upload.uploaded_at).toLocaleString()}</span></li>)}</ul></>}
      <p className="muted-note">Questions? {[view.practice.phone, view.practice.contact_email].filter(Boolean).join(' · ') || 'Contact the practice directly.'}</p>
    </section>}
  </PublicShell>
}
