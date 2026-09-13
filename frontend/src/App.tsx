import { useEffect, useMemo, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { consultNetwork, getPatient, type Consultation, type ConsultationMessage, type Evaluation, type Patient } from './api'
import { DEMO_PATIENTS, type DemoPatientSummary } from './demoPatients'
import { PhysicianDirectoryPage, PhysicianProfilePage } from './PhysicianNetwork'

const JORDAN_ID = 'patient-ckd-htn-001'
type Navigate = (path: string) => void

function Brand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <span className={`network-motif ${active ? 'active' : ''} ${resolved ? 'resolved' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 120 120"><path d="M60 18 100 60 60 102 20 60Z" /><path d="M60 18V60M100 60H60M60 102V60M20 60H60" /></svg>
    <i /><i /><i /><i /><b />
  </span>
}

function SyntheticStatus() {
  return <div className="synthetic-status"><span />Synthetic demo · no PHI</div>
}

function ProductShell({ children, navigate, section }: { children: React.ReactNode; navigate: Navigate; section: string }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')}><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          <button className={`nav-item ${section === 'consult' ? 'active' : ''}`} onClick={() => navigate('/patients')}><span className="nav-icon">✦</span><span><b>Specialty consult</b><small>Patient workspace</small></span></button>
          <button className={`nav-item ${section === 'recent' ? 'active' : ''}`} onClick={() => navigate('/consultations')}><span className="nav-icon">◫</span><span><b>Consultations</b><small>Recent work</small></span></button>
          <button className={`nav-item ${section === 'network' ? 'active' : ''}`} onClick={() => navigate('/network')}><span className="nav-icon">⌁</span><span><b>Physician network</b><small>Practice footprints</small></span></button>
        </nav>
      </div>
      <div className="sidebar-clinician"><div className="clinician-avatar">LC</div><div><span>Referring clinician</span><strong>Dr. Cha</strong><small>Primary Care</small></div></div>
    </aside>
    <div className="workspace"><header className="workspace-bar"><div><span>Clinical workspace</span><b>/</b><strong>{section === 'consult' ? 'Specialty Care Consult' : section === 'recent' ? 'Recent Consultations' : 'Physician Network'}</strong></div><SyntheticStatus /></header>{children}</div>
  </div>
}

function LandingPage({ navigate }: { navigate: Navigate }) {
  return <main className="landing-page">
    <header className="landing-header"><Brand /><SyntheticStatus /></header>
    <section className="landing-content">
      <p className="eyebrow">Primary care workspace</p>
      <h1>Good morning, Dr. Cha.</h1>
      <p className="landing-question">Who are we helping today?</p>
      <button className="landing-network-control" onClick={() => navigate('/patients')} aria-label="Select patient">
        <span className="ambient-ring one" /><span className="ambient-ring two" /><span className="ambient-line line-one" /><span className="ambient-line line-two" />
        <NetworkMark active />
        <strong>Select patient</strong><small>Begin a specialty care consult</small>
      </button>
      <nav className="landing-secondary" aria-label="Secondary navigation"><button onClick={() => navigate('/consultations')}>Recent consultations <span>→</span></button><button onClick={() => navigate('/network')}>Physician network <span>→</span></button></nav>
    </section>
    <p className="landing-footnote">Lamina helps primary care teams find the right specialist, required workup, and appropriate access.</p>
  </main>
}

function PatientSelector({ navigate }: { navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const visible = DEMO_PATIENTS.filter((patient) => `${patient.name} ${patient.reason} ${patient.location}`.toLowerCase().includes(query.toLowerCase()))
  return <ProductShell navigate={navigate} section="consult"><main className="page-shell selector-page">
    <button className="text-button back-link" onClick={() => navigate('/')}>← Home</button>
    <header className="selector-header"><div><p className="eyebrow">Specialty Care Consult</p><h1>Select a patient</h1><p>Choose the patient whose next step in specialty care needs clarification.</p></div><span>{DEMO_PATIENTS.length} synthetic patients</span></header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients or clinical problem…" aria-label="Search patients" /></label>
    <div className="patient-list-heading"><h2>Recent patients</h2><span>Consult status</span></div>
    <div className="patient-list">{visible.map((patient) => <button key={patient.id} className="patient-row" onClick={() => navigate(`/patients/${patient.id}`)}><span className="patient-row-avatar">{patient.initials}</span><span className="patient-row-identity"><strong>{patient.name}</strong><small>{patient.age} years · {patient.location}</small></span><span className="patient-row-reason">{patient.reason}</span><span className={`patient-status ${patient.implemented ? 'ready' : ''}`}>{patient.status}</span><span className="row-arrow">→</span></button>)}</div>
    {!visible.length && <div className="empty-state"><NetworkMark /><h2>No patients found</h2><p>Try a different name or clinical problem.</p></div>}
  </main></ProductShell>
}

function PlaceholderPage({ navigate }: { navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="recent"><main className="page-shell placeholder-page"><NetworkMark /><p className="eyebrow">Recent consultations</p><h1>Your consult history will live here.</h1><p>This V1 pass focuses on starting and completing Jordan Lee’s specialty consult.</p><button className="button-primary" onClick={() => navigate('/patients')}>Select patient <span>→</span></button></main></ProductShell>
}

function UnfinishedPatient({ patient, navigate }: { patient: DemoPatientSummary; navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="consult"><main className="page-shell unfinished-page"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button><div className="unfinished-card"><span className="patient-row-avatar large">{patient.initials}</span><p className="eyebrow">Synthetic patient</p><h1>{patient.name}</h1><p className="unfinished-meta">{patient.age} years · {patient.location}</p><div className="unfinished-reason"><span>Reason for consult</span><strong>{patient.reason}</strong></div><NetworkMark /><h2>This demo case is not implemented yet.</h2><p>Jordan Lee remains the only case with a grounded physician-agent consultation. No recommendation has been fabricated for this patient.</p><button className="button-secondary" onClick={() => navigate(`/patients/${JORDAN_ID}`)}>Open Jordan Lee demo</button></div></main></ProductShell>
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return <svg className="trend-icon" viewBox="0 0 20 20" aria-hidden="true"><path d={direction === 'up' ? 'M4 14 10 8l3 3 3-5M12 6h4v4' : 'M4 6l6 6 3-3 3 5M12 14h4v-4'} /></svg>
}

const physicianInitials = (name: string) => name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
const evidenceFor = (evaluation: Evaluation, kind: string) => evaluation.evidence.find((item) => item.kind === kind)?.detail
const cleanName = (name: string) => name.replace(' (synthetic)', '')
const insuranceLabel = (status: string) => status.startsWith('In network') ? 'In-network' : 'Network unknown'

function ConsultationNetwork({ messages, visibleCount }: { messages: ConsultationMessage[]; visibleCount: number }) {
  const agents = [
    ['Dr. Jung', 'Nephrology'], ['Dr. Onadeko', 'Hypertension Cardiology'], ['Dr. Patel', 'General Cardiology'], ['Dr. Rossi', 'Electrophysiology'], ['Dr. Chen', 'Endocrinology'],
  ]
  const visibleMessages = messages.slice(0, visibleCount)
  const current = visibleMessages.at(-1)
  const followUpActive = current?.message_type === 'follow_up_question' || current?.message_type === 'follow_up_answer'
  const statusFor = (name: string) => {
    const event = [...visibleMessages].reverse().find((message) => message.sender_name.includes(name.replace('Dr. ', '')))
    if (!event) return 'Reviewing…'
    if (event.message_type === 'redirect') return 'Poor fit · redirects'
    if (event.message_type === 'referral_requirement') return 'Workup specified'
    if (event.message_type === 'follow_up_answer') return 'Nephrology first'
    const fit = String(event.metadata.clinical_fit || '')
    return fit ? `${fit[0].toUpperCase()}${fit.slice(1)} fit` : 'Responded'
  }
  return <section className={`network-consultation ${followUpActive ? 'follow-up-active' : ''}`} role="status" aria-live="polite"><div className="network-consult-copy"><p className="eyebrow">Consult Network</p><h2>Consulting physician representatives…</h2><p>Visualising structured events returned by the consultation orchestrator.</p></div><div className="agent-network-map"><svg viewBox="0 0 600 260" preserveAspectRatio="none" aria-hidden="true"><path d="M300 130 90 48M300 130 510 48M300 130 56 205M300 130 300 232M300 130 544 205" /><path className="follow-up-path" d="M300 130 510 48" /></svg><div className="network-core"><NetworkMark active /><strong>Lamina</strong></div>{agents.map(([name, specialty], index) => { const status = statusFor(name); return <div className={`consult-agent agent-${index + 1} ${status !== 'Reviewing…' ? 'responded' : ''}`} key={name}><span>{physicianInitials(name)}</span><div><strong>{name}</strong><small>{specialty}</small></div><em><i />{status}</em></div> })}</div>{current && <div className="live-event-strip"><span>{current.sequence}</span><div><strong>{current.sender_name}</strong><p>{current.summary}</p></div><em>{current.message_type.replaceAll('_', ' ')}</em></div>}</section>
}

const messageLabel = (message: ConsultationMessage) => {
  if (message.message_type === 'fit_response') return `${String(message.metadata.clinical_fit || 'fit')} fit`
  return message.message_type.replaceAll('_', ' ')
}

function ConsultationLog({ messages }: { messages: ConsultationMessage[] }) {
  return <div className="consult-log"><div className="consult-log-heading"><span>Structured consultation record</span><small>{messages.length} auditable events · sequence preserved</small></div>{messages.map((message) => <article className={`consult-log-entry ${message.message_type}`} key={message.id}><span className="consult-sequence">{message.sequence}</span><div className="consult-log-card"><header><span className="mini-avatar">{physicianInitials(message.sender_name.replace(' Agent', ''))}</span><div><strong>{message.sender_name}</strong><small>{message.sender_role}</small></div><em>{messageLabel(message)}</em></header><p>{message.summary}</p>{(message.evidence.length > 0 || message.related_patient_facts.length > 0) && <details className="consult-log-evidence"><summary>View supporting evidence <span>⌄</span></summary><div>{message.related_patient_facts.slice(0, 3).map((fact) => <p key={fact}><b>Patient fact</b>{fact}</p>)}{message.evidence.slice(0, 3).map((item) => <p key={`${item.kind}-${item.detail}`}><b>{item.kind.replaceAll('_', ' ')}</b>{item.detail}</p>)}</div></details>}</div></article>)}</div>
}

function RecommendationView({ consultation }: { consultation: Consultation }) {
  const [networkOpen, setNetworkOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const primary = consultation.recommended_physician
  const historical = evidenceFor(primary, 'historical_practice_similarity')
  const explicitRule = evidenceFor(primary, 'explicit_physician_rule')
  const operational = evidenceFor(primary, 'operational')
  const reasons = [
    'Progressive stage 3b CKD is the dominant clinical trajectory.',
    historical?.split(';')[0],
    explicitRule,
    operational,
  ].filter(Boolean) as string[]
  return <section className="recommendations" aria-label="Specialist recommendations">
    <article className="best-fit-card"><div className="best-fit-label"><span>Best fit</span><small>Network resolved · 5 agents consulted</small></div><div className="best-fit-physician"><span className="physician-avatar">{physicianInitials(primary.physician_name)}</span><div><h2>{cleanName(primary.physician_name)}</h2><p>{primary.specialty}</p></div><div className="fit-summary"><span>Strong clinical fit</span><span>{primary.availability.replace('Approximately ', '')}</span><span>{insuranceLabel(primary.insurance_status)}</span></div></div>
      <div className="best-fit-body"><section><p className="section-label">Why Dr. Jung</p><ul className="reason-list">{reasons.map((reason) => <li key={reason}><span>✓</span>{reason}</li>)}</ul></section><section className="before-visit"><p className="section-label">Before visit</p>{consultation.before_referral.map((item) => <span key={item}>{item.includes('(') ? item.match(/\(([^)]+)\)/)?.[1] : item}<small>{item}</small></span>)}</section></div>
      <div className="best-fit-actions"><button className="button-primary" onClick={() => setReferralStarted(true)}>Start Referral <span>→</span></button>{referralStarted && <span className="demo-note">Demo referral prepared — no external action taken.</span>}</div>
    </article>

    <section className="options-section"><div className="options-heading"><div><p className="eyebrow">Other appropriate choices</p><h2>Referral options</h2></div><p>Different practice focus or access, based on the same supplied evidence.</p></div><div className="option-grid">{consultation.alternatives.map((option, index) => <article className="option-card" key={option.physician_id}><div><span className="mini-avatar">{physicianInitials(option.physician_name)}</span><span className="option-label">{index === 0 ? 'Strong alternative' : 'Additional option'}</span></div><h3>{cleanName(option.physician_name)}</h3><p className="option-specialty">{option.specialty}</p><div className="option-meta"><span>{option.clinical_fit} fit</span><span>{option.availability.replace('Approximately ', '')}</span><span>{insuranceLabel(option.insurance_status)}</span></div><p className="option-reason">{option.reason}</p></article>)}</div>{consultation.alternatives[0] && <div className="alternative-comparison"><span>Why not the first alternative?</span><strong>{cleanName(consultation.alternatives[0].physician_name)}</strong><p>{consultation.alternatives[0].reason}</p></div>}</section>

    <section className="network-transparency"><button className="network-transparency-toggle" onClick={() => setNetworkOpen(!networkOpen)} aria-expanded={networkOpen}><span><NetworkMark resolved /><span><b>View network consultation</b><small>All five physician-agent conclusions and supporting evidence</small></span></span><em>{networkOpen ? 'Hide' : 'View'} <i>⌄</i></em></button>
      {networkOpen && <div className="network-record"><div className="record-note">Deliberate structured messages and evidence only. Hidden model chain-of-thought is not stored or shown.</div><ConsultationLog messages={consultation.messages} /><div className="evaluation-record-heading">Physician evaluation records</div>{consultation.consultation.map((agent) => { const rule = evidenceFor(agent, 'explicit_physician_rule'); const history = evidenceFor(agent, 'historical_practice_similarity'); return <details key={agent.physician_id} open={agent.physician_id === primary.physician_id}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{cleanName(agent.physician_name)}</b><small>{agent.specialty}</small></span><span className={`decision-badge ${agent.clinical_fit}`}>{agent.accepts_case ? agent.clinical_fit === 'strong' ? 'Strong fit' : 'Accepts' : 'Redirect'}</span><span className="chevron">⌄</span></summary><div className="structured-evidence"><p>{agent.reason}</p><div className="evidence-grid"><div><span>Decision</span><strong>{agent.accepts_case ? 'Accepts case' : 'Redirects / does not accept'}</strong></div><div><span>Availability</span><strong>{agent.availability}</strong></div><div><span>Insurance</span><strong>{insuranceLabel(agent.insurance_status)}</strong></div><div><span>Required workup</span><strong>{agent.required_workup.join(' · ')}</strong></div>{rule && <div className="wide"><span>Relevant physician rule</span><strong>{rule}</strong></div>}{history && <div className="wide"><span>Historical-practice signal</span><strong>{history}</strong></div>}</div></div></details> })}</div>}
    </section>
    <p className="disclaimer">{consultation.disclaimer}</p>
  </section>
}

function JordanWorkspace({ navigate }: { navigate: Navigate }) {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [liveMessages, setLiveMessages] = useState<ConsultationMessage[]>([])
  const [visibleMessageCount, setVisibleMessageCount] = useState(0)
  const [context, setContext] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { getPatient(JORDAN_ID).then(setPatient).catch((loadError: Error) => setError(loadError.message)).finally(() => setLoading(false)) }, [])
  const labs = useMemo(() => { if (!patient) return []; const creatinine = patient.labs.filter((item) => item.test === 'creatinine'); const egfr = patient.labs.filter((item) => item.test === 'eGFR'); return creatinine.map((item, index) => ({ date: item.date, creatinine: item.value, egfr: egfr[index]?.value ?? 0 })) }, [patient])
  const chartPoints = useMemo(() => { if (!labs.length) return { creatinine: '', egfr: '' }; const x = (index: number) => 8 + (index / (labs.length - 1)) * 84; const y = (value: number, min: number, max: number) => 82 - ((value - min) / (max - min)) * 64; return { creatinine: labs.map((item, index) => `${x(index)},${y(item.creatinine, 1.1, 1.8)}`).join(' '), egfr: labs.map((item, index) => `${x(index)},${y(item.egfr, 41, 68)}`).join(' ') } }, [labs])
  const runConsult = async () => { setConsulting(true); setConsultation(null); setLiveMessages([]); setVisibleMessageCount(0); setError(null); try { const result = await consultNetwork(JORDAN_ID, context); setLiveMessages(result.messages); for (let index = 1; index <= result.messages.length; index += 1) { setVisibleMessageCount(index); await new Promise((resolve) => setTimeout(resolve, 90)) } setConsultation(result) } catch (consultError) { setError(consultError instanceof Error ? consultError.message : 'Consultation failed') } finally { setConsulting(false) } }
  if (loading) return <ProductShell navigate={navigate} section="consult"><div className="page-state embedded"><div className="loading-line" /><p>Opening patient workspace…</p></div></ProductShell>
  if (!patient) return <ProductShell navigate={navigate} section="consult"><div className="page-state embedded error"><p>{error || 'Patient unavailable'}</p></div></ProductShell>
  return <ProductShell navigate={navigate} section="consult"><main className="page-shell"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button>
    <header className="consult-header"><div><p className="eyebrow">Specialty Care Consult</p><h1>Jordan Lee</h1><div className="patient-demographics"><span><b>Age</b>{patient.age} years</span><span><b>Location</b>{patient.location}</span><span className="clinical-source"><b>Clinical data</b>{patient.clinical_data_source === 'medplum_fhir' ? 'Synthetic FHIR via Medplum' : 'Local synthetic fixture'}</span></div></div><div className="patient-monogram">JL</div></header>
    <section className="referral-context" aria-label="Referral context"><div><span>Referring clinician</span><strong>Dr. Cha</strong><small>Primary Care</small></div><div><span>Insurance</span><strong>{patient.insurance}</strong><small>Coverage on file</small></div><div className="consult-reason"><span>Reason for consult</span><strong>Resistant hypertension with progressive renal dysfunction</strong></div></section>
    {error && <div className="error-banner" role="alert"><strong>Unable to complete this action.</strong> {error}</div>}
    <section className="network-action"><div className="network-copy"><NetworkMark active={consulting} resolved={Boolean(consultation)} /><div><p className="eyebrow">Physician agent network</p><h2>Find the appropriate next step in specialty care.</h2><p>Compare best-fit specialists, required workup, and fastest appropriate access.</p></div></div><div className="network-controls"><label><span>Add context for the network <em>Optional</em></span><input value={context} onChange={(event) => setContext(event.target.value)} maxLength={500} placeholder="e.g. Considering nephrology vs cardiology" /></label><button className="consult-button" disabled={consulting} onClick={runConsult}><span>{consulting ? 'Consulting…' : 'Consult Network'}</span><span>→</span></button></div></section>
    <div className="clinical-grid"><section className="clinical-card"><div className="card-title"><span className="card-icon">+</span><div><p>Clinical context</p><h2>Active diagnoses</h2></div><b>{patient.diagnoses.length}</b></div><ul className="clinical-list">{patient.diagnoses.map((item) => <li key={item}><span />{item}</li>)}</ul></section><section className="clinical-card"><div className="card-title"><span className="card-icon medication">Rx</span><div><p>Current therapy</p><h2>Medications</h2></div><b>{patient.medications.length}</b></div><ul className="clinical-list medications">{patient.medications.map((item) => <li key={item}><span />{item}</li>)}</ul></section><section className="clinical-card renal-card"><div className="card-title"><span className="card-icon chart">↗</span><div><p>Longitudinal labs</p><h2>Renal trajectory</h2></div><span className="status-label warning">Progressive decline</span></div><div className="trajectory-summary"><div><span>Creatinine</span><strong>1.1 → 1.8 <small>mg/dL</small></strong><em><ArrowIcon direction="up" />Increasing</em></div><div><span>eGFR</span><strong>68 → 41 <small>mL/min</small></strong><em><ArrowIcon direction="down" />Decreasing</em></div></div><div className="trajectory-visual"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="8" y1="18" x2="92" y2="18" /><line x1="8" y1="50" x2="92" y2="50" /><line x1="8" y1="82" x2="92" y2="82" /><polyline className="creatinine-line" points={chartPoints.creatinine} /><polyline className="egfr-line" points={chartPoints.egfr} /></svg><div className="chart-legend"><span>Creatinine</span><span className="egfr">eGFR</span></div><div className="chart-dates">{labs.map((item) => <span key={item.date}>{new Date(`${item.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>)}</div></div></section></div>
    {consulting && <ConsultationNetwork messages={liveMessages} visibleCount={visibleMessageCount} />}{consultation && <RecommendationView consultation={consultation} />}
  </main></ProductShell>
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, [])
  const navigate = (next: string) => { window.history.pushState({}, '', next); setPath(next); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  if (path === '/') return <LandingPage navigate={navigate} />
  if (path === '/patients') return <PatientSelector navigate={navigate} />
  if (path === '/consultations') return <PlaceholderPage navigate={navigate} />
  if (path === '/network') return <ProductShell navigate={navigate} section="network"><PhysicianDirectoryPage navigate={navigate} /></ProductShell>
  const networkNpi = path.match(/^\/network\/([^/]+)$/)?.[1]
  if (networkNpi) return <ProductShell navigate={navigate} section="network"><PhysicianProfilePage npi={networkNpi} navigate={navigate} /></ProductShell>
  const patientId = path.match(/^\/patients\/([^/]+)$/)?.[1]
  if (patientId === JORDAN_ID) return <JordanWorkspace navigate={navigate} />
  const demoPatient = DEMO_PATIENTS.find((patient) => patient.id === patientId)
  if (demoPatient) return <UnfinishedPatient patient={demoPatient} navigate={navigate} />
  return <LandingPage navigate={navigate} />
}
