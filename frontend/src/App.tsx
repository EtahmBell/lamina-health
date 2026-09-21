import { useEffect, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { LaminaMark } from './LaminaMark'
import { consultNetwork, getAgentNetwork, getConsultationHistory, getConsultationRecord, getMyAgent, getPatient, getPatientActivity, updateAgentLearning, type AgentLearning, type Consultation, type ConsultationMessage, type ConsultationRecord, type Evaluation, type MyAgent, type NetworkAgent, type Patient, type PatientActivity } from './api'
import { groupConsultationMessages } from './consultationPresentation'
import { DEMO_PATIENTS, type DemoPatientSummary } from './demoPatients'
import { PhysicianDirectoryPage, PhysicianProfilePage } from './PhysicianNetwork'

const JORDAN_ID = 'patient-ckd-htn-001'
const MARIA_ID = 'patient-ida-002'
const PCP_NAME = 'Dr. Lucy Saru'
const PCP_AGENT_NAME = "Dr. Lucy Saru's Agent"
const PCP_AGENT_ID = 'agent-pcp-lianne-cha'
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
  { id: 'home', title: 'Home', icon: '⌂', path: '/home' },
  { id: 'patients', title: 'Patients', icon: '✦', path: '/patients' },
  { id: 'consultations', title: 'Consultations', icon: '◫', path: '/consultations' },
  { id: 'agent', title: 'My Agent', icon: '◇', path: '/agent' },
  { id: 'network', title: 'Physician Network', icon: '⌁', path: '/network' },
] as const

function ProfileControl({ navigate }: { navigate: Navigate }) {
  return <button className="profile-control" onClick={() => navigate('/profile')} aria-label="Open clinician profile"><span>LS</span><strong>{PCP_NAME}</strong></button>
}

function ProductShell({ children, navigate, section }: { children: React.ReactNode; navigate: Navigate; section: string }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')} aria-label="Return to Lamina portal"><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span><b>{item.title}</b></span></button>)}
        </nav>
      </div>
      <div className="sidebar-clinician"><NetworkMark active /><div><span>Your physician agent</span><strong>{PCP_AGENT_NAME}</strong><small>Active · Primary Care</small></div></div>
    </aside>
    <div className="workspace"><header className="workspace-bar"><div className="workspace-bar-actions"><SyntheticStatus /><ProfileControl navigate={navigate} /></div></header>{children}</div>
  </div>
}

function LandingPage({ navigate }: { navigate: Navigate }) {
  return <main className="landing-page">
    <header className="landing-header"><Brand /><div className="landing-header-actions"><SyntheticStatus /><ProfileControl navigate={navigate} /></div></header>
    <section className="landing-content">
      <p className="eyebrow">Primary care workspace</p>
      <h1>Good morning, {PCP_NAME}.</h1>
      <p className="landing-question">Who are we helping today?</p>
      <button className="landing-network-control" onClick={() => navigate('/home')} aria-label="Enter workspace">
        <span className="ambient-ring one" /><span className="ambient-ring two" /><span className="ambient-line line-one" /><span className="ambient-line line-two" />
        <NetworkMark active />
        <span className="landing-agent-label">YOUR AGENT · ACTIVE</span>
        <strong>Enter workspace</strong><small>See what needs your attention</small>
      </button>
      <p className="agent-ready">{PCP_AGENT_NAME} is active and ready to consult the network.</p>
    </section>
    <p className="landing-footnote">Lamina helps primary care teams find the right specialist, required workup, and appropriate access.</p>
  </main>
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function HomePage({ navigate }: { navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [patientActivity, setPatientActivity] = useState<PatientActivity[]>([])
  const [agent, setAgent] = useState<MyAgent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    Promise.all([getConsultationHistory(), getPatientActivity(), getMyAgent()])
      .then(([consultations, activity, currentAgent]) => { setRecords(consultations); setPatientActivity(activity); setAgent(currentAgent) })
      .catch(() => setError(true)).finally(() => setLoading(false))
  }, [])
  const ordered = [...records].sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  const latestByPatient = ordered.filter((record, index) => ordered.findIndex((item) => item.patient_id === record.patient_id) === index)
  const pending = agent?.learnings.filter((item) => item.status === 'suggested') || []
  const attentionCount = latestByPatient.slice(0, 2).length + (pending.length ? 1 : 0)
  const activity = ordered.flatMap((record) => {
    const physician = cleanName(record.result.recommended_physician.physician_name)
    const clarification = record.result.messages.find((message) => message.message_type === 'follow_up_question')
    return [
      { id: `${record.id}-resolved`, time: record.completed_at, order: 3, title: 'Consultation resolved', detail: `${record.result.recommended_physician.specialty} recommended${record.patient_id === MARIA_ID ? ' first' : ''}`, patient: patientName(record.patient_id), recordId: record.id },
      ...(clarification ? [{ id: `${record.id}-clarification`, time: record.completed_at, order: 2, title: clarification.sender_agent_id === PCP_AGENT_ID ? 'Your agent requested specialist clarification' : `${messageSender(clarification)} requested clarification`, detail: clarification.summary, patient: patientName(record.patient_id), recordId: record.id }] : []),
      { id: `${record.id}-consulted`, time: record.completed_at, order: 1, title: `Your agent consulted ${physician}'s Agent`, detail: `${record.result.consultation.length} physician representatives participated`, patient: patientName(record.patient_id), recordId: record.id },
    ]
  }).sort((a, b) => b.time.localeCompare(a.time) || b.order - a.order).slice(0, 3)
  const activityByPatient = new Map(patientActivity.map((item) => [item.patient_id, item]))
  const recentPatients = [...DEMO_PATIENTS].sort((a, b) => {
    const aDate = activityByPatient.get(a.id)?.last_consultation || activityByPatient.get(a.id)?.last_opened || ''
    const bDate = activityByPatient.get(b.id)?.last_consultation || activityByPatient.get(b.id)?.last_opened || ''
    return bDate.localeCompare(aDate)
  }).slice(0, 3)
  const lastRecord = ordered[0]
  return <ProductShell navigate={navigate} section="home"><main className="page-shell home-page">
    <header className="home-hero"><div><p className="eyebrow">Physician workspace</p><h1>Good morning, Lucy.</h1><p>Recent care activity and the work that needs your attention.</p></div><button className="button-primary home-start" onClick={() => navigate('/patients')}>Start consultation <span>→</span></button></header>
    {loading && <div className="home-loading"><div className="loading-line" /><p>Reviewing recent workspace activity…</p></div>}
    {error && <div className="error-banner" role="alert">Recent workspace activity is temporarily unavailable. Patient records remain accessible.</div>}
    {!loading && !error && <>
      {attentionCount > 0 && <section className="home-attention"><div className="home-section-heading"><div><p className="eyebrow">Current work</p><h2>Needs your attention</h2></div><span>{attentionCount}</span></div><div className="lam-list needs-attention">{latestByPatient.slice(0, 2).map((record) => <button className="lam-row" key={record.id} onClick={() => navigate(`/consultations/${record.id}`)}><span className="lam-row-mark patient-row-avatar">{DEMO_PATIENTS.find((item) => item.id === record.patient_id)?.initials}</span><span className="lam-row-main"><strong>{patientName(record.patient_id)}</strong><span>{record.result.recommended_physician.specialty} recommended{record.patient_id === MARIA_ID ? ' first' : ''}</span><small>{cleanName(record.result.recommended_physician.physician_name)} · Workup identified</small></span><span className="lam-row-action">Review consultation <b>→</b></span></button>)}{pending.length > 0 && <button className="lam-row" onClick={() => navigate('/agent?tab=calibration')}><NetworkMark /><span className="lam-row-main"><strong>{pending.length} agent learning{pending.length === 1 ? '' : 's'}</strong><span>Ready for your confirmation</span><small>Suggested preferences are not used as physician-confirmed rules.</small></span><span className="lam-row-action">Review calibration <b>→</b></span></button>}</div></section>}
      <section className="home-main-grid"><div className="home-activity"><div className="home-section-heading"><div><p className="eyebrow">Operational record</p><h2>Recent activity</h2></div><button className="text-button" onClick={() => navigate('/consultations')}>View all consultations →</button></div>{activity.length ? <div className="activity-stream">{activity.map((item) => <button key={item.id} onClick={() => navigate(`/consultations/${item.recordId}`)}><span className="activity-marker" /><span><strong>{item.title}</strong><small>{item.detail}</small><em>{item.patient} · {relativeTime(item.time)}</em></span><b>→</b></button>)}</div> : <p className="home-empty">No agent activity yet.</p>}</div>
        <aside className="home-agent-card"><div className="home-agent-title"><NetworkMark active /><div><p className="eyebrow">Your Agent</p><h2>{PCP_AGENT_NAME}</h2><span><i /> Active</span></div></div><dl><div><dt>Last activity</dt><dd>{lastRecord ? `Consulted ${lastRecord.result.consultation.length} physician agents for ${patientName(lastRecord.patient_id)}` : 'No consultations yet'}</dd></div></dl><button className="text-button" onClick={() => navigate('/agent')}>View agent →</button></aside>
      </section>
      <section className="home-patients"><div className="home-section-heading"><div><p className="eyebrow">Current patients</p><h2>Recent patients</h2></div><button className="text-button" onClick={() => navigate('/patients')}>View all patients →</button></div><div className="lam-list">{recentPatients.map((patient) => { const record = latestByPatient.find((item) => item.patient_id === patient.id); const workflow = activityByPatient.get(patient.id); return <button className="lam-row" key={patient.id} onClick={() => navigate(`/patients/${patient.id}`)}><span className="lam-row-mark patient-row-avatar">{patient.initials}</span><span className="lam-row-main"><strong>{patient.name}</strong><span>{patient.reason}</span><small>{record ? `${record.result.recommended_physician.specialty} recommended${patient.id === MARIA_ID ? ' first' : ''}` : workflow?.last_opened ? `Opened ${relativeTime(workflow.last_opened)}` : patient.status}</small></span><span className="lam-row-action">Open patient <b>→</b></span></button> })}</div></section>
    </>}
  </main></ProductShell>
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
  const group = (title: string, patients: DemoPatientSummary[]) => patients.length > 0 && <section className="patient-group" key={title}><div className="patient-group-heading"><h2>{title}</h2><span>{patients.length}</span></div><div className="lam-list">{patients.map((patient) => { const record = activityFor(patient.id); return <button key={patient.id} className="lam-row" onClick={() => navigate(`/patients/${patient.id}`)}><span className="lam-row-mark patient-row-avatar">{patient.initials}</span><span className="lam-row-main"><strong>{patient.name}</strong><span>{patient.reason}</span><small>{patient.age} years · {patient.location}{record?.last_consultation ? ` · Last consulted ${formatTime(record.last_consultation)} · ${record.consultation_count} consult${record.consultation_count === 1 ? '' : 's'}` : record?.last_opened ? ` · Opened ${formatTime(record.last_opened)}` : ''}</small></span><span className={`lam-row-status ${patient.implemented ? 'ready' : ''}`}>{record?.last_consultation ? 'Consulted' : patient.status}</span><span className="lam-row-action">{patient.implemented ? 'Open patient' : 'View demo'} <b>→</b></span></button> })}</div></section>
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell selector-page">
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
  return <ProductShell navigate={navigate} section="consultations"><main className="page-shell history-page"><p className="eyebrow">Patient consult records</p><h1>Consultations</h1><p className="page-intro">Completed specialty-care consultations from this Lamina workspace.</p><p className="page-fineprint">No referral has been submitted.</p>
    {loading && <p className="muted-note">Loading consultations…</p>}{error && <div className="error-banner" role="alert">{error}</div>}
    {!loading && !error && !records.length && <div className="empty-state history-empty"><NetworkMark /><h2>No consultations yet</h2><p>Completed physician-network consultations will appear here.</p><button className="button-primary" onClick={() => navigate('/patients')}>Select patient →</button></div>}
    {records.length > 0 && <div className="lam-list">{records.map((record) => <button className="lam-row" key={record.id} onClick={() => navigate(`/consultations/${record.id}`)}><span className="lam-row-mark patient-row-avatar">{DEMO_PATIENTS.find((item) => item.id === record.patient_id)?.initials}</span><span className="lam-row-main"><strong>{patientName(record.patient_id)}</strong><span>{cleanName(record.result.recommended_physician.physician_name)} · {record.result.recommended_physician.specialty}</span><small>Completed {formatTime(record.completed_at)} · Workup identified</small></span><span className="lam-row-status">{record.patient_id === MARIA_ID ? 'Best first referral' : 'Ready to refer'}</span><span className="lam-row-action">View consultation <b>→</b></span></button>)}</div>}
  </main></ProductShell>
}

function ConsultationRecordPage({ id, navigate }: { id: number; navigate: Navigate }) {
  const [record, setRecord] = useState<ConsultationRecord | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationRecord(id).then(setRecord).catch((err: Error) => setError(err.message)) }, [id])
  return <ProductShell navigate={navigate} section="consultations"><main className="page-shell history-detail"><button className="text-button back-link" onClick={() => navigate('/consultations')}>← Consultations</button>{error && <div className="error-banner" role="alert">{error}</div>}{!record && !error && <p className="muted-note">Loading consultation record…</p>}{record && <><p className="eyebrow">Completed consultation · {formatTime(record.completed_at)}</p><h1>{patientName(record.patient_id)}</h1><p className="page-intro">A saved structured consultation. Clinical context remains in the patient workspace.</p><button className="text-button record-open-patient" onClick={() => navigate(`/patients/${record.patient_id}`)}>Open patient →</button><RecommendationView consultation={record.result} /></>}</main></ProductShell>
}

function MyAgentPage({ navigate }: { navigate: Navigate }) {
  const [agent, setAgent] = useState<MyAgent | null>(null)
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [tab, setTab] = useState<'overview' | 'knowledge' | 'calibration' | 'activity'>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    return requested === 'knowledge' || requested === 'calibration' || requested === 'activity' ? requested : 'overview'
  })
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
  const pending = agent?.learnings.filter((item) => item.status === 'suggested').length ?? 0
  const selectTab = (next: typeof tab) => { setTab(next); window.history.replaceState({}, '', `/agent?tab=${next}`) }
  return <ProductShell navigate={navigate} section="agent"><main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}{!agent && !error && <p className="muted-note">Opening your agent…</p>}
    {agent && <><section className="agent-hero"><div className="agent-hero-mark"><NetworkMark active /></div><div><p className="eyebrow">Your physician agent</p><h1>{PCP_AGENT_NAME}</h1><p>Primary Care · Represents how you practise across the Lamina network.</p><span className="agent-state"><i /> ACTIVE</span></div></section>
      <nav className="agent-tabs" aria-label="My Agent sections">{(['overview', 'knowledge', 'calibration', 'activity'] as const).map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      {tab === 'overview' && <div className="agent-overview"><div className="agent-overview-intro"><p className="eyebrow">Practice snapshot</p><h2>Primary care in Oakland, coordinating specialty referrals.</h2><p>Your agent uses bounded patient context, current synthetic referral rules, and the physician network to help choose an appropriate first destination.</p><button className="button-primary" onClick={() => selectTab('calibration')}>Test my agent →</button></div><div className="agent-summary-panel"><p className="eyebrow">Agent summary</p><button onClick={() => selectTab('knowledge')}><span>What is it using?</span><strong>{agent.known.length} attributed knowledge sources</strong><small>View knowledge and access →</small></button><button onClick={() => selectTab('activity')}><span>What has it done?</span><strong>{records[0] ? `Last consultation: ${patientName(records[0].patient_id)}` : 'No agent activity yet'}</strong><small>View activity →</small></button><button onClick={() => selectTab('calibration')}><span>How do I correct it?</span><strong>{pending ? `${pending} item${pending === 1 ? '' : 's'} need confirmation` : 'No new preferences to review'}</strong><small>Open calibration →</small></button></div></div>}
      {tab === 'knowledge' && <div className="agent-section-grid"><section className="agent-panel"><p className="eyebrow">Inspectable practice profile</p><h2>What my agent knows</h2><p className="panel-intro">Every fact has a source. Demo rules are not physician-confirmed preferences.</p><div className="agent-facts">{agent.known.map((fact, index) => <div key={`${fact.label}-${index}`}><span>{fact.label}</span><strong>{fact.value}</strong><small>Source: {fact.source}</small></div>)}</div></section>
      <section className="agent-panel access-panel"><p className="eyebrow">Clear boundaries</p><h2>What my agent can access</h2><div className="agent-access">{agent.access.map((item) => <div key={item.label}><strong>{item.label}</strong><span>{item.detail}</span></div>)}</div></section></div>}
      {tab === 'calibration' && <><section className="agent-panel learning-panel"><div className="panel-header"><div><p className="eyebrow">Under your control</p><h2>Suggested learnings</h2><p className="panel-intro">Suggestions from synthetic rules are not silently treated as your preferences. Confirmation here does not change the existing consult engine.</p></div></div>{pending === 0 && <p className="agent-empty-note">Your agent is up to date. No new practice preferences need review.</p>}<div className="learning-grid">{agent.learnings.map((learning) => <article className="learning-card" key={learning.key}><span className={`learning-status ${learning.status}`}>{learning.status === 'suggested' ? 'Suggested · needs confirmation' : learning.status === 'confirmed' ? 'Physician-confirmed' : 'Rejected'}</span><p>{learning.statement}</p><small>Source: {learning.provenance}</small>{editing === learning.key ? <div className="learning-edit"><label htmlFor={`edit-${learning.key}`}>Correct this preference</label><textarea id={`edit-${learning.key}`} maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button className="button-primary" disabled={!draft.trim()} onClick={() => act(learning, 'edit', draft)}>Save draft</button><button className="text-button" onClick={() => setEditing(null)}>Cancel</button></div></div> : <div className="learning-actions"><button onClick={() => act(learning, 'confirm')} disabled={learning.status === 'confirmed'}>Confirm</button><button onClick={() => { setEditing(learning.key); setDraft(learning.statement) }}>Edit</button><button onClick={() => act(learning, 'reject')} disabled={learning.status === 'rejected'}>Reject</button></div>}</article>)}</div></section>
      <section className="agent-panel calibration-panel"><div><p className="eyebrow">Check your representation</p><h2>Test my agent</h2><p className="panel-intro">Choose a bounded demo scenario. No open-ended medical advice or autonomous learning.</p></div><div className="calibration-layout"><div className="calibration-questions">{Object.entries(agent.calibrations).map(([key, item]) => <button key={key} className={selected === key ? 'active' : ''} onClick={() => setSelected(key)}>{item.question} <span>→</span></button>)}</div>{calibration && selectedLearning && <article className="calibration-answer"><span>{PCP_AGENT_NAME} · structured response</span><h3>{calibration.question}</h3><p>{confirmed ? selectedLearning.statement : calibration.answer}</p><small>Based on: {confirmed ? selectedLearning.provenance : calibration.based_on.join(' · ')}. {confirmed ? 'Your confirmed demo preference is shown here.' : 'Not yet confirmed as your preference.'}</small><div><button className="button-primary" onClick={() => act(selectedLearning, 'confirm')} disabled={confirmed}>That's right</button><button className="button-secondary" onClick={() => { setEditing(selected); setDraft(selectedLearning.statement) }}>Change this</button></div></article>}</div></section></>}
      {tab === 'activity' && <section className="agent-panel agent-activity"><div className="panel-header"><div><p className="eyebrow">Your agent's actions</p><h2>Recent activity</h2></div></div>{!records.length && <p className="agent-empty-note">No agent activity yet.</p>}{records.slice(0, 8).flatMap((record) => { const agentMessages = record.result.messages.filter((message) => message.sender_agent_id === PCP_AGENT_ID); const events = [{ id: `${record.id}-consult`, action: `Consulted ${record.result.consultation.length} physician representatives for ${patientName(record.patient_id)}`, detail: `${record.result.recommended_physician.specialty} recommended · ${formatTime(record.completed_at)}` }, ...agentMessages.filter((message) => message.message_type === 'follow_up_question' || message.message_type === 'follow_up_answer').map((message) => ({ id: `${record.id}-${message.id}`, action: message.message_type === 'follow_up_question' ? `Asked a specialist agent about ${patientName(record.patient_id)}` : `Answered a specialist's clarification for ${patientName(record.patient_id)}`, detail: message.summary }))]; return events.map((event) => <button className="agent-activity-row" key={event.id} onClick={() => navigate(`/consultations/${record.id}`)}><NetworkMark resolved /><span><strong>{event.action}</strong><small>{event.detail}</small></span><b>→</b></button>) })}</section>}
    </>}
  </main></ProductShell>
}

function ProfilePage({ navigate }: { navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="profile"><main className="page-shell profile-page">
    <button className="text-button back-link" onClick={() => navigate('/home')}>← Home</button>
    <section className="profile-composition">
      <span className="clinician-avatar large">LS</span>
      <p className="eyebrow">Synthetic clinician profile</p>
      <h1>{PCP_NAME}</h1>
      <p className="profile-role">Primary Care · Oakland, CA</p>
      <div className="profile-agent-line"><NetworkMark active /><span><small>Your physician agent</small><strong>{PCP_AGENT_NAME}</strong><em><i />Active</em></span></div>
      <button className="button-primary" onClick={() => navigate('/agent')}>View My Agent →</button>
      <p className="muted-note">This demo does not include account authentication or production practice verification.</p>
    </section>
  </main></ProductShell>
}

function UnfinishedPatient({ patient, navigate }: { patient: DemoPatientSummary; navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell unfinished-page"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button><div className="unfinished-card"><span className="patient-row-avatar large">{patient.initials}</span><p className="eyebrow">Synthetic patient</p><h1>{patient.name}</h1><p className="unfinished-meta">{patient.age} years · {patient.location}</p><div className="unfinished-reason"><span>Reason for consult</span><strong>{patient.reason}</strong></div><NetworkMark /><h2>This demo case is not implemented yet.</h2><p>Choose Jordan Lee or Maria Santos for a grounded physician-agent consultation. No recommendation has been fabricated for this patient.</p><button className="button-secondary" onClick={() => navigate(`/patients/${JORDAN_ID}`)}>Open Jordan Lee demo</button></div></main></ProductShell>
}

const physicianInitials = (name: string) => name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
const evidenceFor = (evaluation: Evaluation, kind: string) => evaluation.evidence.find((item) => item.kind === kind)?.detail
const cleanName = (name: string) => name.replace(' (synthetic)', '')
const insuranceLabel = (status: string) => status.startsWith('In network') ? 'In-network' : 'Network unknown'
const messageSender = (message: ConsultationMessage) => message.sender_agent_id === PCP_AGENT_ID ? `${PCP_NAME} Agent` : message.sender_name

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
    <header className="consult-experience-heading"><div><p className="eyebrow">{PCP_AGENT_NAME} · network consultation</p><h2>{resolved ? 'Recommendation ready' : current ? stages.at(-1)?.title : 'Preparing patient context'}</h2><p>{resolved ? 'A specialist has emerged from the structured agent consultation below.' : result ? 'Replaying this consultation’s recorded events in sequence.' : 'Requesting a structured consult from the physician network…'}</p></div><span className="consult-progress">{result ? `${visibleCount} / ${messages.length} recorded events` : 'Awaiting response'}</span></header>
    <div className="consult-stage-rail">{stages.map((stage) => <span key={stage.id} className={current && stage.messages.some((item) => item.id === current.id) && !resolved ? 'current' : 'complete'}>{stage.title}<small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></span>)}{!stages.length && <span className="current">Preparing case</span>}</div>
    <div className="consult-network-stage"><svg viewBox="0 0 1000 450" preserveAspectRatio="none" aria-hidden="true">{agents.map((agent, index) => { const [x, y] = nodePositions[index]; const participating = visible.some((item) => item.sender_name.includes(cleanName(agent.physician_name))); return <line key={agent.physician_id} x1="500" y1="220" x2={x} y2={y} className={`${participating ? 'participating' : ''} ${activeAgent?.physician_id === agent.physician_id && !resolved ? 'current' : ''} ${resolved && result?.recommended_physician.physician_id === agent.physician_id ? 'chosen' : ''}`} /> })}</svg>
      <div className="consult-network-center"><NetworkMark active={consulting} resolved={resolved} /><span>YOUR AGENT · ACTIVE</span><strong>{PCP_AGENT_NAME}</strong><small>Patient context → physician network</small></div>
      {agents.map((agent, index) => { const name = cleanName(agent.physician_name); const events = visible.filter((item) => item.sender_name.includes(name)); const latest = events.at(-1); const profile = networkAgents.find((node) => node.physician_id === agent.physician_id); const status = profile?.status === 'active' ? 'Active demo profile' : profile?.status === 'verified' ? 'Verified demo profile' : profile?.status === 'verification_pending' ? 'Claimed demo profile' : profile?.status === 'reserved' ? 'Reserved demo profile' : 'Synthetic representative'; const conclusion = !latest ? 'Reviewing case…' : latest.message_type === 'redirect' ? 'Redirects · not first fit' : latest.message_type === 'follow_up_question' ? 'Clarification requested' : latest.message_type === 'follow_up_answer' ? 'Referral sequence clarified' : latest.message_type === 'referral_requirement' ? 'Accepts · workup specified' : agent.clinical_fit === 'strong' ? 'Strong fit' : 'Appropriate alternative'; return <div className={`consult-peer consult-peer-${index + 1} ${latest ? 'responded' : ''} ${resolved && agent.physician_id === result?.recommended_physician.physician_id ? 'chosen' : ''} ${activeAgent?.physician_id === agent.physician_id && !resolved ? 'current' : ''}`} key={agent.physician_id}><NetworkMark /><div><strong>{name}'s Agent</strong><small>{agent.specialty} · {status}</small></div><em>{conclusion}</em>{latest && <p>{latest.summary}</p>}</div> })}
    </div>
    {current && !resolved && <div className={`consult-current-event ${current.message_type}`}><span>{current.sequence.toString().padStart(2, '0')}</span><div><strong>{messageSender(current)} <b>→</b> {current.recipient_agent_id === 'network' ? 'Physician network' : current.recipient_agent_id === PCP_AGENT_ID ? PCP_AGENT_NAME : agents.find((item) => networkAgents.find((node) => node.physician_id === item.physician_id)?.id === current.recipient_agent_id)?.physician_name.replace(' (synthetic)', '') || 'specialist agent'}</strong><p>{current.summary}</p></div><em>{messageLabel(current)}</em></div>}
    {clarification.length > 0 && <div className="consult-clarification"><span>Agent-to-agent clarification</span><div>{clarification.map((item) => <p key={item.id}><b>{messageSender(item)}</b><span>{item.summary}</span></p>)}</div></div>}
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
  return <div className="consult-record-stages"><header><strong>Structured consultation record</strong><small>{messages.length} backend events · original sequence preserved</small></header>{stages.map((stage) => <section className={`consult-record-stage ${stage.kind}`} key={stage.id}><div className="consult-record-stage-heading"><span>{stage.title}</span><small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></div><div className="consult-record-events">{stage.messages.map((message) => <details className="consult-record-event" key={message.id}><summary><span>{message.sequence.toString().padStart(2, '0')}</span><div><strong>{messageSender(message)}</strong><small>{message.summary}</small></div><em>{messageLabel(message)}</em></summary><div className="consult-record-evidence"><p>{message.sender_role} → {message.recipient_agent_id === PCP_AGENT_ID ? PCP_AGENT_NAME : message.recipient_agent_id === 'network' ? 'Physician network' : 'Specialist agent'}</p>{message.related_patient_facts.map((fact) => <p key={fact}><b>Patient fact</b>{fact}</p>)}{message.evidence.map((item, index) => <p key={`${index}-${item.kind}`}><b>{item.kind.replaceAll('_', ' ')}</b>{item.detail}</p>)}{!message.evidence.length && !message.related_patient_facts.length && <p>No additional structured evidence on this event.</p>}</div></details>)}</div></section>)}</div>
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
  const latestLab = (test: Patient['labs'][number]['test']) => patient?.labs.filter((item) => item.test === test).at(-1)
  const runConsult = async () => { setConsulting(true); setConsultation(null); setVisibleMessageCount(0); setError(null); try { const result = await consultNetwork(patientId, context); setConsultation(result); for (let index = 1; index <= result.messages.length; index += 1) { await new Promise((resolve) => setTimeout(resolve, 250)); setVisibleMessageCount(index) } } catch (consultError) { setError(consultError instanceof Error ? consultError.message : 'Consultation failed') } finally { setConsulting(false) } }
  if (loading) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded"><div className="loading-line" /><p>Opening patient workspace…</p></div></ProductShell>
  if (!patient) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded error"><p>{error || 'Patient unavailable'}</p></div></ProductShell>
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell referral-brief"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button>
    <header className="brief-identity"><div><p className="eyebrow">Specialty care referral brief</p><h1>{demoPatient?.name ?? cleanName(patient.display_name)}</h1><p>{patient.age} years · {patient.location}</p></div><div className="patient-monogram">{demoPatient?.initials}</div></header>
    <p className="brief-synthesis">{anemiaCase ? 'Hemoglobin has declined from 10.8 to 9.5 g/dL despite oral iron therapy, with no GI source evaluation documented.' : 'Progressive renal decline is occurring despite treatment for resistant hypertension.'}</p>
    <div className="decision-signals">{anemiaCase ? <><span><b>Hgb ↓</b>10.8 → 9.5 g/dL</span><span><b>Ferritin</b>{latestLab('ferritin')?.value} · low</span><span><b>Iron saturation</b>{latestLab('transferrin_saturation')?.value}% · low</span><span><b>Prior GI workup</b>None documented</span></> : <><span><b>Creatinine ↑</b>1.1 → 1.8 mg/dL</span><span><b>eGFR ↓</b>68 → 41</span><span><b>Clinical signal</b>Resistant hypertension</span><span><b>Trajectory</b>CKD progression</span></>}</div>
    <section className="clinical-question"><p className="eyebrow">Clinical question</p><h2>{anemiaCase ? 'Which specialty should evaluate first, and what should happen before referral?' : 'Which specialty should manage this first, and what workup is needed?'}</h2><p>{PCP_AGENT_NAME} will take this brief to relevant physician representatives and synthesize the appropriate next step.</p></section>
    {error && <div className="error-banner" role="alert"><strong>Unable to complete this action.</strong> {error}</div>}
    <section className="network-action brief-action"><div className="network-copy"><NetworkMark active={consulting} resolved={Boolean(consultation)} /><div><p className="eyebrow">{PCP_AGENT_NAME}</p><h2>Ready to consult the network.</h2></div></div><div className="network-controls"><label><span>Is there anything your agent should know? <em>Optional</em></span><input value={context} onChange={(event) => setContext(event.target.value)} maxLength={500} placeholder={anemiaCase ? 'e.g. Patient strongly prefers telehealth' : 'e.g. Considering nephrology vs cardiology'} /></label><button className="consult-button" disabled={consulting} onClick={runConsult}><span>{consulting ? 'Consulting…' : 'Consult the network'}</span><span>→</span></button></div></section>
    {(consulting || consultation) && <ConsultationNetwork result={consultation} visibleCount={visibleMessageCount} consulting={consulting} networkAgents={networkAgents} />}{consultation && !consulting && <RecommendationView consultation={consultation} />}
    <details className="source-record"><summary>View full clinical record <span>Diagnoses, medications, labs, access details and provenance</span></summary><div className="source-record-grid"><section><h3>Active diagnoses</h3><ul>{patient.diagnoses.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h3>Medications</h3><ul>{patient.medications.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h3>Access context</h3><p><b>Referring clinician</b>{PCP_NAME} · Primary Care</p><p><b>Insurance</b>{patient.insurance}</p><p><b>Clinical source</b>{patient.clinical_data_source === 'medplum_fhir' ? 'Synthetic FHIR via Medplum' : 'Local synthetic fixture'}</p></section><section className="source-labs"><h3>Lab history</h3><div>{patient.labs.map((lab) => <span key={`${lab.test}-${lab.date}`}><b>{lab.test}</b>{lab.value} {lab.unit}<small>{new Date(`${lab.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</small></span>)}</div></section>{patient.clinical_notes.length > 0 && <section className="source-notes"><h3>Clinical notes</h3><ul>{patient.clinical_notes.map((note) => <li key={note}>{note}</li>)}</ul></section>}</div></details>
  </main></ProductShell>
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, [])
  const navigate = (next: string) => { window.history.pushState({}, '', next); setPath(new URL(next, window.location.origin).pathname); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  if (path === '/') return <LandingPage navigate={navigate} />
  if (path === '/home') return <HomePage navigate={navigate} />
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
