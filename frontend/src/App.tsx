import { useEffect, useMemo, useState } from 'react'
import { consultNetwork, getPatient, type Consultation, type Patient } from './api'

const PATIENT_ID = 'patient-ckd-htn-001'
const label = (kind: string) => kind.replaceAll('_', ' ')

export default function App() {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPatient(PATIENT_ID).then(setPatient).catch((e: Error) => setError(e.message)).finally(() => setLoading(false))
  }, [])

  const labs = useMemo(() => {
    if (!patient) return []
    const creatinine = patient.labs.filter((x) => x.test === 'creatinine')
    const egfr = patient.labs.filter((x) => x.test === 'eGFR')
    return creatinine.map((item, index) => ({ date: item.date, creatinine: item.value, egfr: egfr[index]?.value }))
  }, [patient])

  const runConsult = async () => {
    setConsulting(true); setError(null); setReferralStarted(false)
    try { setConsultation(await consultNetwork(PATIENT_ID)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Consultation failed') }
    finally { setConsulting(false) }
  }

  if (loading) return <main className="center">Loading synthetic patient…</main>
  if (!patient) return <main className="center error">{error || 'Patient unavailable'}</main>

  return <div className="app">
    <header className="topbar"><div className="brand"><span className="mark">L</span><span>Lamina</span></div><span className="mode">Synthetic demo · no PHI</span></header>
    <main>
      <section className="patient-hero">
        <div><p className="eyebrow">Patient overview</p><h1>{patient.display_name}</h1><p className="subtitle">{patient.age} years · {patient.location} · {patient.insurance}</p></div>
        <button className="consult-button" disabled={consulting} onClick={runConsult}>{consulting ? 'Consulting network…' : 'Consult Network'}<span>→</span></button>
      </section>
      {error && <div className="error banner">{error}</div>}
      <div className="clinical-grid">
        <section className="card"><p className="eyebrow">Active diagnoses</p>{patient.diagnoses.map((item) => <div className="diagnosis" key={item}>{item}</div>)}</section>
        <section className="card"><p className="eyebrow">Current medications</p>{patient.medications.map((item) => <div className="med" key={item}><span className="dot" />{item}</div>)}</section>
        <section className="card labs"><div className="card-heading"><p className="eyebrow">Renal trajectory</p><span className="trend">Declining</span></div><div className="lab-head"><span>Date</span><span>Creatinine</span><span>eGFR</span></div>{labs.map((row) => <div className="lab-row" key={row.date}><span>{row.date}</span><strong>{row.creatinine} <small>mg/dL</small></strong><strong>{row.egfr} <small>mL/min</small></strong></div>)}</section>
      </div>
      {consulting && <section className="consulting"><div className="pulse" /><div><h2>Consulting relevant physician agents</h2><p>Comparing nephrology, hypertension cardiology, general cardiology, electrophysiology, and endocrinology.</p></div></section>}
      {consultation && !consulting && <section className="result">
        <div className="result-header"><div><p className="eyebrow green">Network recommendation</p><h2>{consultation.recommended_physician.physician_name}</h2><p className="specialty">{consultation.recommended_physician.specialty}</p></div><span className="fit">Strong fit</span></div>
        <div className="why"><h3>Why this physician</h3><p>{consultation.why}</p></div>
        <div className="result-grid"><div><h3>Before referral</h3><ul>{consultation.before_referral.map((x) => <li key={x}>{x}</li>)}</ul></div><div><h3>Access</h3><p><b>{consultation.availability}</b></p><p>{consultation.insurance}</p></div><div><h3>Alternative</h3><p><b>{consultation.alternatives[0].physician_name}</b></p><p>{consultation.alternatives[0].specialty} · {consultation.alternatives[0].availability}</p></div></div>
        <div className="actions"><button className="secondary" onClick={() => setDetailOpen(!detailOpen)}>{detailOpen ? 'Hide Consultation' : 'View Consultation'}</button><button onClick={() => setReferralStarted(true)}>Start Referral</button>{referralStarted && <span className="demo-note">Demo referral prepared — no external action taken.</span>}</div>
        {detailOpen && <div className="consultation-detail"><h3>Structured consultation record</h3><p className="muted">Inspectable evidence only; no hidden model reasoning is shown.</p>{consultation.consultation.map((agent) => <details key={agent.physician_id} open={agent.clinical_fit === 'strong'}><summary><span><b>{agent.physician_name}</b><small>{agent.specialty}</small></span><span className={`pill ${agent.clinical_fit}`}>{agent.clinical_fit} fit</span></summary><p>{agent.reason}</p><dl><dt>Accepts case</dt><dd>{agent.accepts_case ? 'Yes' : 'No'}</dd><dt>Availability</dt><dd>{agent.availability}</dd><dt>Required workup</dt><dd>{agent.required_workup.join(' · ')}</dd></dl><div className="evidence">{agent.evidence.map((e, i) => <div key={`${e.kind}-${i}`}><span>{label(e.kind)}</span><p>{e.detail}</p></div>)}</div></details>)}</div>}
        <p className="disclaimer">{consultation.disclaimer}</p>
      </section>}
    </main>
  </div>
}

