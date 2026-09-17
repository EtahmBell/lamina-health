import { useEffect, useMemo, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { LaminaMark } from './LaminaMark'
import { consultNetwork, getAgentNetwork, getConsultationHistory, getConsultationRecord, getMyAgent, getPatient, getPatientActivity, updateAgentLearning, type AgentLearning, type Consultation, type ConsultationMessage, type ConsultationRecord, type Evaluation, type MyAgent, type NetworkAgent, type Patient, type PatientActivity } from './api'
import { groupConsultationMessages } from './consultationPresentation'
import { DEMO_PATIENTS, type DemoPatientSummary } from './demoPatients'
import { PhysicianDirectoryPage, PhysicianProfilePage } from './PhysicianNetwork'

const JORDAN_ID = 'patient-ckd-htn-001'
const MARIA_ID = 'patient-ida-002'
type Navigate = (path: string) => void

function Brand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

function SyntheticStatus() {
  return <div className="synthetic-status"><span />Synthetic demo · no PHI</div>
}

const navItems = [
  { id: 'home', title: 'Home', icon: '⌂', path: '/' },
  { id: 'patients', title: 'Patients', icon: '✦', path: '/patients' },
  { id: 'consultations', title: 'Consultations', icon: '◫', path: '/consultations' },
  { id: 'agent', title: 'My Agent', icon: '◇', path: '/agent' },
  { id: 'network', title: 'Physician Network', icon: '⌁', path: '/network' },
] as const

function ProfileControl({ navigate }: { navigate: Navigate }) {
  return <button className="profile-control" onClick={() => navigate('/profile')} aria-label="Open clinician profile"><span>LC</span><strong>Dr. Lianne Cha</strong></button>
}

function ProductShell({ children, navigate, section }: { children: React.ReactNode; navigate: Navigate; section: string }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')}><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span><b>{item.title}</b></span></button>)}
        </nav>
      </div>
      <div className="sidebar-clinician"><div className="clinician-avatar">LC</div><div><span>Your physician agent</span><strong>Dr. Lianne Cha's Agent</strong><small>Active · Primary Care</small></div></div>
    </aside>
    <div className="workspace"><header className="workspace-bar"><div><span>Physician agent workspace</span><b>/</b><strong>{section === 'patients' ? 'Patients' : section === 'consultations' ? 'Consultation History' : section === 'agent' ? 'My Agent' : section === 'profile' ? 'Profile' : 'Physician Network'}</strong></div><div className="workspace-bar-actions"><SyntheticStatus /><ProfileControl navigate={navigate} /></div></header>{children}</div>
  </div>
}

function LandingPage({ navigate }: { navigate: Navigate }) {
  return <main className="landing-page">
    <header className="landing-header"><Brand /><div className="landing-header-actions"><SyntheticStatus /><ProfileControl navigate={navigate} /></div></header>
    <section className="landing-content">
      <p className="eyebrow">Primary care workspace</p>
      <h1>Good morning, Dr. Lianne Cha.</h1>
      <p className="landing-question">Who are we helping today?</p>
      <button className="landing-network-control" onClick={() => navigate('/patients')} aria-label="Select patient">
        <span className="ambient-ring one" /><span className="ambient-ring two" /><span className="ambient-line line-one" /><span className="ambient-line line-two" />
        <NetworkMark active />
        <span className="landing-agent-label">YOUR AGENT · ACTIVE</span>
        <strong>Select patient</strong><small>Consult the physician network</small>
      </button>
      <p className="agent-ready">Dr. Lianne Cha's Agent is active and ready to consult the network.</p>
      <nav className="landing-secondary" aria-label="Secondary navigation"><button onClick={() => navigate('/consultations')}>Recent consultations <span>→</span></button><button onClick={() => navigate('/network')}>Physician network <span>→</span></button></nav>
    </section>
    <p className="landing-footnote">Lamina helps primary care teams find the right specialist, required workup, and appropriate access.</p>
  </main>
}

function PatientSelector({ navigate }: { navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [activity, setActivity] = useState<PatientActivity[]>([])
  const [activityError, setActivityError] = useState(false)
  useEffect(() => { getPatientActivity().then(setActivity).catch(() => setActivityError(true)) }, [])
  const activityFor = (id: string) => activity.find((item) => item.patient_id === id)
  const visible = DEMO_PATIENTS.filter((patient) => `${patient.name} ${patient.reason} ${patient.location}`.toLowerCase().includes(query.toLowerCase()))
  const consulted = visible.filter((item) => activityFor(item.id)?.last_consultation).sort((a, b) => (activityFor(b.id)?.last_consultation || '').localeCompare(activityFor(a.id)?.last_consultation || ''))
  const ready = visible.filter((item) => item.implemented && !activityFor(item.id)?.last_consultation).sort((a, b) => (activityFor(b.id)?.last_opened || '').localeCompare(activityFor(a.id)?.last_opened || ''))
  const other = visible.filter((item) => !item.implemented && !activityFor(item.id)?.last_consultation)
  const group = (title: string, patients: DemoPatientSummary[]) => patients.length > 0 && <section className="patient-group" key={title}><div className="patient-group-heading"><h2>{title}</h2><span>{patients.length}</span></div><div className="patient-card-list">{patients.map((patient) => { const record = activityFor(patient.id); return <button key={patient.id} className="patient-select-card" onClick={() => navigate(`/patients/${patient.id}`)}><span className="patient-row-avatar">{patient.initials}</span><span className="patient-card-main"><strong>{patient.name}</strong><small>{patient.age} years · {patient.location}</small><span>{patient.reason}</span>{record?.last_consultation && <em>Last consulted {formatTime(record.last_consultation)} · {record.consultation_count} consult{record.consultation_count === 1 ? '' : 's'}</em>}{!record?.last_consultation && record?.last_opened && <em>Opened {formatTime(record.last_opened)}</em>}</span><span className={`patient-status ${patient.implemented ? 'ready' : ''}`}>{record?.last_consultation ? 'Consulted' : patient.status}</span><span className="patient-card-cta">{patient.implemented ? 'Open patient' : 'View demo'} <b>→</b></span></button> })}</div></section>
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell selector-page">
    <button className="text-button back-link" onClick={() => navigate('/')}>← Home</button>
    <header className="selector-header"><div><p className="eyebrow">Specialty Care Consult</p><h1>Select a patient</h1><p>Choose the patient whose next step in specialty care needs clarification.</p></div><span>{DEMO_PATIENTS.length} synthetic patients</span></header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients or clinical problem…" aria-label="Search patients" /></label>
    {activityError && <p className="muted-note">Lamina activity is temporarily unavailable; patient clinical records remain accessible.</p>}
    {group('Recently consulted', consulted)}{group('Ready to consult', ready)}{group('Other demo patients', other)}
    {!visible.length && <div className="empty-state"><NetworkMark /><h2>No patients found</h2><p>Try a different name or clinical problem.</p></div>}
  </main></ProductShell>
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function patientName(id: string) { return DEMO_PATIENTS.find((item) => item.id === id)?.name || id }

function ConsultationsPage({ navigate }: { navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationHistory().then(setRecords).catch((err: Error) => setError(err.message)).finally(() => setLoading(false)) }, [])
  return <ProductShell navigate={navigate} section="consultations"><main className="page-shell history-page"><p className="eyebrow">Agent activity</p><h1>Consultation History</h1><p className="page-intro">Completed specialty-care consultations from this Lamina workspace. No referral has been submitted.</p>
    {loading && <p className="muted-note">Loading consultations…</p>}{error && <div className="error-banner" role="alert">{error}</div>}
    {!loading && !error && !records.length && <div className="empty-state history-empty"><NetworkMark /><h2>No consultations yet</h2><p>Completed physician-network consultations will appear here.</p><button className="button-primary" onClick={() => navigate('/patients')}>Select patient →</button></div>}
    <div className="history-list">{records.map((record) => <article className="history-card" key={record.id}><span className="patient-row-avatar">{DEMO_PATIENTS.find((item) => item.id === record.patient_id)?.initials}</span><div><span className="section-label">Completed · {formatTime(record.completed_at)}</span><h2>{patientName(record.patient_id)}</h2><p>→ {record.result.recommended_physician.physician_name.replace(' (synthetic)', '')} · {record.result.recommended_physician.specialty}</p><small>Workup identified · Ready to refer in demo</small></div><div className="history-actions"><button className="button-primary" onClick={() => navigate(`/consultations/${record.id}`)}>View consultation →</button><button className="text-button" onClick={() => navigate(`/patients/${record.patient_id}`)}>Reopen patient</button></div></article>)}</div>
  </main></ProductShell>
}

function ConsultationRecordPage({ id, navigate }: { id: number; navigate: Navigate }) {
  const [record, setRecord] = useState<ConsultationRecord | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationRecord(id).then(setRecord).catch((err: Error) => setError(err.message)) }, [id])
  return <ProductShell navigate={navigate} section="consultations"><main className="page-shell history-detail"><button className="text-button back-link" onClick={() => navigate('/consultations')}>← Consultation History</button>{error && <div className="error-banner" role="alert">{error}</div>}{!record && !error && <p className="muted-note">Loading consultation record…</p>}{record && <><p className="eyebrow">Completed consultation · {formatTime(record.completed_at)}</p><h1>{patientName(record.patient_id)}</h1><p className="page-intro">A saved structured consultation. Clinical context remains in the patient workspace.</p><button className="button-secondary" onClick={() => navigate(`/patients/${record.patient_id}`)}>Reopen patient →</button><RecommendationView consultation={record.result} /></>}</main></ProductShell>
}

function MyAgentPage({ navigate }: { navigate: Navigate }) {
  const [agent, setAgent] = useState<MyAgent | null>(null)
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [selected, setSelected] = useState('renal')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const refresh = () => getMyAgent().then(setAgent).catch((err: Error) => setError(err.message))
  useEffect(() => { refresh(); getConsultationHistory().then(setRecords).catch(() => {}) }, [])
  useEffect(() => { if (editing) document.getElementById(`edit-${editing}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [editing])
  const act = async (learning: AgentLearning, action: 'confirm' | 'edit' | 'reject', statement?: string) => {
    try { await updateAgentLearning(learning.key, action, statement); setEditing(null); setError(''); await refresh() } catch (err) { setError(err instanceof Error ? err.message : 'Could not save preference') }
  }
  const calibration = agent?.calibrations[selected]
  const selectedLearning = agent?.learnings.find((item) => item.key === selected)
  const confirmed = selectedLearning?.status === 'confirmed'
  return <ProductShell navigate={navigate} section="agent"><main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}{!agent && !error && <p className="muted-note">Opening your agent…</p>}
    {agent && <><section className="agent-hero"><div className="agent-hero-mark"><NetworkMark active /></div><div><p className="eyebrow">Your physician agent</p><h1>Dr. Lianne Cha's Agent</h1><p>Primary Care · Represents your configured practice across the Lamina physician network.</p><span className="agent-state"><i /> ACTIVE</span></div></section>
      <div className="agent-section-grid"><section className="agent-panel"><p className="eyebrow">Inspectable practice profile</p><h2>What my agent knows</h2><p className="panel-intro">Every fact has a source. Demo rules are not physician-confirmed preferences.</p><div className="agent-facts">{agent.known.map((fact, index) => <div key={`${fact.label}-${index}`}><span>{fact.label}</span><strong>{fact.value}</strong><small>Source: {fact.source}</small></div>)}</div></section>
      <section className="agent-panel access-panel"><p className="eyebrow">Clear boundaries</p><h2>What my agent can access</h2><div className="agent-access">{agent.access.map((item) => <div key={item.label}><strong>{item.label}</strong><span>{item.detail}</span></div>)}</div></section></div>
      <section className="agent-panel learning-panel"><div className="panel-header"><div><p className="eyebrow">Under your control</p><h2>What my agent is learning</h2><p className="panel-intro">Suggestions from synthetic rules are not silently treated as your preferences. Confirmation here does not change the existing consult engine.</p></div></div><div className="learning-grid">{agent.learnings.map((learning) => <article className="learning-card" key={learning.key}><span className={`learning-status ${learning.status}`}>{learning.status === 'suggested' ? 'Suggested · needs confirmation' : learning.status === 'confirmed' ? 'Physician-confirmed' : 'Rejected'}</span><p>{learning.statement}</p><small>Source: {learning.provenance}</small>{editing === learning.key ? <div className="learning-edit"><label htmlFor={`edit-${learning.key}`}>Correct this preference</label><textarea id={`edit-${learning.key}`} maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button className="button-primary" disabled={!draft.trim()} onClick={() => act(learning, 'edit', draft)}>Save draft</button><button className="text-button" onClick={() => setEditing(null)}>Cancel</button></div></div> : <div className="learning-actions"><button onClick={() => act(learning, 'confirm')} disabled={learning.status === 'confirmed'}>Confirm</button><button onClick={() => { setEditing(learning.key); setDraft(learning.statement) }}>Edit</button><button onClick={() => act(learning, 'reject')} disabled={learning.status === 'rejected'}>Reject</button></div>}</article>)}</div></section>
      <section className="agent-panel calibration-panel"><div><p className="eyebrow">Check your representation</p><h2>Test my agent</h2><p className="panel-intro">Choose a bounded demo scenario. No open-ended medical advice or autonomous learning.</p></div><div className="calibration-layout"><div className="calibration-questions">{Object.entries(agent.calibrations).map(([key, item]) => <button key={key} className={selected === key ? 'active' : ''} onClick={() => setSelected(key)}>{item.question} <span>→</span></button>)}</div>{calibration && selectedLearning && <article className="calibration-answer"><span>Dr. Lianne Cha's Agent · structured response</span><h3>{calibration.question}</h3><p>{confirmed ? selectedLearning.statement : calibration.answer}</p><small>Based on: {confirmed ? selectedLearning.provenance : calibration.based_on.join(' · ')}. {confirmed ? 'Your confirmed demo preference is shown here.' : 'Not yet confirmed as your preference.'}</small><div><button className="button-primary" onClick={() => act(selectedLearning, 'confirm')} disabled={confirmed}>That's right</button><button className="button-secondary" onClick={() => { setEditing(selected); setDraft(selectedLearning.statement) }}>Change this</button></div></article>}</div></section>
      <section className="agent-panel agent-activity"><div className="panel-header"><div><p className="eyebrow">Actual Lamina records</p><h2>Recent agent activity</h2></div><button className="text-button" onClick={() => navigate('/consultations')}>All consultations →</button></div>{!records.length && <p className="muted-note">No completed consultations yet. Your agent's consult activity will appear after a network consultation.</p>}{records.slice(0, 4).map((record) => <button className="agent-activity-row" key={record.id} onClick={() => navigate(`/consultations/${record.id}`)}><span className="patient-row-avatar">{DEMO_PATIENTS.find((item) => item.id === record.patient_id)?.initials}</span><span><strong>Consulted physician agents for {patientName(record.patient_id)}</strong><small>{record.result.recommended_physician.physician_name.replace(' (synthetic)', '')} · {record.result.recommended_physician.specialty} recommended</small><em>{formatTime(record.completed_at)} · {record.result.messages.length} structured events</em></span><b>→</b></button>)}</section>
    </>}
  </main></ProductShell>
}

function ProfilePage({ navigate }: { navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="profile"><main className="page-shell profile-page"><button className="text-button back-link" onClick={() => navigate('/')}>← Home</button><div className="agent-panel"><span className="clinician-avatar">LC</span><p className="eyebrow">Synthetic clinician profile</p><h1>Dr. Lianne Cha</h1><p>Primary Care · Oakland, CA</p><p>Dr. Lianne Cha's Agent: <strong>Active</strong></p><p className="muted-note">This demo does not include account authentication or production practice verification.</p><button className="button-primary" onClick={() => navigate('/agent')}>View My Agent →</button></div></main></ProductShell>
}

function UnfinishedPatient({ patient, navigate }: { patient: DemoPatientSummary; navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell unfinished-page"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button><div className="unfinished-card"><span className="patient-row-avatar large">{patient.initials}</span><p className="eyebrow">Synthetic patient</p><h1>{patient.name}</h1><p className="unfinished-meta">{patient.age} years · {patient.location}</p><div className="unfinished-reason"><span>Reason for consult</span><strong>{patient.reason}</strong></div><NetworkMark /><h2>This demo case is not implemented yet.</h2><p>Choose Jordan Lee or Maria Santos for a grounded physician-agent consultation. No recommendation has been fabricated for this patient.</p><button className="button-secondary" onClick={() => navigate(`/patients/${JORDAN_ID}`)}>Open Jordan Lee demo</button></div></main></ProductShell>
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return <svg className="trend-icon" viewBox="0 0 20 20" aria-hidden="true"><path d={direction === 'up' ? 'M4 14 10 8l3 3 3-5M12 6h4v4' : 'M4 6l6 6 3-3 3 5M12 14h4v-4'} /></svg>
}

const physicianInitials = (name: string) => name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
const evidenceFor = (evaluation: Evaluation, kind: string) => evaluation.evidence.find((item) => item.kind === kind)?.detail
const cleanName = (name: string) => name.replace(' (synthetic)', '')
const insuranceLabel = (status: string) => status.startsWith('In network') ? 'In-network' : 'Network unknown'

function ConsultationNetwork({ result, visibleCount, consulting, networkAgents }: { result: Consultation | null; visibleCount: number; consulting: boolean; networkAgents: NetworkAgent[] }) {
  const messages = result?.messages || []
  const visible = messages.slice(0, visibleCount)
  const current = visible.at(-1)
  const stages = groupConsultationMessages(visible)
  const resolved = Boolean(result && !consulting)
  const agents = result?.consultation || []
  const clarification = visible.filter((item) => item.message_type === 'follow_up_question' || item.message_type === 'follow_up_answer')
  const activeAgent = current && agents.find((item) => current.sender_name.includes(cleanName(item.physician_name)) || current.recipient_agent_id === networkAgents.find((node) => node.physician_id === item.physician_id)?.id)
  const nodePositions = [[165, 90], [835, 90], [105, 340], [500, 365], [895, 340]]
  return <section className={`consult-experience ${resolved ? 'resolved' : ''}`} role="status" aria-live="polite">
    <header className="consult-experience-heading"><div><p className="eyebrow">Dr. Lianne Cha's Agent · network consultation</p><h2>{resolved ? 'Recommendation ready' : current ? stages.at(-1)?.title : 'Preparing patient context'}</h2><p>{resolved ? 'A specialist has emerged from the structured agent consultation below.' : result ? 'Replaying this consultation’s recorded events in sequence.' : 'Requesting a structured consult from the physician network…'}</p></div><span className="consult-progress">{result ? `${visibleCount} / ${messages.length} recorded events` : 'Awaiting response'}</span></header>
    <div className="consult-stage-rail">{stages.map((stage) => <span key={stage.id} className={current && stage.messages.some((item) => item.id === current.id) && !resolved ? 'current' : 'complete'}>{stage.title}<small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></span>)}{!stages.length && <span className="current">Preparing case</span>}</div>
    <div className="consult-network-stage"><svg viewBox="0 0 1000 450" preserveAspectRatio="none" aria-hidden="true">{agents.map((agent, index) => { const [x, y] = nodePositions[index]; const participating = visible.some((item) => item.sender_name.includes(cleanName(agent.physician_name))); return <line key={agent.physician_id} x1="500" y1="220" x2={x} y2={y} className={`${participating ? 'participating' : ''} ${activeAgent?.physician_id === agent.physician_id && !resolved ? 'current' : ''} ${resolved && result?.recommended_physician.physician_id === agent.physician_id ? 'chosen' : ''}`} /> })}</svg>
      <div className="consult-network-center"><NetworkMark active={consulting} resolved={resolved} /><span>YOUR AGENT · ACTIVE</span><strong>Dr. Lianne Cha's Agent</strong><small>Patient context → physician network</small></div>
      {agents.map((agent, index) => { const name = cleanName(agent.physician_name); const events = visible.filter((item) => item.sender_name.includes(name)); const latest = events.at(-1); const profile = networkAgents.find((node) => node.physician_id === agent.physician_id); const status = profile?.status === 'active' ? 'Active demo profile' : profile?.status === 'verified' ? 'Verified demo profile' : profile?.status === 'verification_pending' ? 'Claimed demo profile' : profile?.status === 'reserved' ? 'Reserved demo profile' : 'Synthetic representative'; const conclusion = !latest ? 'Reviewing case…' : latest.message_type === 'redirect' ? 'Redirects · not first fit' : latest.message_type === 'follow_up_question' ? 'Clarification requested' : latest.message_type === 'follow_up_answer' ? 'Referral sequence clarified' : latest.message_type === 'referral_requirement' ? 'Accepts · workup specified' : agent.clinical_fit === 'strong' ? 'Strong fit' : 'Appropriate alternative'; return <div className={`consult-peer consult-peer-${index + 1} ${latest ? 'responded' : ''} ${resolved && agent.physician_id === result?.recommended_physician.physician_id ? 'chosen' : ''} ${activeAgent?.physician_id === agent.physician_id && !resolved ? 'current' : ''}`} key={agent.physician_id}><span className="consult-peer-avatar">{physicianInitials(name)}</span><div><strong>{name}'s Agent</strong><small>{agent.specialty} · {status}</small></div><em>{conclusion}</em>{latest && <p>{latest.summary}</p>}</div> })}
    </div>
    {current && !resolved && <div className={`consult-current-event ${current.message_type}`}><span>{current.sequence.toString().padStart(2, '0')}</span><div><strong>{current.sender_name} <b>→</b> {current.recipient_agent_id === 'network' ? 'Physician network' : current.recipient_agent_id === 'agent-pcp-lianne-cha' ? "Dr. Lianne Cha's Agent" : agents.find((item) => networkAgents.find((node) => node.physician_id === item.physician_id)?.id === current.recipient_agent_id)?.physician_name.replace(' (synthetic)', '') || 'specialist agent'}</strong><p>{current.summary}</p></div><em>{messageLabel(current)}</em></div>}
    {clarification.length > 0 && <div className="consult-clarification"><span>Agent-to-agent clarification</span><div>{clarification.map((item) => <p key={item.id}><b>{item.sender_name}</b><span>{item.summary}</span></p>)}</div></div>}
    {resolved && result && <div className="consult-resolution"><NetworkMark resolved /><span>From this consultation</span><strong>{cleanName(result.recommended_physician.physician_name)} · {result.recommended_physician.specialty}</strong><small>{result.why}</small><b>Recommendation ↓</b></div>}
    <p className="consult-demo-boundary">Synthetic representatives follow controlled demo practice footprints. A Reserved profile is not a physician-authorised Lamina agent. Only backend consultation events are shown.</p>
  </section>
}

const messageLabel = (message: ConsultationMessage) => {
  if (message.message_type === 'fit_response') return `${String(message.metadata.clinical_fit || 'fit')} fit`
  return message.message_type.replaceAll('_', ' ')
}

function ConsultationLog({ messages }: { messages: ConsultationMessage[] }) {
  const stages = groupConsultationMessages(messages)
  return <div className="consult-record-stages"><header><strong>Structured consultation record</strong><small>{messages.length} backend events · original sequence preserved</small></header>{stages.map((stage) => <section className={`consult-record-stage ${stage.kind}`} key={stage.id}><div className="consult-record-stage-heading"><span>{stage.title}</span><small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></div><div className="consult-record-events">{stage.messages.map((message) => <details className="consult-record-event" key={message.id}><summary><span>{message.sequence.toString().padStart(2, '0')}</span><div><strong>{message.sender_name}</strong><small>{message.summary}</small></div><em>{messageLabel(message)}</em></summary><div className="consult-record-evidence"><p>{message.sender_role} → {message.recipient_agent_id === 'agent-pcp-lianne-cha' ? "Dr. Lianne Cha's Agent" : message.recipient_agent_id === 'network' ? 'Physician network' : 'Specialist agent'}</p>{message.related_patient_facts.map((fact) => <p key={fact}><b>Patient fact</b>{fact}</p>)}{message.evidence.map((item, index) => <p key={`${index}-${item.kind}`}><b>{item.kind.replaceAll('_', ' ')}</b>{item.detail}</p>)}{!message.evidence.length && !message.related_patient_facts.length && <p>No additional structured evidence on this event.</p>}</div></details>)}</div></section>)}</div>
}

function RecommendationView({ consultation }: { consultation: Consultation }) {
  const [networkOpen, setNetworkOpen] = useState(false)
  const [handlingOpen, setHandlingOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const primary = consultation.recommended_physician
  const historical = evidenceFor(primary, 'historical_practice_similarity')
  const explicitRule = evidenceFor(primary, 'explicit_physician_rule')
  const operational = evidenceFor(primary, 'operational')
  const anemiaCase = primary.specialty === 'Gastroenterology'
  const patientFact = (term: string) => consultation.patient_facts_used.find((fact) => fact.toLowerCase().includes(term))
  const reasons = (anemiaCase ? [patientFact('hemoglobin declined'), patientFact('no documented prior'), explicitRule] : [patientFact('creatinine'), patientFact('egfr'), explicitRule]).filter(Boolean) as string[]
  const shortName = cleanName(primary.physician_name).split(' ').at(-1)
  return <section className="recommendations" aria-label="Specialist recommendations">
    <article className="best-fit-card"><div className="best-fit-label"><span>{anemiaCase ? 'Recommended first referral' : 'Recommended physician'}</span><small>Network resolved · {consultation.consultation.length} agents consulted</small></div><div className="best-fit-physician"><span className="physician-avatar">{physicianInitials(primary.physician_name)}</span><div><h2>{cleanName(primary.physician_name)}</h2><p>{primary.specialty}</p></div><div className="fit-summary"><span>Strong clinical fit</span><span>{primary.availability.replace('Approximately ', '')}</span><span>{insuranceLabel(primary.insurance_status)}</span></div></div>
      <div className="best-fit-body"><section><p className="section-label">Why Dr. {shortName}</p><ul className="reason-list">{reasons.map((reason) => <li key={reason}><span>✓</span>{reason}</li>)}</ul></section><section className="before-visit"><p className="section-label">Required before referral</p>{consultation.before_referral.map((item) => <span key={item}>{item.includes('(') ? item.match(/\(([^)]+)\)/)?.[1] : item}<small>{item}</small></span>)}</section></div>
      <div className="recommendation-access"><div><span>Access</span><strong>{primary.availability}</strong></div><div><span>Insurance</span><strong>{primary.insurance_status}</strong></div></div>
      <button className="agent-handling-toggle" aria-expanded={handlingOpen} onClick={() => setHandlingOpen(!handlingOpen)}>How my agent handled this case <span>{handlingOpen ? '−' : '+'}</span></button>
      {handlingOpen && <div className="agent-handling"><div><span>Patient facts</span><ul>{consultation.patient_facts_used.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>{explicitRule && <div><span>Physician rule</span><p>{explicitRule}</p></div>}<div><span>Specialist-agent responses</span><ul>{consultation.consultation.map((agent) => <li key={agent.physician_id}><b>{cleanName(agent.physician_name)}:</b> {agent.reason}</li>)}</ul></div>{historical && <div><span>Practice footprint · fit signal, not quality</span><p>{historical}</p></div>}{operational && <div><span>Access consideration</span><p>{operational}</p></div>}<p>These are structured inputs and recorded conclusions, not private model reasoning.</p></div>}
      <div className="best-fit-actions"><button className="button-primary" onClick={() => setReferralStarted(true)}>Start Referral <span>→</span></button>{referralStarted && <div className="referral-prepared" role="status"><strong>Referral prepared for demo</strong><span>Destination: {cleanName(primary.physician_name)} · {primary.specialty}</span><span>Workup: {consultation.before_referral.join(' · ')}</span><span>No referral was transmitted.</span></div>}</div>
    </article>

    <section className="options-section"><div className="options-heading"><div><p className="eyebrow">Other appropriate choices</p><h2>Referral options</h2></div><p>{anemiaCase ? 'Both specialties may be relevant; sequencing matters.' : 'Different practice focus or access, based on the same supplied evidence.'}</p></div><div className="option-grid">{consultation.alternatives.map((option, index) => <article className="option-card" key={option.physician_id}><div><span className="mini-avatar">{physicianInitials(option.physician_name)}</span><span className="option-label">{anemiaCase && option.specialty === 'Haematology' ? 'Appropriate later' : index === 0 ? 'Strong alternative' : 'Additional option'}</span></div><h3>{cleanName(option.physician_name)}</h3><p className="option-specialty">{option.specialty}</p><div className="option-meta"><span>{option.clinical_fit} fit</span><span>{option.availability.replace('Approximately ', '')}</span><span>{insuranceLabel(option.insurance_status)}</span></div><p className="option-reason">{option.reason}</p></article>)}</div></section>

    <section className="network-transparency"><button className="network-transparency-toggle" onClick={() => setNetworkOpen(!networkOpen)} aria-expanded={networkOpen}><span><NetworkMark resolved /><span><b>View network consultation</b><small>All five physician-agent conclusions and supporting evidence</small></span></span><em>{networkOpen ? 'Hide' : 'View'} <i>⌄</i></em></button>
      {networkOpen && <div className="network-record"><div className="record-note">Deliberate structured messages and evidence only. Hidden model chain-of-thought is not stored or shown.</div><ConsultationLog messages={consultation.messages} /><div className="evaluation-record-heading">Physician evaluation records</div>{consultation.consultation.map((agent) => { const rule = evidenceFor(agent, 'explicit_physician_rule'); const history = evidenceFor(agent, 'historical_practice_similarity'); return <details key={agent.physician_id} open={agent.physician_id === primary.physician_id}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{cleanName(agent.physician_name)}</b><small>{agent.specialty}</small></span><span className={`decision-badge ${agent.clinical_fit}`}>{agent.accepts_case ? agent.clinical_fit === 'strong' ? 'Strong fit' : 'Accepts' : 'Redirect'}</span><span className="chevron">⌄</span></summary><div className="structured-evidence"><p>{agent.reason}</p><div className="evidence-grid"><div><span>Decision</span><strong>{agent.accepts_case ? 'Accepts case' : 'Redirects / does not accept'}</strong></div><div><span>Availability</span><strong>{agent.availability}</strong></div><div><span>Insurance</span><strong>{insuranceLabel(agent.insurance_status)}</strong></div><div><span>Required workup</span><strong>{agent.required_workup.join(' · ')}</strong></div>{rule && <div className="wide"><span>Relevant physician rule</span><strong>{rule}</strong></div>}{history && <div className="wide"><span>Historical-practice signal</span><strong>{history}</strong></div>}</div></div></details> })}</div>}
    </section>
    <p className="disclaimer">{consultation.disclaimer}</p>
  </section>
}

function PatientWorkspace({ patientId, navigate }: { patientId: string; navigate: Navigate }) {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [networkAgents, setNetworkAgents] = useState<NetworkAgent[]>([])
  const [visibleMessageCount, setVisibleMessageCount] = useState(0)
  const [context, setContext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const demoPatient = DEMO_PATIENTS.find((item) => item.id === patientId)
  const anemiaCase = patientId === MARIA_ID
  useEffect(() => { setLoading(true); getPatient(patientId).then(setPatient).catch((loadError: Error) => setError(loadError.message)).finally(() => setLoading(false)) }, [patientId])
  useEffect(() => { getAgentNetwork().then((network) => setNetworkAgents(network.nodes)).catch(() => setNetworkAgents([])) }, [])
  useEffect(() => { if (consulting) document.querySelector('.consult-experience')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [consulting])
  const labs = useMemo(() => { if (!patient) return []; const creatinine = patient.labs.filter((item) => item.test === 'creatinine'); const egfr = patient.labs.filter((item) => item.test === 'eGFR'); return creatinine.map((item, index) => ({ date: item.date, creatinine: item.value, egfr: egfr[index]?.value ?? 0 })) }, [patient])
  const chartPoints = useMemo(() => { if (!labs.length) return { creatinine: '', egfr: '' }; const x = (index: number) => 8 + (index / (labs.length - 1)) * 84; const y = (value: number, min: number, max: number) => 82 - ((value - min) / (max - min)) * 64; return { creatinine: labs.map((item, index) => `${x(index)},${y(item.creatinine, 1.1, 1.8)}`).join(' '), egfr: labs.map((item, index) => `${x(index)},${y(item.egfr, 41, 68)}`).join(' ') } }, [labs])
  const hemoglobin = useMemo(() => patient?.labs.filter((item) => item.test === 'hemoglobin') ?? [], [patient])
  const hemoglobinPoints = useMemo(() => hemoglobin.map((item, index) => `${8 + (index / Math.max(hemoglobin.length - 1, 1)) * 84},${18 + ((10.8 - item.value) / 1.3) * 64}`).join(' '), [hemoglobin])
  const latestLab = (test: Patient['labs'][number]['test']) => patient?.labs.filter((item) => item.test === test).at(-1)
  const runConsult = async () => { setConsulting(true); setConsultation(null); setVisibleMessageCount(0); setError(null); try { const result = await consultNetwork(patientId, context); setConsultation(result); for (let index = 1; index <= result.messages.length; index += 1) { await new Promise((resolve) => setTimeout(resolve, 250)); setVisibleMessageCount(index) } } catch (consultError) { setError(consultError instanceof Error ? consultError.message : 'Consultation failed') } finally { setConsulting(false) } }
  if (loading) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded"><div className="loading-line" /><p>Opening patient workspace…</p></div></ProductShell>
  if (!patient) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded error"><p>{error || 'Patient unavailable'}</p></div></ProductShell>
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button>
    <header className="consult-header"><div><p className="eyebrow">Specialty Care Consult</p><h1>{demoPatient?.name ?? cleanName(patient.display_name)}</h1><div className="patient-demographics"><span><b>Age</b>{patient.age} years</span><span><b>Location</b>{patient.location}</span><span className="clinical-source"><b>Clinical data</b>{patient.clinical_data_source === 'medplum_fhir' ? 'Synthetic FHIR via Medplum' : 'Local synthetic fixture'}</span></div></div><div className="patient-monogram">{demoPatient?.initials}</div></header>
    <section className="referral-context" aria-label="Referral context"><div><span>Referring clinician</span><strong>Dr. Lianne Cha</strong><small>Primary Care</small></div><div><span>Insurance</span><strong>{patient.insurance}</strong><small>Coverage on file</small></div><div className="consult-reason"><span>Reason for consult</span><strong>{demoPatient?.reason}</strong></div></section>
    {error && <div className="error-banner" role="alert"><strong>Unable to complete this action.</strong> {error}</div>}
    <section className="network-action"><div className="network-copy"><NetworkMark active={consulting} resolved={Boolean(consultation)} /><div><p className="eyebrow">Physician agent network</p><h2>Find the appropriate next step in specialty care.</h2><p>{anemiaCase ? 'Determine which specialty should evaluate first, what workup is needed, and when another specialty may follow.' : 'Compare best-fit specialists, required workup, and fastest appropriate access.'}</p></div></div><div className="network-controls"><label><span>Add context for the network <em>Optional</em></span><input value={context} onChange={(event) => setContext(event.target.value)} maxLength={500} placeholder={anemiaCase ? 'e.g. Considering gastroenterology vs haematology' : 'e.g. Considering nephrology vs cardiology'} /></label><button className="consult-button" disabled={consulting} onClick={runConsult}><span>{consulting ? 'Consulting…' : 'Consult Network'}</span><span>→</span></button></div></section>
    {(consulting || consultation) && <ConsultationNetwork result={consultation} visibleCount={visibleMessageCount} consulting={consulting} networkAgents={networkAgents} />}{consultation && !consulting && <RecommendationView consultation={consultation} />}
    <div className="clinical-grid"><section className="clinical-card"><div className="card-title"><span className="card-icon">+</span><div><p>Clinical context</p><h2>Active diagnoses</h2></div><b>{patient.diagnoses.length}</b></div><ul className="clinical-list">{patient.diagnoses.map((item) => <li key={item}><span />{item}</li>)}</ul></section><section className="clinical-card"><div className="card-title"><span className="card-icon medication">Rx</span><div><p>Current therapy</p><h2>Medications</h2></div><b>{patient.medications.length}</b></div><ul className="clinical-list medications">{patient.medications.map((item) => <li key={item}><span />{item}</li>)}</ul>{anemiaCase && <p className="therapy-note">Persistent deficiency despite oral therapy</p>}</section>{anemiaCase ? <section className="clinical-card renal-card anemia-card"><div className="card-title"><span className="card-icon chart">↘</span><div><p>Longitudinal labs</p><h2>Anaemia profile</h2></div><span className="status-label warning">Persistent deficiency</span></div><div className="trajectory-summary anemia-summary"><div><span>Hemoglobin</span><strong>10.8 → 9.5 <small>g/dL</small></strong><em><ArrowIcon direction="down" />Decreasing</em></div><div><span>Ferritin</span><strong>{latestLab('ferritin')?.value} <small>ng/mL</small></strong><em>Low iron stores</em></div><div><span>Iron saturation</span><strong>{latestLab('transferrin_saturation')?.value}<small>%</small></strong><em>Low</em></div></div><div className="trajectory-visual anemia-trajectory"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="8" y1="18" x2="92" y2="18" /><line x1="8" y1="50" x2="92" y2="50" /><line x1="8" y1="82" x2="92" y2="82" /><polyline className="hemoglobin-line" points={hemoglobinPoints} /></svg><div className="chart-legend"><span>Hemoglobin</span></div><div className="chart-dates">{hemoglobin.map((item) => <span key={item.date}>{new Date(`${item.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>)}</div></div><div className="anemia-context"><div><span>Pattern</span><strong>Microcytic anaemia · MCV {latestLab('MCV')?.value} fL</strong></div><div><span>Prior workup</span><strong>No documented upper/lower endoscopic evaluation</strong></div></div></section> : <section className="clinical-card renal-card"><div className="card-title"><span className="card-icon chart">↗</span><div><p>Longitudinal labs</p><h2>Renal trajectory</h2></div><span className="status-label warning">Progressive decline</span></div><div className="trajectory-summary"><div><span>Creatinine</span><strong>1.1 → 1.8 <small>mg/dL</small></strong><em><ArrowIcon direction="up" />Increasing</em></div><div><span>eGFR</span><strong>68 → 41 <small>mL/min</small></strong><em><ArrowIcon direction="down" />Decreasing</em></div></div><div className="trajectory-visual"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="8" y1="18" x2="92" y2="18" /><line x1="8" y1="50" x2="92" y2="50" /><line x1="8" y1="82" x2="92" y2="82" /><polyline className="creatinine-line" points={chartPoints.creatinine} /><polyline className="egfr-line" points={chartPoints.egfr} /></svg><div className="chart-legend"><span>Creatinine</span><span className="egfr">eGFR</span></div><div className="chart-dates">{labs.map((item) => <span key={item.date}>{new Date(`${item.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>)}</div></div></section>}</div>
  </main></ProductShell>
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, [])
  const navigate = (next: string) => { window.history.pushState({}, '', next); setPath(next); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  if (path === '/') return <LandingPage navigate={navigate} />
  if (path === '/patients') return <PatientSelector navigate={navigate} />
  if (path === '/consultations') return <ConsultationsPage navigate={navigate} />
  if (path === '/agent') return <MyAgentPage navigate={navigate} />
  if (path === '/profile') return <ProfilePage navigate={navigate} />
  const recordId = path.match(/^\/consultations\/(\d+)$/)?.[1]
  if (recordId) return <ConsultationRecordPage id={Number(recordId)} navigate={navigate} />
  if (path === '/network') return <ProductShell navigate={navigate} section="network"><PhysicianDirectoryPage navigate={navigate} /></ProductShell>
  const networkNpi = path.match(/^\/network\/([^/]+)$/)?.[1]
  if (networkNpi) return <ProductShell navigate={navigate} section="network"><PhysicianProfilePage npi={networkNpi} navigate={navigate} /></ProductShell>
  const patientId = path.match(/^\/patients\/([^/]+)$/)?.[1]
  if (patientId === JORDAN_ID || patientId === MARIA_ID) return <PatientWorkspace patientId={patientId} navigate={navigate} />
  const demoPatient = DEMO_PATIENTS.find((patient) => patient.id === patientId)
  if (demoPatient) return <UnfinishedPatient patient={demoPatient} navigate={navigate} />
  return <LandingPage navigate={navigate} />
}
