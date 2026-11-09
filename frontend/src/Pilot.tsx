import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { useAuth } from './AuthProvider.tsx'
import { ApiError } from './api.ts'
import { ClaimShell, initials, signInPath, signUpPath, SignInPage, SignUpPage } from './Claim.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { PhysicianOnboardingPage } from './Onboarding.tsx'
import {
  acceptInvitation, approveTriage, createPractice, createPracticeRule, createReferral, decideReferral,
  editTriage, escalateReferral, getPilotStatus, getPracticeMembers, getPracticeRules, getReferral,
  inviteStaff, listReferrals, openReferralDocument, previewInvitation, recordReferralItem, rejectTriage,
  removeStaffMember, requestInformation, retirePracticeRule, retriageReferral, revisePracticeRule,
  revokeInvitation, updatePractice, uploadReferralDocument,
  type EffectiveTriage, type Fit, type Modality, type NextStep, type PilotStatus, type PracticeFields,
  type PracticeInvitation, type PracticeMember, type PracticeRule, type Priority, type ReferralDetail,
  type ReferralSummary, type RequirementAssessment,
} from './pilotApi.ts'
import {
  briefingLines, canUse, emptyReferralForm, emptyRuleForm, FIT_LABELS, homeBuckets, isClosed, MODALITY_LABELS,
  NEXT_STEP_LABELS, pilotErrorCopy, pilotPaths, PRIORITY_LABELS, REQUIREMENT_STATE_LABELS, referralFormErrors,
  referralPayload, resolvePilotRoute, ruleFormFrom, ruleInput, STATUS_LABELS, triageHeadline,
  type ReferralForm, type RuleForm,
} from './pilotState.ts'

type Navigate = (path: string) => void

const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const formatDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const formatDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/* ------------------------------------------------------------------- app */

/** The entire pilot-mode frontend. Only onboarding, join, sign-in, and /me/* pilot
 * routes resolve; every synthetic demo path redirects to the pilot home. */
export function PilotApp({ path, params, navigate }: { path: string; params: URLSearchParams; navigate: Navigate }) {
  const route = resolvePilotRoute(path)
  useEffect(() => { if (route.kind === 'redirect') navigate(route.to) }, [route.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  switch (route.kind) {
    case 'redirect': return <main className="page-shell owner-gate"><p className="muted-note">Opening Lamina…</p></main>
    case 'auth': return route.page === 'sign-in' ? <SignInPage navigate={navigate} params={params} /> : <SignUpPage navigate={navigate} params={params} />
    case 'join': return <JoinPracticePage navigate={navigate} params={params} />
    case 'onboarding':
    case 'home': return <PilotGate navigate={navigate} params={params}>{(status, reload) => <PilotShell status={status} navigate={navigate} section="home"><PilotHomePage status={status} navigate={navigate} reload={reload} /></PilotShell>}</PilotGate>
    case 'referrals': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="referrals"><ReferralsPage navigate={navigate} /></PilotShell>}</PilotGate>
    case 'new_referral': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="referrals"><NewReferralPage navigate={navigate} /></PilotShell>}</PilotGate>
    case 'referral': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="referrals"><ReferralDetailPage id={route.id} status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'practice': return <PilotGate navigate={navigate} params={params}>{(status, reload) => <PilotShell status={status} navigate={navigate} section="practice"><PracticePage status={status} reload={reload} /></PilotShell>}</PilotGate>
    case 'rules': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="rules"><RulesPage status={status} /></PilotShell>}</PilotGate>
  }
}

/* ------------------------------------------------------------------ gate */

/** Server-derived gate: sign in → confirm profile → practice setup → approval → workspace. */
function PilotGate({ navigate, params, children }: { navigate: Navigate; params: URLSearchParams; children: (status: PilotStatus, reload: () => void) => ReactNode }) {
  const { configured, loading, user } = useAuth()
  const [status, setStatus] = useState<PilotStatus | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    getPilotStatus().then((next) => { setStatus(next); setError('') }).catch((err) => setError(errorText(err, 'Could not open your workspace')))
  }, [])
  useEffect(() => { setStatus(null); if (user) reload() }, [user, reload])

  if (!configured) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Authentication is not configured in this environment.</p></div></ClaimShell>
  if (loading) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your session…</p></div></ClaimShell>
  if (!user) return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Lamina for specialty practices</p>
    <h1>Your practice’s referral agent</h1>
    <p>Lamina reviews incoming referrals against how your practice works, prepares what it can, and surfaces only the decisions that need you.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(signUpPath(pilotPaths.home))}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(pilotPaths.home))}>Sign in</button>
    </div>
    <p className="muted-note">Joining a practice as staff? Open the invitation link your physician sent you.</p>
  </div></ClaimShell>
  if (error) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><div className="error-banner" role="alert">{error}</div><button className="text-button" onClick={reload}>Try again</button></div></ClaimShell>
  if (!status) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Opening your workspace…</p></div></ClaimShell>

  switch (status.next_step) {
    case 'physician_onboarding': return <PhysicianOnboardingPage navigate={navigate} params={params} onConfirmed={reload} />
    case 'practice_setup': return <PracticeSetupPage status={status} navigate={navigate} onCreated={reload} />
    case 'pilot_pending':
    case 'practice_pending': return <PendingPage status={status} navigate={navigate} reload={reload} />
    case 'unavailable': return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="eyebrow">Lamina pilot</p><h1>Workspace unavailable</h1><p>This account can’t open a pilot workspace right now. Contact the Lamina team if you believe this is a mistake.</p></div></ClaimShell>
    case 'workspace': return <>{children(status, reload)}</>
  }
}

function PracticeFieldsForm({ initial, submitLabel, busyLabel, onSubmit }: { initial: Partial<PracticeFields>; submitLabel: string; busyLabel: string; onSubmit: (fields: PracticeFields) => Promise<void> }) {
  const [fields, setFields] = useState<PracticeFields>({ name: initial.name ?? '', specialty: initial.specialty ?? '', website: initial.website ?? '', address: initial.address ?? '', phone: initial.phone ?? '', contact_email: initial.contact_email ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof PracticeFields) => (event: React.ChangeEvent<HTMLInputElement>) => setFields((current) => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!fields.name?.trim()) { setError('Enter the practice name.'); return }
    setBusy(true); setError('')
    try { await onSubmit(fields) } catch (err) { setError(errorText(err, 'Could not save the practice.')) } finally { setBusy(false) }
  }
  return <form className="auth-form pilot-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
    <label><span>Practice name</span><input value={fields.name ?? ''} onChange={set('name')} required disabled={busy} /></label>
    <label><span>Specialty</span><input value={fields.specialty ?? ''} onChange={set('specialty')} disabled={busy} /></label>
    <label><span>Address</span><input value={fields.address ?? ''} onChange={set('address')} disabled={busy} /></label>
    <div className="pilot-form-row">
      <label><span>Phone</span><input value={fields.phone ?? ''} onChange={set('phone')} disabled={busy} /></label>
      <label><span>Referral contact email</span><input type="email" value={fields.contact_email ?? ''} onChange={set('contact_email')} disabled={busy} /></label>
    </div>
    <label><span>Website</span><input value={fields.website ?? ''} onChange={set('website')} disabled={busy} /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <button className="button-primary" type="submit" disabled={busy}>{busy ? busyLabel : submitLabel} <span>→</span></button>
  </form>
}

function PracticeSetupPage({ status, navigate, onCreated }: { status: PilotStatus; navigate: Navigate; onCreated: () => void }) {
  const defaults = status.practice_defaults
  const identity = status.physician_onboarding.confirmed_identity?.identity
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Step 3 · Your practice</p>
    <h1>Set up your practice</h1>
    <p>Referrals, rules, and your team belong to the practice. {identity ? `We prefilled what NPPES lists for ${identity.display_name}.` : ''} Confirm or edit it — nothing here is published.</p>
    {defaults?.source && <p className="muted-note">{defaults.source}</p>}
    <PracticeFieldsForm initial={defaults ?? {}} submitLabel="Create practice" busyLabel="Creating…" onSubmit={async (fields) => { await createPractice(fields); onCreated() }} />
    <p className="muted-note">You can invite staff after the practice is created.</p>
  </div></ClaimShell>
}

function PendingPage({ status, navigate, reload }: { status: PilotStatus; navigate: Navigate; reload: () => void }) {
  const staff = status.next_step === 'practice_pending'
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Pilot approval</p>
    <h1>{status.practice?.name ?? 'Your practice'} is awaiting approval</h1>
    <p>{staff
      ? 'You’ve joined this practice. Its workspace opens once Lamina approves the practice’s physician.'
      : 'Your professional profile is confirmed and your practice is set up. Lamina is onboarding a small number of pilot practices; your workspace opens here once the team approves your account.'}</p>
    <p className="muted-note">No referral or patient information is available until approval.</p>
    <button className="text-button" onClick={reload}>Check status again</button>
  </div></ClaimShell>
}

function JoinPracticePage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, loading, user } = useAuth()
  const [token] = useState(() => params.get('invite') ?? '')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewInvitation>> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const returnHere = `${pilotPaths.join}?invite=${encodeURIComponent(token)}`
  useEffect(() => {
    if (!user || !token) return
    previewInvitation(token).then(setPreview).catch((err) => setError(errorText(err, 'This invitation could not be opened.')))
  }, [user, token])
  if (!configured || loading) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your session…</p></div></ClaimShell>
  if (!token) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><h1>Invitation link missing</h1><p>Open the full invitation link your physician sent you.</p></div></ClaimShell>
  if (!user) return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Practice invitation</p><h1>Join your practice on Lamina</h1>
    <p>Create an account or sign in to accept this staff invitation.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(signUpPath(returnHere))}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(returnHere))}>I already have an account</button>
    </div>
  </div></ClaimShell>
  const accept = async () => {
    setBusy(true); setError('')
    try { await acceptInvitation(token); navigate(pilotPaths.home) } catch (err) { setError(errorText(err, 'Could not accept this invitation.')) } finally { setBusy(false) }
  }
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Practice invitation</p>
    <h1>{preview?.practice_name ? `Join ${preview.practice_name}` : 'Join a practice'}</h1>
    {preview && <p>You’ll join as staff{preview.practice_specialty ? ` · ${preview.practice_specialty}` : ''}. Staff can enter and review referrals; physicians make the final decisions.</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {preview && <button className="button-primary" disabled={busy} onClick={() => void accept()}>{busy ? 'Joining…' : 'Accept invitation'} <span>→</span></button>}
  </div></ClaimShell>
}

/* ----------------------------------------------------------------- shell */

const NAV = [
  { id: 'home', title: 'Home', icon: '⌂', path: pilotPaths.home },
  { id: 'referrals', title: 'Referrals', icon: '↘', path: pilotPaths.referrals },
  { id: 'rules', title: 'Referral rules', icon: '≡', path: pilotPaths.rules },
  { id: 'practice', title: 'Practice', icon: '◎', path: pilotPaths.practice },
] as const

function PilotShell({ status, navigate, section, children }: { status: PilotStatus; navigate: Navigate; section: string; children: ReactNode }) {
  const { user, signOut } = useAuth()
  const practice = status.practice
  return <div className="app-shell owner-shell pilot-shell">
    <aside className="sidebar">
      <div>
        <button className="brand-button" onClick={() => navigate(pilotPaths.home)} aria-label="Lamina home"><div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div></button>
        <p className="brand-subtitle">{practice?.name ?? 'Your practice'}</p>
        <nav aria-label="Primary navigation">
          {NAV.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span><b>{item.title}</b></span></button>)}
        </nav>
      </div>
      <div className="sidebar-clinician pilot-agent-card">
        <LaminaMark active />
        <div><span>Practice agent</span><strong>Shadow mode</strong><small>Recommends · your team decides</small></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="workspace-bar">
        <div className="workspace-bar-actions">
          <div className="synthetic-status owner-status pilot-status"><span />Pilot · {status.role === 'physician' ? 'Physician' : 'Staff'}</div>
          <span className="pilot-user">{user?.email ?? ''}</span>
          <button className="text-button" onClick={() => void signOut().then(() => navigate(pilotPaths.home))}>Sign out</button>
        </div>
      </header>
      {children}
    </div>
  </div>
}

/* ------------------------------------------------------------------ home */

function ReferralRow({ item, navigate }: { item: ReferralSummary; navigate: Navigate }) {
  return <button className="lam-row pilot-referral-row" onClick={() => navigate(pilotPaths.referral(item.id))}>
    <span className="lam-row-mark directory-avatar">{initials(item.patient_name)}</span>
    <span className="lam-row-main">
      <strong>{item.patient_name} <small className="pilot-type">{item.referral_type}</small></strong>
      <span>{triageHeadline(item)}</span>
      <span className="pilot-row-meta">From {item.sender_name}{item.sender_practice ? `, ${item.sender_practice}` : ''} · received {formatDate(item.received_at)}{item.escalated ? ' · flagged for physician' : ''}</span>
    </span>
    <span className={`pilot-status-pill status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
  </button>
}

function PilotHomePage({ status, navigate }: { status: PilotStatus; navigate: Navigate; reload: () => void }) {
  const [items, setItems] = useState<ReferralSummary[] | null>(null)
  const [rules, setRules] = useState<PracticeRule[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    listReferrals().then(setItems).catch((err) => setError(errorText(err, 'Could not load referrals')))
    getPracticeRules().then(setRules).catch(() => setRules([]))
  }, [])
  const role = status.role ?? 'staff'
  const buckets = items ? homeBuckets(items) : null
  const lines = buckets ? briefingLines(buckets, role) : []
  const openItems = buckets ? [...buckets.attention, ...buckets.ready, ...buckets.missing] : []
  return <main className="page-shell home-page pilot-home">
    <section className="pilot-briefing">
      <div className="pilot-briefing-mark"><LaminaMark active /></div>
      <div>
        <p className="eyebrow">Your practice agent</p>
        {!items && !error && <h1>Reviewing your referrals…</h1>}
        {items && (lines.length
          ? <><h1>{lines[0]}</h1>{lines.slice(1).map((line) => <p key={line}>{line}</p>)}</>
          : <h1>Nothing needs you right now.</h1>)}
        <p className="muted-note">Shadow mode: I prepare triage and drafts; nothing is sent, scheduled, or decided without your team.</p>
      </div>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {rules && rules.length === 0 && <section className="pilot-callout">
      <h2>Teach Lamina your referral criteria</h2>
      <p>{role === 'physician'
        ? 'Add a rule for each kind of referral you see — what fits, what is out of scope, and what information you need. Until then I can record referrals but can’t judge fit or completeness.'
        : 'The physician hasn’t added referral rules yet, so I can record referrals but can’t judge fit or completeness.'}</p>
      {role === 'physician' && <button className="button-primary" onClick={() => navigate(pilotPaths.rules)}>Add referral rules <span>→</span></button>}
    </section>}
    <div className="pilot-section-head"><h2>Needs attention</h2><button className="button-primary" onClick={() => navigate(pilotPaths.newReferral)}>New referral <span>+</span></button></div>
    {items && openItems.length === 0 && <div className="empty-state"><h2>No open referrals</h2><p>Enter a referral you received by fax, email, or phone to get a triage in seconds.</p></div>}
    {openItems.length > 0 && <div className="lam-list needs-attention">{openItems.map((item) => <ReferralRow key={item.id} item={item} navigate={navigate} />)}</div>}
  </main>
}

/* ------------------------------------------------------------- referrals */

function ReferralsPage({ navigate }: { navigate: Navigate }) {
  const [items, setItems] = useState<ReferralSummary[] | null>(null)
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const [error, setError] = useState('')
  useEffect(() => { listReferrals().then(setItems).catch((err) => setError(errorText(err, 'Could not load referrals'))) }, [])
  const shown = (items ?? []).filter((item) => (tab === 'closed') === isClosed(item.status))
  return <main className="page-shell pilot-page">
    <div className="pilot-section-head"><div><h1>Referrals</h1><p className="muted-note">Every referral your practice has received in Lamina.</p></div><button className="button-primary" onClick={() => navigate(pilotPaths.newReferral)}>New referral <span>+</span></button></div>
    <nav className="agent-tabs" aria-label="Referral filter">{(['open', 'closed'] as const).map((value) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'open' ? 'Open' : 'Closed'}</button>)}</nav>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!items && !error && <p className="muted-note">Loading…</p>}
    {items && shown.length === 0 && <div className="empty-state"><h2>{tab === 'open' ? 'No open referrals' : 'No closed referrals yet'}</h2></div>}
    {shown.length > 0 && <div className="lam-list">{shown.map((item) => <ReferralRow key={item.id} item={item} navigate={navigate} />)}</div>}
  </main>
}

function NewReferralPage({ navigate }: { navigate: Navigate }) {
  const [form, setForm] = useState<ReferralForm>(emptyReferralForm)
  const [file, setFile] = useState<File | null>(null)
  const [rules, setRules] = useState<PracticeRule[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { getPracticeRules().then(setRules).catch(() => setRules([])) }, [])
  const set = (key: keyof ReferralForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const matching = rules.filter((rule) => rule.referral_type.toLowerCase() === form.referralType.trim().toLowerCase())
  const requirementOptions = matching.flatMap((rule) => [...rule.content.required, ...rule.content.helpful])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problems = referralFormErrors(form)
    setErrors(problems)
    if (problems.length) return
    setBusy(true)
    try {
      const created = await createReferral(referralPayload(form, Boolean(file)))
      if (file) {
        try { await uploadReferralDocument(created.referral.id, file) }
        catch (err) { setErrors([`The referral was saved, but the document upload failed: ${errorText(err, 'upload failed')}. Add it from the referral page.`]); navigate(pilotPaths.referral(created.referral.id)); return }
      }
      navigate(pilotPaths.referral(created.referral.id))
    } catch (err) { setErrors([errorText(err, 'Could not save the referral.')]) } finally { setBusy(false) }
  }
  return <main className="page-shell pilot-page pilot-narrow">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.referrals)}>← Referrals</button>
    <h1>New referral</h1>
    <p className="muted-note">Enter what the referring office sent. Lamina never looks the patient up elsewhere — it works only from what you enter and attach.</p>
    <form className="auth-form pilot-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <fieldset><legend>Referring clinician</legend>
        <label><span>Name</span><input value={form.senderName} onChange={set('senderName')} disabled={busy} /></label>
        <div className="pilot-form-row">
          <label><span>Practice</span><input value={form.senderPractice} onChange={set('senderPractice')} disabled={busy} /></label>
          <label><span>Contact (fax, phone, or email)</span><input value={form.senderContact} onChange={set('senderContact')} disabled={busy} /></label>
        </div>
        <label><span>NPI (optional)</span><input inputMode="numeric" value={form.senderNpi} onChange={set('senderNpi')} disabled={busy} /></label>
      </fieldset>
      <fieldset><legend>Patient</legend>
        <div className="pilot-form-row">
          <label><span>Name</span><input value={form.patientName} onChange={set('patientName')} disabled={busy} /></label>
          <label><span>Date of birth</span><input type="date" value={form.patientDob} onChange={set('patientDob')} disabled={busy} /></label>
        </div>
        <div className="pilot-form-row">
          <label><span>Phone</span><input value={form.patientPhone} onChange={set('patientPhone')} disabled={busy} /></label>
          <label><span>Insurance</span><input value={form.patientInsurance} onChange={set('patientInsurance')} disabled={busy} /></label>
        </div>
        <label><span>Chart / MRN (optional)</span><input value={form.patientExternalId} onChange={set('patientExternalId')} disabled={busy} /></label>
      </fieldset>
      <fieldset><legend>Referral</legend>
        <label><span>Referral type</span><input list="pilot-referral-types" value={form.referralType} onChange={set('referralType')} disabled={busy} placeholder={rules.length ? 'Choose one of your rule types or enter another' : 'e.g. Diabetes management'} /></label>
        <datalist id="pilot-referral-types">{[...new Set(rules.map((rule) => rule.referral_type))].map((type) => <option key={type} value={type} />)}</datalist>
        <label><span>Reason for referral</span><textarea rows={3} value={form.reason} onChange={set('reason')} disabled={busy} /></label>
        <label><span>Clinical context (optional)</span><textarea rows={4} value={form.clinicalContext} onChange={set('clinicalContext')} disabled={busy} /></label>
        <div className="pilot-form-row">
          <label><span>Priority marked by sender</span><select value={form.senderPriority} onChange={set('senderPriority')} disabled={busy}><option value="">Not marked</option><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label>
          <label><span>Date received</span><input type="datetime-local" value={form.receivedAt} onChange={set('receivedAt')} disabled={busy} /></label>
        </div>
      </fieldset>
      {requirementOptions.length > 0 && <fieldset><legend>Information included with the referral</legend>
        <p className="muted-note">Record what the referral already contains so Lamina can check completeness. Leave anything not provided blank.</p>
        {requirementOptions.map((requirement) => {
          const item = form.items.find((entry) => entry.key === requirement.key) ?? { key: requirement.key, value: '', observedDate: '' }
          const update = (patch: Partial<typeof item>) => setForm((current) => ({ ...current, items: [...current.items.filter((entry) => entry.key !== requirement.key), { ...item, ...patch }] }))
          return <div className="pilot-form-row" key={requirement.key}>
            <label><span>{requirement.label}{requirement.required ? '' : ' (helpful)'}</span><input value={item.value} onChange={(event) => update({ value: event.target.value })} disabled={busy} placeholder="Value or summary" /></label>
            <label><span>Date{requirement.freshness_days ? ` (needed within ${requirement.freshness_days} days)` : ''}</span><input type="date" value={item.observedDate} onChange={(event) => update({ observedDate: event.target.value })} disabled={busy} /></label>
          </div>
        })}
      </fieldset>}
      <fieldset><legend>Referral document (optional)</legend>
        <label><span>PDF, image, or text file · 15 MB max</span><input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
        <p className="muted-note">Stored privately for your practice. Text in PDFs and images isn’t read automatically yet — record key facts above.</p>
      </fieldset>
      {errors.length > 0 && <div className="error-banner" role="alert">{errors.map((message) => <p key={message}>{message}</p>)}</div>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Saving and triaging…' : 'Save and triage'} <span>→</span></button>
    </form>
  </main>
}

/* -------------------------------------------------------------- detail */

function RequirementRow({ requirement, referralId, canRecord, onDetail }: { requirement: RequirementAssessment; referralId: string; canRecord: boolean; onDetail: (detail: ReferralDetail) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(requirement.evidence?.quote ?? '')
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fromDocument = requirement.state === 'proposed_from_document' && requirement.evidence?.document_id
  const save = async () => {
    if (!value.trim()) { setError('Enter the value or a short summary.'); return }
    setBusy(true); setError('')
    try {
      onDetail(await recordReferralItem(referralId, {
        key: requirement.key, value: value.trim(), observed_date: date || null,
        document_id: fromDocument ? requirement.evidence?.document_id : null, page: fromDocument ? requirement.evidence?.page : null,
      }))
      setOpen(false)
    } catch (err) { setError(errorText(err, 'Could not record this item.')) } finally { setBusy(false) }
  }
  return <li className={`pilot-requirement state-${requirement.state}`}>
    <div className="pilot-requirement-main">
      <strong>{requirement.label}{requirement.required ? '' : ' (helpful)'}</strong>
      <span className="pilot-requirement-state">{REQUIREMENT_STATE_LABELS[requirement.state]}</span>
      <span className="muted-note">{requirement.detail}{requirement.freshness_days ? ` · needed within ${requirement.freshness_days} days` : ''}</span>
      {requirement.evidence?.quote && <blockquote>“{requirement.evidence.quote}”{requirement.evidence.page ? ` — page ${requirement.evidence.page}` : ''}</blockquote>}
    </div>
    {canRecord && requirement.state !== 'satisfied' && !open && <button className="text-button" onClick={() => setOpen(true)}>{fromDocument ? 'Confirm from document' : 'Record received'}</button>}
    {open && <div className="pilot-inline-form">
      <label><span>Value</span><input value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} /></label>
      <label><span>Date of result</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button className="text-button" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>}
  </li>
}

type Panel = null | 'edit' | 'reject' | 'request' | 'escalate' | 'accept' | 'redirect' | 'decline'

function ReferralDetailPage({ id, status, navigate }: { id: string; status: PilotStatus; navigate: Navigate }) {
  const [detail, setDetail] = useState<ReferralDetail | null>(null)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [redirectTo, setRedirectTo] = useState('')
  const [edit, setEdit] = useState<Partial<EffectiveTriage>>({})
  const [requestItems, setRequestItems] = useState<string[]>([])
  const load = useCallback(() => getReferral(id).then((next) => { setDetail(next); setError('') }).catch((err) => setError(errorText(err, 'Could not load this referral'))), [id])
  useEffect(() => { void load() }, [load])

  const act = async (action: () => Promise<ReferralDetail>) => {
    setBusy(true); setError('')
    try { setDetail(await action()); setPanel(null); setNote(''); setRedirectTo(''); setEdit({}) }
    catch (err) {
      setError(errorText(err, 'That action could not be completed.'))
      if (err instanceof ApiError && (err.code === 'stale_referral' || err.code === 'already_decided')) void load()
    } finally { setBusy(false) }
  }
  if (error && !detail) return <main className="page-shell pilot-page"><button className="text-button back-link" onClick={() => navigate(pilotPaths.referrals)}>← Referrals</button><div className="error-banner" role="alert">{error}</div></main>
  if (!detail) return <main className="page-shell pilot-page"><p className="muted-note">Loading referral…</p></main>

  const { referral, recommendation, effective_triage: triage, decision, allowed_actions: actions } = detail
  const openPanel = (next: Panel) => { setPanel(next); setNote(''); setEdit({}); if (next === 'request') setRequestItems(recommendation?.missing_items ?? []) }
  const physician = status.role === 'physician'
  return <main className="page-shell pilot-page pilot-detail">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.referrals)}>← Referrals</button>
    <header className="pilot-detail-head">
      <div>
        <p className="eyebrow">{referral.referral_type} · received {formatDate(referral.received_at)}</p>
        <h1>{referral.patient.name}</h1>
        <p>{[referral.patient.date_of_birth && `DOB ${referral.patient.date_of_birth}`, referral.patient.insurance, referral.patient.external_id && `MRN ${referral.patient.external_id}`].filter(Boolean).join(' · ')}</p>
      </div>
      <span className={`pilot-status-pill status-${referral.status}`}>{STATUS_LABELS[referral.status]}</span>
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}

    <div className="pilot-detail-grid">
      <section className="pilot-card">
        <h2>Referral</h2>
        <dl className="pilot-facts">
          <div><dt>From</dt><dd>{referral.sender.name}{referral.sender.practice ? `, ${referral.sender.practice}` : ''}{referral.sender.contact ? ` · ${referral.sender.contact}` : ''}</dd></div>
          <div><dt>Reason</dt><dd>{referral.reason}</dd></div>
          {referral.clinical_context && <div><dt>Clinical context</dt><dd className="pilot-pre">{referral.clinical_context}</dd></div>}
          {referral.sender_priority && <div><dt>Sender priority</dt><dd>{PRIORITY_LABELS[referral.sender_priority]}</dd></div>}
          <div><dt>Entered</dt><dd>{formatDateTime(referral.entered_at)} · {referral.source === 'upload' ? 'with document' : 'manual entry'}</dd></div>
        </dl>
        <h3>Documents</h3>
        {referral.documents.length === 0 && <p className="muted-note">No documents attached.</p>}
        <ul className="pilot-documents">{referral.documents.map((document) => <li key={document.id}>
          <button className="text-button" onClick={() => void openReferralDocument(document.id).catch((err) => setError(errorText(err, 'Could not open the document.')))}>{document.filename}</button>
          <span className="muted-note">{Math.max(1, Math.round(document.size_bytes / 1024))} KB · {document.extraction_status === 'extracted' ? `text read (${document.page_count ?? 1} page${document.page_count === 1 ? '' : 's'})` : 'not read automatically — review manually'}</span>
        </li>)}</ul>
        {canUse(actions, 'upload_document') && <label className="pilot-upload"><span>Attach a document</span><input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void act(() => uploadReferralDocument(referral.id, file)); event.target.value = '' }} /></label>}
      </section>

      <section className="pilot-card pilot-triage">
        <div className="pilot-triage-head"><LaminaMark active /><div><p className="eyebrow">Lamina triage {recommendation ? `· ${formatDateTime(recommendation.created_at)}` : ''}</p><h2>{triage ? FIT_LABELS[triage.fit] : 'Not triaged yet'}</h2></div></div>
        {recommendation && triage && <>
          <dl className="pilot-facts pilot-triage-facts">
            <div><dt>Readiness</dt><dd>{recommendation.readiness === 'ready' ? 'Complete per your rule' : recommendation.readiness === 'unknown' ? 'Unknown — no rule for this type' : `Missing ${recommendation.missing_items.join(', ')}`}</dd></div>
            <div><dt>Priority</dt><dd>{PRIORITY_LABELS[triage.suggested_priority]}</dd></div>
            <div><dt>Modality</dt><dd>{MODALITY_LABELS[triage.suggested_modality]}</dd></div>
            <div><dt>Suggested next step</dt><dd>{NEXT_STEP_LABELS[triage.next_step]}</dd></div>
            <div><dt>Needs physician judgment</dt><dd>{triage.requires_physician ? 'Yes' : 'No'}</dd></div>
          </dl>
          {decision && <p className="pilot-decision">Triage {decision.decision === 'accepted' ? 'approved' : decision.decision} by {decision.actor_role} · {formatDateTime(decision.created_at)}{decision.reason ? ` — “${decision.reason}”` : ''}</p>}
          {referral.escalated_at && <p className="pilot-decision">Flagged for physician review{referral.escalation_note ? ` — “${referral.escalation_note}”` : ''}</p>}

          <h3>Required information</h3>
          {recommendation.requirements.length === 0 && <p className="muted-note">No requirements recorded for this referral type.</p>}
          <ul className="pilot-requirements">{recommendation.requirements.map((requirement) => <RequirementRow key={requirement.key} requirement={requirement} referralId={referral.id} canRecord={canUse(actions, 'record_item')} onDetail={setDetail} />)}</ul>

          <details className="pilot-why" open>
            <summary>Why</summary>
            <ul>{recommendation.rationale.map((item, index) => <li key={index}>{item.statement}<small>{
              item.source.kind === 'practice_rule' || item.source.kind === 'requirement_logic' ? ` Rule v${item.source.rule_version ?? '?'}`
                : item.source.kind === 'document' ? ` Document, page ${item.source.page ?? '?'}`
                : item.source.kind === 'submitted_item' ? ' Submitted with referral' : ' No rule'
            }</small></li>)}</ul>
            <p className="muted-note">Rules snapshot {recommendation.rules_snapshot_id} · {recommendation.generator === 'deterministic' ? 'deterministic rule checks' : `rule checks + model-proposed evidence (${recommendation.model_id})`}</p>
          </details>
        </>}

        {actions.length > 0 && <div className="pilot-actions" role="group" aria-label="Referral actions">
          {canUse(actions, 'approve') && <button className="button-primary" disabled={busy} onClick={() => void act(() => approveTriage(referral.id))}>Approve triage</button>}
          {canUse(actions, 'edit') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('edit')}>Edit</button>}
          {canUse(actions, 'request_information') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('request')}>Request information</button>}
          {canUse(actions, 'escalate') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('escalate')}>Needs physician review</button>}
          {canUse(actions, 'reject') && <button className="text-button" disabled={busy} onClick={() => openPanel('reject')}>Triage is wrong</button>}
          {canUse(actions, 'retriage') && <button className="text-button" disabled={busy} onClick={() => void act(() => retriageReferral(referral.id))}>Re-run triage</button>}
        </div>}

        {panel === 'edit' && triage && <div className="pilot-panel">
          <h3>Edit triage</h3>
          <div className="pilot-form-row">
            <label><span>Fit</span><select value={edit.fit ?? triage.fit} onChange={(event) => setEdit({ ...edit, fit: event.target.value as Fit })}>{(Object.keys(FIT_LABELS) as Fit[]).map((value) => <option key={value} value={value}>{FIT_LABELS[value]}</option>)}</select></label>
            <label><span>Priority</span><select value={edit.suggested_priority ?? triage.suggested_priority} onChange={(event) => setEdit({ ...edit, suggested_priority: event.target.value as Priority })}>{(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}</select></label>
          </div>
          <div className="pilot-form-row">
            <label><span>Modality</span><select value={edit.suggested_modality ?? triage.suggested_modality} onChange={(event) => setEdit({ ...edit, suggested_modality: event.target.value as Modality })}>{(Object.keys(MODALITY_LABELS) as Modality[]).map((value) => <option key={value} value={value}>{MODALITY_LABELS[value]}</option>)}</select></label>
            <label><span>Next step</span><select value={edit.next_step ?? triage.next_step} onChange={(event) => setEdit({ ...edit, next_step: event.target.value as NextStep })}>{(Object.keys(NEXT_STEP_LABELS) as NextStep[]).map((value) => <option key={value} value={value}>{NEXT_STEP_LABELS[value]}</option>)}</select></label>
          </div>
          <label className="pilot-check"><input type="checkbox" checked={edit.requires_physician ?? triage.requires_physician} onChange={(event) => setEdit({ ...edit, requires_physician: event.target.checked })} /> Needs physician judgment</label>
          <label><span>Why (helps Lamina learn)</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => editTriage(referral.id, { ...edit, reason: note || null }))}>Save edits</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
        </div>}
        {panel === 'reject' && <div className="pilot-panel">
          <h3>What’s wrong with this triage?</h3>
          <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. This is a thyroid question, not diabetes" />
          <div className="onboarding-actions"><button className="button-primary" disabled={busy || !note.trim()} onClick={() => void act(() => rejectTriage(referral.id, note))}>Reject and send to physician</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
        </div>}
        {panel === 'request' && <div className="pilot-panel">
          <h3>Request information</h3>
          <p className="muted-note">Lamina prepares the request; nothing is sent from Lamina in this pilot phase.</p>
          {(recommendation?.missing_items ?? []).map((item) => <label key={item} className="pilot-check"><input type="checkbox" checked={requestItems.includes(item)} onChange={(event) => setRequestItems(event.target.checked ? [...requestItems, item] : requestItems.filter((value) => value !== item))} /> {item}</label>)}
          <label><span>Other item or note</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => requestInformation(referral.id, requestItems, note))}>Prepare request</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
        </div>}
        {panel === 'escalate' && <div className="pilot-panel">
          <h3>Flag for physician review</h3>
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note for the physician" />
          <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => escalateReferral(referral.id, note))}>Flag</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
        </div>}

        {referral.information_request && <div className="pilot-panel pilot-draft">
          <h3>Prepared information request</h3>
          <p>{referral.information_request.draft_message}</p>
          <p className="muted-note">Not sent. Copy it into your fax or email to {referral.sender.name}{referral.sender.contact ? ` (${referral.sender.contact})` : ''}.</p>
          <button className="text-button" onClick={() => void navigator.clipboard?.writeText(referral.information_request?.draft_message ?? '')}>Copy request</button>
        </div>}

        {referral.disposition && <div className="pilot-panel"><h3>Decision</h3><p>{referral.disposition.decision === 'accept' ? 'Accepted' : referral.disposition.decision === 'redirect' ? `Redirected to ${referral.disposition.redirect_to}` : 'Declined'} · {formatDateTime(referral.disposition.at)}{referral.disposition.reason ? ` — “${referral.disposition.reason}”` : ''}</p></div>}

        {physician && canUse(actions, 'accept') && <div className="pilot-disposition">
          <h3>Physician decision</h3>
          <div className="pilot-actions">
            <button className="button-primary" disabled={busy} onClick={() => openPanel('accept')}>Accept referral</button>
            <button className="button-secondary" disabled={busy} onClick={() => openPanel('redirect')}>Redirect</button>
            <button className="button-secondary" disabled={busy} onClick={() => openPanel('decline')}>Decline</button>
          </div>
          {(panel === 'accept' || panel === 'redirect' || panel === 'decline') && <div className="pilot-panel">
            {panel === 'redirect' && <label><span>Redirect to</span><input value={redirectTo} onChange={(event) => setRedirectTo(event.target.value)} placeholder="e.g. Nephrology — Dr. Lee" /></label>}
            <label><span>{panel === 'accept' ? 'Note (optional)' : 'Reason'}</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div className="onboarding-actions"><button className="button-primary" disabled={busy || (panel !== 'accept' && !note.trim()) || (panel === 'redirect' && !redirectTo.trim())} onClick={() => void act(() => decideReferral(referral.id, panel, note, redirectTo))}>Confirm {panel}</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
          </div>}
        </div>}
        {!physician && !isClosed(referral.status) && <p className="muted-note">The physician makes the final accept, redirect, or decline decision.</p>}
      </section>
    </div>

    <details className="pilot-card pilot-history">
      <summary>Activity</summary>
      <ul>{detail.history.map((event, index) => <li key={index}><span>{formatDateTime(event.created_at)}</span> {event.event_type.replace(/_/g, ' ')} <small>{event.autonomy === 'automatic' ? 'by Lamina' : 'by your team'}</small></li>)}</ul>
    </details>
  </main>
}

/* -------------------------------------------------------------- practice */

function PracticePage({ status, reload }: { status: PilotStatus; reload: () => void }) {
  const [members, setMembers] = useState<PracticeMember[] | null>(null)
  const [invitations, setInvitations] = useState<PracticeInvitation[]>([])
  const [label, setLabel] = useState('')
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const physician = status.role === 'physician'
  const load = () => getPracticeMembers().then((result) => { setMembers(result.members); setInvitations(result.invitations) }).catch((err) => setError(errorText(err, 'Could not load members')))
  useEffect(() => { void load() }, [])
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try {
      const created = await inviteStaff(label.trim())
      setLink(`${window.location.origin}${pilotPaths.join}?invite=${encodeURIComponent(created.token)}`)
      setLabel(''); void load()
    } catch (err) { setError(errorText(err, 'Could not create the invitation.')) }
  }
  const practice = status.practice
  return <main className="page-shell pilot-page pilot-narrow">
    <h1>Practice</h1>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <section className="pilot-card">
      <div className="pilot-section-head"><h2>{practice?.name}</h2>{physician && !editing && <button className="text-button" onClick={() => setEditing(true)}>Edit</button>}</div>
      {!editing && practice && <dl className="pilot-facts">
        <div><dt>Specialty</dt><dd>{practice.specialty ?? '—'}</dd></div>
        <div><dt>Address</dt><dd>{practice.address ?? '—'}</dd></div>
        <div><dt>Phone</dt><dd>{practice.phone ?? '—'}</dd></div>
        <div><dt>Referral contact</dt><dd>{practice.contact_email ?? '—'}</dd></div>
        <div><dt>Website</dt><dd>{practice.website ?? '—'}</dd></div>
      </dl>}
      {editing && practice && <PracticeFieldsForm initial={practice} submitLabel="Save" busyLabel="Saving…" onSubmit={async (fields) => { await updatePractice(fields); setEditing(false); reload() }} />}
    </section>
    <section className="pilot-card">
      <h2>Team</h2>
      {!members && <p className="muted-note">Loading…</p>}
      {members && <ul className="pilot-members">{members.map((member) => <li key={member.id}>
        <strong>{member.label ?? (member.role === 'physician' ? 'Physician' : 'Staff member')}</strong>
        <span className="muted-note">{member.role === 'physician' ? 'Physician' : 'Staff'}{member.is_you ? ' · you' : ''} · joined {formatDate(member.joined_at)}</span>
        {physician && member.role === 'staff' && <button className="text-button" onClick={() => void removeStaffMember(member.id).then(load).catch((err) => setError(errorText(err, 'Could not remove member.')))}>Remove</button>}
      </li>)}</ul>}
      {physician && <>
        <h3>Invite staff</h3>
        <p className="muted-note">Staff can enter referrals, attach documents, and review triage. Only physicians accept, redirect, or decline referrals and change referral rules.</p>
        <form className="auth-form pilot-form pilot-invite" onSubmit={(event) => void invite(event)}>
          <label><span>Name or role (for your reference)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Maria — front desk" /></label>
          <button className="button-primary" type="submit">Create invitation link</button>
        </form>
        {link && <div className="pilot-panel"><p><strong>Share this link with your staff member.</strong> It works once and expires in 14 days. It won’t be shown again.</p><code className="pilot-link">{link}</code><button className="text-button" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button></div>}
        {invitations.filter((item) => item.state === 'pending').length > 0 && <ul className="pilot-members">{invitations.filter((item) => item.state === 'pending').map((item) => <li key={item.id}>
          <strong>{item.label ?? 'Staff invitation'}</strong><span className="muted-note">Pending · expires {formatDate(item.expires_at)}</span>
          <button className="text-button" onClick={() => void revokeInvitation(item.id).then(load).catch((err) => setError(errorText(err, 'Could not revoke.')))}>Revoke</button>
        </li>)}</ul>}
      </>}
    </section>
  </main>
}

/* ----------------------------------------------------------------- rules */

function RuleEditor({ initial, onSave, onCancel }: { initial: RuleForm; onSave: (form: RuleForm) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<RuleForm>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof RuleForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form.referralType.trim()) { setError('Name the referral type.'); return }
    setBusy(true); setError('')
    try { await onSave(form) } catch (err) { setError(errorText(err, 'Could not save the rule.')) } finally { setBusy(false) }
  }
  return <form className="auth-form pilot-form pilot-card" onSubmit={(event) => void save(event)}>
    <label><span>Referral type</span><input value={form.referralType} onChange={set('referralType')} placeholder="e.g. Diabetes management" disabled={busy} /></label>
    <label><span>Good fit — one per line</span><textarea rows={3} value={form.goodFit} onChange={set('goodFit')} placeholder="Type 2 diabetes not at goal on two agents" disabled={busy} /></label>
    <label><span>Outside my scope — one per line</span><textarea rows={2} value={form.outsideScope} onChange={set('outsideScope')} placeholder="Type 1 diabetes pump management" disabled={busy} /></label>
    <label><span>Required before review — one per line, optional “| days” for recency</span><textarea rows={3} value={form.required} onChange={set('required')} placeholder={'Recent HbA1c | 180\nCurrent medication list'} disabled={busy} /></label>
    <label><span>Helpful but not required</span><textarea rows={2} value={form.helpful} onChange={set('helpful')} placeholder="Glucose log" disabled={busy} /></label>
    <label><span>Urgency signals — one per line</span><textarea rows={2} value={form.urgent} onChange={set('urgent')} placeholder="Recent DKA admission" disabled={busy} /></label>
    <div className="pilot-form-row">
      <label><span>Default modality</span><select value={form.modality} onChange={set('modality')} disabled={busy}>{(Object.keys(MODALITY_LABELS) as Modality[]).map((value) => <option key={value} value={value}>{MODALITY_LABELS[value]}</option>)}</select></label>
      <label><span>Note</span><input value={form.note} onChange={set('note')} disabled={busy} /></label>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions"><button className="button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button><button className="text-button" type="button" onClick={onCancel}>Cancel</button></div>
  </form>
}

function RulesPage({ status }: { status: PilotStatus }) {
  const [rules, setRules] = useState<PracticeRule[] | null>(null)
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const load = () => getPracticeRules().then(setRules).catch((err) => setError(errorText(err, 'Could not load rules')))
  useEffect(() => { void load() }, [])
  return <main className="page-shell pilot-page pilot-narrow">
    <div className="pilot-section-head"><div><h1>Referral rules</h1><p className="muted-note">How Lamina triages each kind of referral. Every triage cites the rule version it used; edits create a new version and never rewrite history.</p></div>{physician && editing === null && <button className="button-primary" onClick={() => setEditing('new')}>Add rule <span>+</span></button>}</div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {editing === 'new' && <RuleEditor initial={emptyRuleForm()} onCancel={() => setEditing(null)} onSave={async (form) => { await createPracticeRule(ruleInput(form)); setEditing(null); void load() }} />}
    {rules && rules.length === 0 && editing === null && <div className="empty-state"><h2>No rules yet</h2><p>{physician ? 'Add one rule per referral type you receive.' : 'The physician hasn’t added referral rules yet.'}</p></div>}
    {(rules ?? []).map((rule) => editing === rule.id
      ? <RuleEditor key={rule.id} initial={ruleFormFrom(rule)} onCancel={() => setEditing(null)} onSave={async (form) => { await revisePracticeRule(rule.id, ruleInput(form)); setEditing(null); void load() }} />
      : <section key={rule.id} className="pilot-card pilot-rule">
        <div className="pilot-section-head"><div><h2>{rule.referral_type}</h2><p className="muted-note">Version {rule.version} · {rule.physician_confirmed ? 'physician-confirmed' : rule.operational_status.replace('_', ' ')} · since {formatDate(rule.confirmed_at ?? rule.created_at)}</p></div>
          {physician && <div className="onboarding-actions"><button className="text-button" onClick={() => setEditing(rule.id)}>Edit</button><button className="text-button" onClick={() => void retirePracticeRule(rule.id).then(load).catch((err) => setError(errorText(err, 'Could not retire rule.')))}>Retire</button></div>}</div>
        <dl className="pilot-facts">
          {rule.content.good_fit.length > 0 && <div><dt>Good fit</dt><dd>{rule.content.good_fit.join('; ')}</dd></div>}
          {rule.content.redirect.length > 0 && <div><dt>Outside scope</dt><dd>{rule.content.redirect.join('; ')}</dd></div>}
          {rule.content.required.length > 0 && <div><dt>Required</dt><dd>{rule.content.required.map((item) => item.freshness_days ? `${item.label} (≤${item.freshness_days} days)` : item.label).join('; ')}</dd></div>}
          {rule.content.helpful.length > 0 && <div><dt>Helpful</dt><dd>{rule.content.helpful.map((item) => item.label).join('; ')}</dd></div>}
          {rule.content.urgent_signals.length > 0 && <div><dt>Urgent if</dt><dd>{rule.content.urgent_signals.join('; ')}</dd></div>}
          <div><dt>Modality</dt><dd>{MODALITY_LABELS[rule.content.modality]}</dd></div>
        </dl>
      </section>)}
  </main>
}
