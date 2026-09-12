import { useEffect, useMemo, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { consultNetwork, getPatient, type Consultation, type Patient } from './api'

const PATIENT_ID = 'patient-ckd-htn-001'
const CONSULTED_SPECIALTIES = [
  'Nephrology',
  'Hypertension Cardiology',
  'General Cardiology',
  'Electrophysiology',
  'Endocrinology',
]

const evidenceLabel = (kind: string) => kind.replaceAll('_', ' ')
const physicianInitials = (name: string) =>
  name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')

function Brand() {
  return <div className="brand" aria-label="Lamina">
    <span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span>
    <span className="wordmark">LAMINA</span>
  </div>
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return <svg className={`trend-icon ${direction}`} viewBox="0 0 20 20" aria-hidden="true">
    <path d={direction === 'up' ? 'M4 14 10 8l3 3 3-5M12 6h4v4' : 'M4 6l6 6 3-3 3 5M12 14h4v-4'} />
  </svg>
}

export default function App() {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPatient(PATIENT_ID)
      .then(setPatient)
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false))
  }, [])

  const labs = useMemo(() => {
    if (!patient) return []
    const creatinine = patient.labs.filter((item) => item.test === 'creatinine')
    const egfr = patient.labs.filter((item) => item.test === 'eGFR')
    return creatinine.map((item, index) => ({ date: item.date, creatinine: item.value, egfr: egfr[index]?.value }))
  }, [patient])

  const chartPoints = useMemo(() => {
    const x = (index: number) => labs.length > 1 ? 8 + (index / (labs.length - 1)) * 84 : 50
    const range = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) })
    if (!labs.length) return { creatinine: '', egfr: '' }
    const creatinineRange = range(labs.map((item) => item.creatinine))
    const egfrRange = range(labs.map((item) => item.egfr))
    const y = (value: number, min: number, max: number) => max === min ? 50 : 82 - ((value - min) / (max - min)) * 64
    return {
      creatinine: labs.map((item, index) => `${x(index)},${y(item.creatinine, creatinineRange.min, creatinineRange.max)}`).join(' '),
      egfr: labs.map((item, index) => `${x(index)},${y(item.egfr, egfrRange.min, egfrRange.max)}`).join(' '),
    }
  }, [labs])

  const runConsult = async () => {
    setConsulting(true)
    setError(null)
    setReferralStarted(false)
    setDetailOpen(false)
    try {
      setConsultation(await consultNetwork(PATIENT_ID))
    } catch (consultError) {
      setError(consultError instanceof Error ? consultError.message : 'Consultation failed')
    } finally {
      setConsulting(false)
    }
  }

  if (loading) return <div className="page-state"><Brand /><div className="loading-line" /><p>Opening specialty care consult…</p></div>
  if (!patient) return <div className="page-state error"><Brand /><p>{error || 'Patient unavailable'}</p></div>

  const patientName = patient.display_name.replace(/\s*\(synthetic\)$/i, '')

  return <div className="app-shell">
    <aside className="sidebar">
      <div>
        <Brand />
        <p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          <button className="nav-item active" aria-current="page"><span className="nav-icon">✦</span><span><b>Specialty consult</b><small>Patient workspace</small></span></button>
          <button className="nav-item" disabled><span className="nav-icon">◫</span><span><b>Consultations</b><small>Coming next</small></span></button>
          <button className="nav-item" disabled><span className="nav-icon">⌁</span><span><b>Physician network</b><small>Practice footprints</small></span></button>
        </nav>
      </div>
      <div className="sidebar-clinician"><div className="clinician-avatar">LC</div><div><span>Referring clinician</span><strong>Dr. Cha</strong><small>Primary Care</small></div></div>
    </aside>

    <div className="workspace">
      <header className="workspace-bar">
        <div><span>Clinical workspace</span><b>/</b><strong>Specialty Care Consult</strong></div>
        <div className="synthetic-status"><span />Synthetic demo · no PHI</div>
      </header>

      <main className="page-shell">
        <header className="consult-header">
          <div className="consult-heading"><p className="eyebrow">Specialty Care Consult</p><h1>{patientName}</h1><div className="patient-demographics"><span><b>Age</b>{patient.age} years</span><span><b>Location</b>{patient.location}</span></div></div>
          <div className="patient-monogram" aria-hidden="true">JL</div>
        </header>

        <section className="referral-context" aria-label="Referral context">
          <div><span>Referring clinician</span><strong>Dr. Cha</strong><small>Primary Care</small></div>
          <div><span>Insurance</span><strong>{patient.insurance}</strong><small>Coverage on file</small></div>
          <div className="consult-reason"><span>Reason for consult</span><strong>Resistant hypertension with progressive renal dysfunction</strong></div>
        </section>

        {error && <div className="error-banner" role="alert"><strong>Unable to complete this action.</strong> {error}</div>}

        <section className="network-action">
          <div className="network-copy"><div className="network-mark" aria-hidden="true"><span /><span /><span /><span /></div><div><p className="eyebrow">Physician agent network</p><h2>Find the appropriate next step in specialty care.</h2><p>Compare best-fit specialists, required workup, and fastest appropriate access.</p></div></div>
          <button className="consult-button" disabled={consulting} onClick={runConsult}><span>{consulting ? 'Consulting Network…' : 'Consult Network'}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></button>
        </section>

        <div className="clinical-grid">
          <section className="clinical-card"><div className="card-title"><span className="card-icon">+</span><div><p>Clinical context</p><h2>Active diagnoses</h2></div><b>{patient.diagnoses.length}</b></div><ul className="clinical-list">{patient.diagnoses.map((item) => <li key={item}><span />{item}</li>)}</ul></section>
          <section className="clinical-card"><div className="card-title"><span className="card-icon medication">Rx</span><div><p>Current therapy</p><h2>Medications</h2></div><b>{patient.medications.length}</b></div><ul className="clinical-list medications">{patient.medications.map((item) => <li key={item}><span />{item}</li>)}</ul></section>
          <section className="clinical-card renal-card">
            <div className="card-title"><span className="card-icon chart">↗</span><div><p>Longitudinal labs</p><h2>Renal trajectory</h2></div><span className="status-label warning">Progressive decline</span></div>
            <div className="trajectory-summary"><div><span>Creatinine</span><strong>1.1 → 1.8 <small>mg/dL</small></strong><em><ArrowIcon direction="up" />Increasing</em></div><div><span>eGFR</span><strong>68 → 41 <small>mL/min</small></strong><em><ArrowIcon direction="down" />Decreasing</em></div></div>
            <div className="trajectory-visual" aria-label="Creatinine rises while eGFR falls across four observations"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"><title>Renal lab trends</title><line x1="8" y1="18" x2="92" y2="18" /><line x1="8" y1="50" x2="92" y2="50" /><line x1="8" y1="82" x2="92" y2="82" /><polyline className="creatinine-line" points={chartPoints.creatinine} /><polyline className="egfr-line" points={chartPoints.egfr} /></svg><div className="chart-legend"><span className="creatinine">Creatinine</span><span className="egfr">eGFR</span></div><div className="chart-dates">{labs.map((item) => <span key={item.date}>{new Date(`${item.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>)}</div></div>
          </section>
        </div>

        {consulting && <section className="consulting-panel" role="status" aria-live="polite"><div className="consulting-head"><div className="network-spinner"><span /><span /><span /></div><div><p className="eyebrow">Consult Network</p><h2>Consulting the network…</h2><p>Reviewing fit against the supplied patient facts and physician practice rules.</p></div></div><div className="specialty-progress">{CONSULTED_SPECIALTIES.map((specialty, index) => <div key={specialty}><span style={{ animationDelay: `${index * 100}ms` }} />{specialty}<small>Reviewing</small></div>)}</div></section>}

        {consultation && !consulting && <section className="recommendation">
          <div className="recommendation-kicker"><span>Network recommendation</span><small>Grounded in supplied synthetic data</small></div>
          <div className="recommendation-primary"><div className="physician-avatar">{physicianInitials(consultation.recommended_physician.physician_name)}</div><div><p>Recommended physician</p><h2>{consultation.recommended_physician.physician_name}</h2><span>{consultation.recommended_physician.specialty}</span></div><span className="status-label success">Strong fit</span></div>
          <div className="recommendation-why"><span>Why</span><p>{consultation.why}</p></div>
          <div className="recommendation-grid">
            <section><p className="section-label">Required workup</p><ul>{consultation.before_referral.map((item) => <li key={item}><span>✓</span>{item}</li>)}</ul></section>
            <section><p className="section-label">Access</p><strong>{consultation.availability}</strong><small>Approximate next availability</small></section>
            <section><p className="section-label">Insurance</p><strong>{consultation.insurance.split(' (')[0]}</strong><small>Synthetic network information</small></section>
            <section className="alternative"><p className="section-label">Alternative</p><strong>{consultation.alternatives[0].physician_name}</strong><span>{consultation.alternatives[0].specialty}</span><small>{consultation.alternatives[0].availability}</small></section>
          </div>
          <div className="recommendation-actions"><button className="button-secondary" onClick={() => setDetailOpen(!detailOpen)}>{detailOpen ? 'Hide Consultation' : 'View Consultation'}</button><button className="button-primary" onClick={() => setReferralStarted(true)}>Start Referral <span>→</span></button>{referralStarted && <span className="demo-note">Demo referral prepared — no external action taken.</span>}</div>
          {detailOpen && <div className="consultation-detail"><div className="detail-heading"><div><p className="eyebrow">Consultation record</p><h3>Physician agent evaluations</h3></div><p>Structured evidence only. Hidden model reasoning is not shown.</p></div>{consultation.consultation.map((agent) => <details key={agent.physician_id} open={agent.clinical_fit === 'strong'}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{agent.physician_name}</b><small>{agent.specialty}</small></span><span className={`fit-label ${agent.clinical_fit}`}>{agent.clinical_fit} fit</span><span className="chevron">⌄</span></summary><div className="agent-body"><p className="agent-reason">{agent.reason}</p><dl><dt>Accepts case</dt><dd>{agent.accepts_case ? 'Yes' : 'No'}</dd><dt>Availability</dt><dd>{agent.availability}</dd><dt>Required workup</dt><dd>{agent.required_workup.join(' · ')}</dd></dl><div className="evidence">{agent.evidence.map((item, index) => <div key={`${item.kind}-${index}`}><span>{evidenceLabel(item.kind)}</span><p>{item.detail}</p></div>)}</div></div></details>)}</div>}
          <p className="disclaimer">{consultation.disclaimer}</p>
        </section>}
      </main>
    </div>
  </div>
}
