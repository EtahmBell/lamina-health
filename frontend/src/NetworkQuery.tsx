/** Active physician-agent network pass (Part H-N): "Ask the Network" --
 * makes the network visibly behave like a computational, agent-queryable
 * network rather than primarily a directory/feed. Lives in the Colleagues
 * tab's right rail; results reuse the existing Ask Their Agent drawer and
 * Feed navigation rather than inventing parallel surfaces. */

import { useState } from 'react'
import {
  askNetwork,
  type AskNetworkResult,
  type NetworkPhysicianAgentMatch,
} from './api.ts'
import { DEMO_PATIENTS } from './demoPatients.ts'
import { NetworkAskAgentModal, networkProfilePath } from './Engagement.tsx'

type Navigate = (path: string) => void

/** Mirrors backend.engagement.PERSONA_BY_PHYSICIAN_ID for the subset of
 * physicians reachable from Lucy's network -- the persona id is what the
 * real Ask Their Agent endpoint/drawer needs, never the raw physician_id. */
const PERSONA_BY_PHYSICIAN_ID: Record<string, string> = {
  'physician-jung': 'iain', 'physician-chen': 'chen', 'physician-onadeko': 'onadeko',
  'physician-alvarez': 'sofia', 'physician-sanchez': 'tiffany', 'physician-cha': 'lianne',
  'physician-park': 'nina', 'physician-ramanathan': 'maya', 'physician-rosen': 'natalie',
  'physician-mithel': 'chris', 'physician-rahman': 'amina', 'physician-guechtouli': 'hamidou',
  'physician-islam': 'islam', 'physician-nakajima': 'nakajima',
}

const ASKABLE_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.implemented && !patient.owner)

/** One physician-agent match (My Agent cleanup pass, Part J/M): WHY THIS
 * MATCH as labeled, evidence-backed reasons -- never a bullet wall, never a
 * numeric value. A directly relevant post from this physician may ground
 * the result; unrelated network posts are never listed. Ask agent only
 * renders when a real Lamina agent persona exists for the physician. */
function PhysicianAgentResultCard({ match, navigate, onAskAgent, onViewInFeed }: {
  match: NetworkPhysicianAgentMatch; navigate: Navigate; onAskAgent: (match: NetworkPhysicianAgentMatch) => void
  onViewInFeed: (postId: string) => void
}) {
  const personaId = PERSONA_BY_PHYSICIAN_ID[match.physician_id]
  const reasons = match.match_reasons ?? match.reasons.map((reason) => {
    const [label, ...rest] = reason.split(': ')
    return { kind: 'specialty' as const, label: rest.length ? label : 'Match', detail: rest.length ? rest.join(': ') : reason }
  })
  return <div className="ask-network-agent-card">
    <div className="ask-network-agent-head">
      <div>
        <strong className="ask-network-agent-name">{match.physician_name}'s Agent</strong>
        <small className="ask-network-agent-specialty">{match.specialty}</small>
      </div>
      {match.strength && <span className={`ask-network-strength ${match.strength}`}>{match.strength === 'strong' ? 'Strong match' : 'Relevant match'}</span>}
    </div>
    {reasons.length > 0 && <>
      <p className="section-label ask-network-why">Why this match</p>
      <ul className="ask-network-reason-list">{reasons.map((reason) => <li key={`${reason.kind}-${reason.label}`} className={reason.kind === 'before_referral' ? 'supporting' : undefined}>
        <span className="ask-network-reason-label">{reason.label}</span>
        <span className="ask-network-reason-detail">{reason.detail}</span>
      </li>)}</ul>
    </>}
    {(match.grounded_in ?? []).map((post) => <p className="ask-network-grounding" key={post.post_id}>
      <span>Grounded in “{post.title}”</span>
      <button type="button" className="text-button" onClick={() => onViewInFeed(post.post_id)}>View source in Feed →</button>
    </p>)}
    <div className="ask-network-card-actions">
      {personaId && <button type="button" className="text-button" onClick={() => onAskAgent(match)}>Ask agent →</button>}
      {personaId && <button type="button" className="text-button" onClick={() => navigate(networkProfilePath('lucy', personaId))}>View profile →</button>}
    </div>
  </div>
}

export function AskNetworkCard({ navigate, onViewInFeed }: { navigate: Navigate; onViewInFeed: (postId: string) => void }) {
  const [question, setQuestion] = useState('')
  const [patientId, setPatientId] = useState('')
  const [result, setResult] = useState<AskNetworkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [drawerMatch, setDrawerMatch] = useState<NetworkPhysicianAgentMatch | null>(null)

  const ask = async () => {
    const trimmed = question.trim()
    if (!trimmed || busy) return
    setBusy(true); setError('')
    try {
      setResult(await askNetwork(trimmed, patientId || undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the network.')
    } finally {
      setBusy(false)
    }
  }

  const groundedIn = (match: NetworkPhysicianAgentMatch) => [
    ...match.confirmed_good_fit.map((item) => `Confirmed referral preference: ${item}`),
    ...match.confirmed_case_interests.map((item) => `Confirmed case interest: ${item}`),
    ...(match.modality_preference ? [`Confirmed modality preference: ${match.modality_preference}`] : []),
    ...(match.grounded_in ?? []).map((post) => `Network post (attributed context): ${post.title}`),
  ]

  return <section className="ask-network-card">
    <h3>Ask the network</h3>
    <p className="muted-note">Ask physician agents in your network.</p>
    <label htmlFor="ask-network-question" className="sr-only">Ask a question</label>
    <textarea id="ask-network-question" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question…" />
    <div className="ask-network-patient-context">
      <span>Patient context</span>
      <select value={patientId} onChange={(event) => setPatientId(event.target.value)}>
        <option value="">None</option>
        {ASKABLE_PATIENTS.map((patient) => <option key={patient.id} value={patient.id}>{patient.name}</option>)}
      </select>
    </div>
    {patientId && <p className="ask-network-patient-note">Only information relevant to this question is used to consult physician agents.</p>}
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    <button type="button" className="button-primary" disabled={busy || !question.trim()} onClick={() => void ask()}>{busy ? 'Asking…' : 'Ask network'} <span>→</span></button>

    {result && <div className="ask-network-results">
      <div className="ask-network-result-group">
        <h4>Physician agents</h4>
        {result.physician_agents.length === 0
          ? <p className="ask-network-empty">No confirmed physician representation matched that question yet.</p>
          : result.physician_agents.map((match) => <PhysicianAgentResultCard key={match.physician_id} match={match} navigate={navigate} onAskAgent={setDrawerMatch} onViewInFeed={onViewInFeed} />)}
      </div>
    </div>}

    {drawerMatch && (() => {
      const personaId = PERSONA_BY_PHYSICIAN_ID[drawerMatch.physician_id]
      return personaId ? <NetworkAskAgentModal
        controlledId={personaId}
        physicianName={drawerMatch.physician_name}
        groundedIn={groundedIn(drawerMatch)}
        onClose={() => setDrawerMatch(null)}
      /> : null
    })()}
  </section>
}

export function ActiveNetworkRail({ navigate, onViewInFeed }: { navigate: Navigate; onViewInFeed: (postId: string) => void }) {
  return <aside className="active-network-rail">
    <AskNetworkCard navigate={navigate} onViewInFeed={onViewInFeed} />
  </aside>
}
