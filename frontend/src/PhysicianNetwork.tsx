import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { LaminaMark } from './LaminaMark'
import {
  activateProvider,
  claimProvider,
  getAgentNetwork,
  getProvider,
  saveProviderPreferences,
  searchProviders,
  verifyDemoProvider,
  type AgentPreferences,
  type AgentNetwork,
  type AgentStatus,
  type NetworkAgent,
  type PhysicianNetworkProfile,
  type ProviderSearchResponse,
} from './api'

type Navigate = (path: string) => void

const statusCopy: Record<AgentStatus, { label: string; detail: string }> = {
  reserved: { label: 'Reserved · not yet activated', detail: 'A Lamina agent identity is held for this directory profile.' },
  verification_pending: { label: 'Claimed · verification pending', detail: 'A profile claim has started. Identity verification is not complete.' },
  verified: { label: 'Verified · configuration needed', detail: 'Identity is verified; practice details and preferences can now be configured.' },
  active: { label: 'Verified · Active', detail: 'This physician’s configured agent is active.' },
  disabled: { label: 'Disabled', detail: 'This agent identity is not currently active.' },
}

const titleCaseName = (value: string) => value === value.toUpperCase()
  ? value.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase())
  : value

function NetworkGlyph({ active = false }: { active?: boolean }) {
  return <LaminaMark directory active={active} />
}

function StatusBadge({ status }: { status: AgentStatus }) {
  return <span className={`agent-status-badge ${status}`}><i />{statusCopy[status].label}</span>
}

function PhysicianCard({ profile, navigate }: { profile: PhysicianNetworkProfile; navigate: Navigate }) {
  const name = titleCaseName(profile.display_name).replace(/, Md\b/i, ', MD').replace(/, Do\b/i, ', DO')
  return <button className="directory-physician-card" onClick={() => navigate(`/network/${profile.npi}`)}>
    <span className="directory-avatar">{name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')}</span>
    <span className="directory-card-copy"><span className="directory-source">{profile.source === 'NPPES' ? 'NPPES identity' : 'Synthetic demo identity'}</span><strong>{name}</strong><span>{profile.specialty}</span><small>{profile.city || 'Location not listed'}{profile.state ? `, ${profile.state}` : ''}</small></span>
    <span className="directory-card-agent"><small>Lamina Agent</small><StatusBadge status={profile.agent.status} /></span>
    <span className="directory-view-profile">View profile →</span>
  </button>
}

const graphRoster = ['physician-jung', 'physician-onadeko', 'physician-alvarez', 'physician-patel', 'physician-brooks', 'physician-rossi']
const graphSlots = [
  { x: 20, y: 23 }, { x: 80, y: 23 }, { x: 50, y: 12 },
  { x: 20, y: 77 }, { x: 80, y: 77 }, { x: 50, y: 88 },
]
const shortName = (name: string) => name.replace(/^Dr\.\s*/, '')
const interactionDate = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function relationshipLabel(agent: NetworkAgent) {
  const count = agent.relationship?.consultation_count || 0
  if (!count) return 'No recorded consult yet'
  return `${count} recorded consultation${count === 1 ? '' : 's'}`
}

function NetworkGraph({ network, selectedId, onSelect }: { network: AgentNetwork; selectedId: string | null; onSelect: (id: string) => void }) {
  const roster = graphRoster.map((id) => network.nodes.find((node) => node.physician_id === id)).filter((node): node is NetworkAgent => Boolean(node))
  return <div className="agent-network-stage"><div className="agent-network-caption"><span className="legend-recommended"><i /> Recommended</span><span className="legend-consulted"><i /> Consulted</span><span className="legend-redirected"><i /> Redirected</span><span className="legend-roster"><i /> Roster only · no edge</span></div><div className="agent-network-canvas">
    <svg className="agent-network-edges" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">{roster.map((agent, index) => agent.relationship && <line key={agent.id} x1="500" y1="280" x2={graphSlots[index].x * 10} y2={graphSlots[index].y * 5.6} className={`relationship-edge ${agent.relationship.relationship_type}`} />)}</svg>
    <div className="agent-network-center"><LaminaMark active /><span>Your agent</span><strong>{network.center.name}</strong><small>{network.center.specialty}</small><em>ACTIVE</em></div>
    {roster.map((agent, index) => <button key={agent.id} className={`agent-network-node ${agent.relationship ? 'connected' : 'unconnected'} ${selectedId === agent.id ? 'selected' : ''}`} style={{ '--node-x': `${graphSlots[index].x}%`, '--node-y': `${graphSlots[index].y}%` } as CSSProperties} onClick={() => onSelect(agent.id)} aria-label={`Open ${agent.name}'s agent details`}><span className="agent-node-symbol">{shortName(agent.name).split(/\s+/).map((part) => part[0]).join('')}</span><strong>{agent.name}'s Agent</strong><small>{agent.subspecialty || agent.specialty}</small><em className={`node-status ${agent.status}`}>{agent.status === 'verification_pending' ? 'CLAIMED' : agent.status.toUpperCase()}</em>{agent.relationship && <span className="node-relationship">{relationshipLabel(agent)}</span>}</button>)}
  </div><p className="graph-provenance">Edges reflect completed Lamina demo consultations only. Reserved synthetic profiles can appear in a demo consult without being physician-activated.</p></div>
}

function AgentDetail({ agent, navigate, close }: { agent: NetworkAgent; navigate: Navigate; close: () => void }) {
  const relation = agent.relationship
  return <section className="network-detail-panel" aria-label={`${agent.name} agent details`}><header><div><p className="eyebrow">Physician agent</p><h2>{agent.name}'s Agent</h2><p>{agent.specialty} · {agent.location}</p></div><button className="detail-close" onClick={close} aria-label="Close agent details">×</button></header><StatusBadge status={agent.status} />
    <p className="detail-status-note">{agent.status === 'reserved' ? 'Agent identity reserved. This physician has not activated or authorised a Lamina agent.' : statusCopy[agent.status].detail}</p>
    <div className="network-detail-grid"><div><span>What this agent represents</span><strong>{agent.subspecialty}</strong><p>{agent.focus_areas.slice(0, 3).join(' · ')}</p></div><div><span>Configured referral rule</span><p>{agent.explicit_rules[0] || 'Not specified'}</p></div><div><span>Pre-referral requirements</span><p>{agent.required_workup.join(' · ') || 'Not specified'}</p></div><div><span>Relationship to your agent</span><strong>{relationshipLabel(agent)}</strong><p>{relation ? `${relation.recommended_count} recommendation${relation.recommended_count === 1 ? '' : 's'} · ${relation.redirect_count} redirect${relation.redirect_count === 1 ? '' : 's'}` : 'No completed Lamina consultation connects these agents yet.'}</p></div><div><span>Last interaction</span><strong>{relation ? relation.last_patient_name : 'None recorded'}</strong>{relation && <p>{interactionDate(relation.most_recent_interaction)}</p>}</div><div><span>Provenance</span><p>{agent.provenance}</p>{relation && <small>Relationship: completed Lamina synthetic consultation record</small>}</div></div>
    {agent.confirmed_preferences && <div className="confirmed-agent-preference"><span>Physician-confirmed demo preferences</span><p>{agent.confirmed_preferences.areas_of_focus.join(' · ')}</p></div>}
    <footer><button className="button-primary" onClick={() => navigate(`/network/${agent.npi}`)}>View full physician profile →</button>{relation && <button className="button-secondary" onClick={() => navigate(`/consultations/${relation.last_record_id}`)}>View recent consultation</button>}</footer>
  </section>
}

export function PhysicianDirectoryPage({ navigate }: { navigate: Navigate }) {
  const [filters, setFilters] = useState({ q: '', specialty: '', location: '' })
  const [response, setResponse] = useState<ProviderSearchResponse | null>(null)
  const [network, setNetwork] = useState<AgentNetwork | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault(); setLoading(true); setError(null)
    try { setResponse(await searchProviders(filters)) }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Directory search failed') }
    finally { setLoading(false) }
  }
  useEffect(() => { void runSearch(); getAgentNetwork().then(setNetwork).catch((loadError: Error) => setNetworkError(loadError.message)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedId) document.querySelector('.network-detail-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [selectedId])

  const selected = network?.nodes.find((node) => node.id === selectedId)
  const recent = network?.nodes.filter((node) => node.relationship?.recommended_count).sort((a, b) => (b.relationship?.most_recent_interaction || '').localeCompare(a.relationship?.most_recent_interaction || '')) || []
  const relevant = (recent.length ? recent : network?.nodes.filter((node) => graphRoster.slice(0, 4).includes(node.physician_id)) || []).slice(0, 4)

  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Physician Network</h1><p>See how your agent connects with specialty practices around patient care. Every visible connection comes from a completed Lamina consultation.</p></div><NetworkGlyph active /></header>

    <section className="network-primary-section"><div className="network-section-heading"><div><p className="eyebrow">Your network</p><h2>Care moves through agents.</h2></div><p>Select a physician agent to inspect its practice footprint, activation state, and relationship to yours.</p></div>
      {networkError && <div className="error-banner" role="alert">Network relationships unavailable: {networkError}</div>}
      {!network && !networkError && <div className="directory-loading"><NetworkGlyph active /><p>Mapping recorded agent relationships…</p></div>}
      {network && <><NetworkGraph network={network} selectedId={selectedId} onSelect={setSelectedId} />{selected && <AgentDetail agent={selected} navigate={navigate} close={() => setSelectedId(null)} />}</>}
    </section>

    <section className="network-recent-section"><div className="network-section-heading"><div><p className="eyebrow">Practice connections</p><h2>{recent.length ? 'Recently consulted' : 'Relevant demo agents'}</h2></div><p>{recent.length ? 'From completed consultations in this Lamina workspace.' : 'Configured synthetic practice footprints. No consultation history has been recorded yet.'}</p></div><div className="network-recent-grid">{relevant.map((agent) => <button className="network-recent-card" key={agent.id} onClick={() => setSelectedId(agent.id)}><span className="directory-avatar">{shortName(agent.name).split(/\s+/).map((part) => part[0]).join('')}</span><span><strong>{agent.name}</strong><small>{agent.specialty}</small><em>{agent.relationship ? `${agent.relationship.last_patient_name} · ${relationshipLabel(agent)}` : 'Synthetic demo practice footprint'}</em></span><span className={`node-status ${agent.status}`}>{agent.status === 'verification_pending' ? 'CLAIMED' : agent.status.toUpperCase()}</span></button>)}</div></section>

    <section className="network-search-section"><div className="network-section-heading"><div><p className="eyebrow">Directory utility</p><h2>Search the national physician network</h2></div><p>Find a physician identity by name, specialty, or location.</p></div>
    <form className="directory-search-panel" onSubmit={runSearch}>
      <label className="directory-search-main"><span>Physician name</span><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="e.g. Jane Smith" /></label>
      <label><span>Specialty</span><input value={filters.specialty} onChange={(event) => setFilters({ ...filters, specialty: event.target.value })} placeholder="e.g. Nephrology" /></label>
      <label><span>Location</span><input value={filters.location} onChange={(event) => setFilters({ ...filters, location: event.target.value })} placeholder="City or state" /></label>
      <button className="button-primary" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search physicians'} <span>→</span></button>
    </form>
    <p className="network-search-disclaimer">NPPES directory identity does not imply participation in Lamina. Reserved agents are not physician-authorised. {response?.directory_available && `${response.directory_records.toLocaleString()} directory records available.`}</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="directory-results-heading"><div><p className="eyebrow">Search results</p><h2>{filters.q || filters.specialty || filters.location ? 'Matching physicians' : 'Synthetic demo physicians'}</h2></div><span>{response?.count ?? 0} shown</span></div>
    {loading ? <div className="directory-loading"><NetworkGlyph active /><p>Searching physician identities…</p></div> : <div className="directory-results">{response?.results.map((profile) => <PhysicianCard key={profile.npi} profile={profile} navigate={navigate} />)}{response?.results.length === 0 && <div className="empty-state"><NetworkGlyph /><h2>No physicians found</h2><p>Try fewer terms or search by a city, state, or specialty.</p></div>}</div>}
    </section>
  </main>
}

const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean)
const joinList = (value: string[]) => value.join(', ')

export function PhysicianProfilePage({ npi, navigate }: { npi: string; navigate: Navigate }) {
  const [profile, setProfile] = useState<PhysicianNetworkProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [draft, setDraft] = useState<AgentPreferences>({ areas_of_focus: ['Resistant hypertension', 'Progressive CKD'], cases_accepted: ['Stage 3–4 CKD', 'Resistant hypertension'], cases_redirected: ['Dialysis access surgery'], preferred_pre_referral_workup: ['BMP', 'UPCR'], notes: '' })

  useEffect(() => { getProvider(npi).then((result) => { setProfile(result); setConfirmed(result.agent.practice_confirmed); if (result.agent.preferences) setDraft(result.agent.preferences) }).catch((loadError: Error) => setError(loadError.message)) }, [npi])
  const act = async (action: () => Promise<PhysicianNetworkProfile>) => { setBusy(true); setError(null); try { setProfile(await action()) } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Action failed') } finally { setBusy(false) } }
  if (!profile) return <main className="page-shell physician-profile-page"><button className="text-button back-link" onClick={() => navigate('/network')}>← Physician Network</button>{error ? <div className="error-banner">{error}</div> : <div className="directory-loading"><NetworkGlyph active /><p>Opening physician profile…</p></div>}</main>

  const synthetic = profile.source === 'SYNTHETIC'
  const copy = statusCopy[profile.agent.status]
  const name = titleCaseName(profile.display_name).replace(/, Md\b/i, ', MD').replace(/, Do\b/i, ', DO')
  return <main className="page-shell physician-profile-page">
    <button className="text-button back-link" onClick={() => navigate('/network')}>← Physician Network</button>
    <section className="provider-profile-hero"><div className="profile-identity"><span className="directory-avatar large">{name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')}</span><div><p className="eyebrow">{synthetic ? 'Controlled synthetic physician' : 'NPPES physician profile'}</p><h1>{name}</h1><p>{profile.specialty}</p></div></div><StatusBadge status={profile.agent.status} /></section>
    <div className="profile-facts"><div><span>Practice location</span><strong>{profile.city || 'Not listed'}{profile.state ? `, ${profile.state}` : ''}</strong></div><div><span>Organisation</span><strong>{profile.organization || 'Not listed in directory'}</strong></div><div><span>NPI</span><strong>{profile.npi}</strong></div>{profile.phone && <div><span>Practice phone</span><strong>{profile.phone}</strong></div>}</div>
    <div className={`profile-provenance ${synthetic ? 'synthetic' : ''}`}><strong>{synthetic ? 'Synthetic demo profile' : 'Public directory record'}</strong><p>{profile.directory_disclaimer}</p></div>
    {error && <div className="error-banner" role="alert">{error}</div>}

    <section className="agent-activation-card"><header><div><p className="eyebrow">Lamina Agent</p><h2>{copy.label}</h2><p>{copy.detail}</p></div><NetworkGlyph active={profile.agent.status === 'active'} /></header>
      {profile.agent.status === 'reserved' && <p className="reserved-agent-explanation">{synthetic ? 'This controlled synthetic physician has a reserved agent profile. The demo claim flow lets you verify and configure how it represents its practice.' : 'This public directory identity has a reserved Lamina agent, but the physician has not joined, activated, or authorised it. Production identity verification is not available in this demo.'}</p>}
      <ol className="activation-steps"><li className={profile.agent.status !== 'reserved' ? 'complete' : 'current'}><span>1</span><div><strong>Claim profile</strong><small>Begin an identity claim</small></div></li><li className={['verified', 'active'].includes(profile.agent.status) ? 'complete' : profile.agent.status === 'verification_pending' ? 'current' : ''}><span>2</span><div><strong>Verify identity</strong><small>{synthetic ? 'Synthetic demo verification' : 'Production verification required'}</small></div></li><li className={profile.agent.practice_confirmed ? 'complete' : profile.agent.status === 'verified' ? 'current' : ''}><span>3</span><div><strong>Practice & preferences</strong><small>Physician-controlled settings</small></div></li><li className={profile.agent.status === 'active' ? 'complete' : ''}><span>4</span><div><strong>Activate Agent</strong><small>Enable the configured identity</small></div></li></ol>

      {profile.agent.status === 'reserved' && <button className="button-primary" disabled={busy} onClick={() => void act(() => claimProvider(npi))}>{synthetic ? 'Claim & activate agent' : 'Start profile claim'} <span>→</span></button>}
      {profile.agent.status === 'verification_pending' && synthetic && <div className="demo-verification"><p><strong>Demo verification only.</strong> No credentialing or real identity check is performed.</p><button className="button-primary" disabled={busy} onClick={() => void act(() => verifyDemoProvider(npi))}>Verify synthetic identity <span>→</span></button></div>}
      {profile.agent.status === 'verification_pending' && !synthetic && <div className="production-verification"><strong>Verification request recorded</strong><p>This public NPPES identity remains unverified. Production identity verification is intentionally not implemented in this demo.</p><button className="button-secondary" onClick={() => navigate('/network/9900000001')}>Use synthetic activation demo</button></div>}
      {profile.agent.status === 'verified' && <form className="preferences-form" onSubmit={(event) => { event.preventDefault(); void act(() => saveProviderPreferences(npi, { ...draft, practice_confirmed: confirmed })) }}><h3>Configure physician preferences</h3><p>These structured preferences describe practice fit; they are not automatically applied to national matching.</p><label className="confirm-practice"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>Confirm practice information</strong><small>{profile.organization || profile.city}, {profile.state}</small></span></label><PreferenceField label="Areas of focus" value={joinList(draft.areas_of_focus)} onChange={(value) => setDraft({ ...draft, areas_of_focus: splitList(value) })} /><PreferenceField label="Cases accepted" value={joinList(draft.cases_accepted)} onChange={(value) => setDraft({ ...draft, cases_accepted: splitList(value) })} /><PreferenceField label="Cases redirected" value={joinList(draft.cases_redirected)} onChange={(value) => setDraft({ ...draft, cases_redirected: splitList(value) })} /><PreferenceField label="Preferred pre-referral workup" value={joinList(draft.preferred_pre_referral_workup)} onChange={(value) => setDraft({ ...draft, preferred_pre_referral_workup: splitList(value) })} /><label><span>Optional notes</span><textarea value={draft.notes} maxLength={500} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Anything referring clinicians should know" /></label><button className="button-primary" disabled={busy || !confirmed || !draft.areas_of_focus.length}>Save preferences <span>→</span></button></form>}
      {profile.agent.status === 'verified' && profile.agent.preferences && <div className="activate-ready"><span>✓</span><div><strong>Configuration saved</strong><p>Practice information and structured preferences are ready.</p></div><button className="button-primary" disabled={busy} onClick={() => void act(() => activateProvider(npi))}>Activate Agent <span>→</span></button></div>}
      {profile.agent.status === 'active' && profile.agent.preferences && <ActivePreferences preferences={profile.agent.preferences} />}
    </section>
    <section className="consult-boundary-card"><div><p className="eyebrow">Clinical network boundary</p><h2>{profile.consult_eligible ? 'Controlled consult identity' : 'Not eligible for Consult Network'}</h2><p>{profile.consult_eligible ? 'This synthetic physician’s richer practice footprint is already used in the Jordan Lee demo.' : 'National NPPES records are directory identities only and are not candidates for clinical recommendation.'}</p></div><button className="button-secondary" onClick={() => navigate('/patients/patient-ckd-htn-001')}>Return to Consult Network</button></section>
  </main>
}

function PreferenceField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label><span>{label} <em>Comma separated</em></span><input value={value} onChange={(event) => onChange(event.target.value)} /></label> }
function ActivePreferences({ preferences }: { preferences: AgentPreferences }) { return <div className="active-preferences"><div className="activation-success"><span>✓</span><div><strong>Physician agent active</strong><p>Activated locally for this synthetic demonstration.</p></div></div><div className="preference-summary"><div><span>Areas of focus</span><strong>{preferences.areas_of_focus.join(' · ')}</strong></div><div><span>Cases accepted</span><strong>{preferences.cases_accepted.join(' · ') || 'Not specified'}</strong></div><div><span>Cases redirected</span><strong>{preferences.cases_redirected.join(' · ') || 'Not specified'}</strong></div><div><span>Pre-referral workup</span><strong>{preferences.preferred_pre_referral_workup.join(' · ') || 'Not specified'}</strong></div>{preferences.notes && <div className="wide"><span>Notes</span><strong>{preferences.notes}</strong></div>}</div></div> }
