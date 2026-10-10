import { useEffect, useState, type FormEvent } from 'react'
import { LaminaMark } from './LaminaMark.tsx'
import {
  addNetworkMember,
  getAgentNetwork,
  getProvider,
  removeNetworkMember,
  searchProviders,
  type AgentNetwork,
  type AgentStatus,
  type PhysicianNetworkProfile,
  type ProviderSearchResponse,
} from './api.ts'
import { ENGAGEMENT_PERSONA_BY_NPI } from './demoIdentity.ts'
import { networkProfilePath } from './Engagement.tsx'
import { connectionLine, physicianDisplayName, physicianInitials, rankedNetworkList, type NetworkRelationship } from './networkRoster.ts'

type Navigate = (path: string) => void

type SuggestedConnection = {
  npi: string; name: string; specialty: string; location: string; reason: string
}

/**
 * A small controlled synthetic fallback -- real, already-modeled demo physicians
 * (see backend PERSONAS/EXPANDED_NETWORK_PHYSICIANS), each with an honest,
 * non-fabricated reason. No invented mutual-colleague counts or interaction
 * numbers; these are specialty/interest framing only. Used to fill out the
 * Suggested connections section when real consultation-derived candidates (see
 * buildSuggestions below) don't reach three on their own.
 */
const CURATED_SUGGESTIONS: SuggestedConnection[] = [
  { npi: '9900000012', name: 'Dr. Tiffany Sanchez', specialty: 'Gastroenterology', location: 'Oakland, CA', reason: 'A specialty your agent’s referral patterns often route toward.' },
  { npi: '9900000023', name: 'Dr. Maya Ramanathan', specialty: 'Endocrinology', location: 'Oakland, CA', reason: 'Works with complex diabetes referrals.' },
  { npi: '9900000024', name: 'Dr. Nina Park', specialty: 'Obstetrics & Gynecology', location: 'Berkeley, CA', reason: 'Shares your interest in care coordination.' },
  { npi: '9900000002', name: 'Dr. Matthew Onadeko', specialty: 'Cardiology', location: 'San Francisco, CA', reason: 'Relevant to resistant-hypertension referral patterns.' },
]

/** Real, consultation-derived suggestions first (a physician-agent your agent has
 * actually interacted with, but isn't yet a confirmed colleague) -- this is the
 * "case -> consultation -> relevant physician -> suggested -> added" loop.
 * Never a fabricated count: the reason only ever states what's directly on the
 * relationship record. Falls back to the curated list above to fill out to
 * `limit`, skipping anyone already a colleague or already surfaced. */
function buildSuggestions(network: AgentNetwork | null, memberNpis: Set<string>, limit: number): SuggestedConnection[] {
  const seen = new Set(memberNpis)
  const suggestions: SuggestedConnection[] = []
  if (network) {
    for (const node of network.nodes) {
      if (node.in_network || seen.has(node.npi) || !node.relationship) continue
      const { consultation_count, recommended_count, last_recommendation_patient_name } = node.relationship
      if (consultation_count <= 0 && recommended_count <= 0) continue
      seen.add(node.npi)
      suggestions.push({
        npi: node.npi,
        name: physicianDisplayName(node.name),
        specialty: node.specialty,
        location: node.location,
        reason: last_recommendation_patient_name
          ? `Recently connected through ${last_recommendation_patient_name}'s consultation.`
          : `Your agent recently consulted ${physicianDisplayName(node.name)}'s agent.`,
      })
    }
  }
  for (const candidate of CURATED_SUGGESTIONS) {
    if (suggestions.length >= limit) break
    if (seen.has(candidate.npi)) continue
    seen.add(candidate.npi)
    suggestions.push(candidate)
  }
  return suggestions
}

/** Physician-facing participation language — never internal lifecycle jargon like
 * "Reserved · not activated". */
const statusCopy: Record<AgentStatus, { label: string; detail: string }> = {
  reserved: { label: 'Not yet on Lamina', detail: 'A directory identity exists, but this physician has not joined Lamina yet.' },
  claimed: { label: 'Joining Lamina', detail: 'This physician has started joining Lamina; verification is not yet complete.' },
  verification_pending: { label: 'Joining Lamina', detail: 'A profile claim has started. Identity verification is not complete.' },
  verified: { label: 'Verified · setting up', detail: 'Identity is verified; practice details and preferences can now be configured.' },
  active: { label: 'On Lamina', detail: 'This physician’s agent is active.' },
  disabled: { label: 'Not currently active', detail: 'This agent identity is not currently active.' },
}

function NetworkGlyph({ active = false }: { active?: boolean }) {
  return <LaminaMark directory active={active} />
}

function StatusBadge({ status }: { status: AgentStatus }) {
  return <span className={`agent-status-badge ${status}`}><i />{statusCopy[status].label}</span>
}

/** A clean colleague-finder result card — avatar, identity block, status, and a
 * stacked action column. No truncation, no cramped mini-table. */
function DirectoryResult({ profile, navigate, inNetwork, busy, onAdd, onRemove }: {
  profile: PhysicianNetworkProfile; navigate: Navigate; inNetwork: boolean; busy: boolean
  onAdd: () => void; onRemove: () => void
}) {
  const name = physicianDisplayName(profile.display_name)
  const initials = name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')
  const location = `${profile.city || 'Location not listed'}${profile.state ? `, ${profile.state}` : ''}`
  return <div className={`directory-result-card ${profile.agent.status === 'active' ? '' : 'muted'}`}>
    <span className="lam-row-mark directory-avatar">{initials}</span>
    <div className="directory-result-identity">
      <strong>{name}</strong>
      <span>{profile.specialty}</span>
      <small>{location}</small>
    </div>
    <StatusBadge status={profile.agent.status} />
    <div className="directory-result-actions">
      {inNetwork
        ? <button className="text-button quiet-remove" disabled={busy} onClick={onRemove}>Remove colleague</button>
        : <button className="button-primary add-to-network" disabled={busy} onClick={onAdd}>Add colleague <span>→</span></button>}
      <button className="text-button" onClick={() => navigate(`/network/${profile.npi}`)}>View profile →</button>
    </div>
  </div>
}

/** One row in "Most connected in your network" or the expanded full list — the
 * same component either way, just a different slice of rankedNetworkList(). */
function ConnectionRow({ member, navigate }: { member: NetworkRelationship; navigate: Navigate }) {
  return <button className="lam-row" onClick={() => navigate(`/network/${member.npi}`)}>
    <span className="lam-row-mark directory-avatar">{member.initials}</span>
    <span className="lam-row-main">
      <strong>{member.name}</strong>
      <span>{member.specialty}{member.resolved && member.location ? ` · ${member.location}` : ''}</span>
      <small>{connectionLine(member)}</small>
    </span>
    {member.status ? <StatusBadge status={member.status} /> : <span className="agent-status-badge unknown"><i />Agent state unknown</span>}
    <span className="lam-row-action">View physician <b>→</b></span>
  </button>
}

/** The Colleagues hero: a Network-specific sibling of the Dashboard agent banner
 * (same "copy beside a decorative motif, with a white inset action card" shape --
 * see .agent-banner-main/.agent-banner-action), adapted rather than copied: the
 * motif is an abstract, tilted professional-network globe (CSS/SVG only, no stock
 * imagery, no literal map), and the inset card carries the actual CTA instead of
 * the main headline block. */
function NetworkHero({ onAdd }: { onAdd: () => void }) {
  return <section className="network-hero">
    <div className="network-hero-copy">
      <p className="eyebrow">Physician network</p>
      <h2>Grow your Lamina network.</h2>
      <p>Search any physician in the U.S. using NPPES and add them to your network.</p>
    </div>
    <div className="network-hero-globe">
      <svg className="network-hero-globe-art" viewBox="0 0 220 220" fill="none" aria-hidden="true">
        <ellipse className="globe-ring" cx="110" cy="112" rx="84" ry="84" />
        <ellipse className="globe-ring" cx="110" cy="112" rx="84" ry="30" />
        <ellipse className="globe-ring" cx="110" cy="112" rx="84" ry="58" transform="rotate(-24 110 112)" />
        <ellipse className="globe-ring" cx="110" cy="112" rx="50" ry="84" transform="rotate(14 110 112)" />
        <path className="globe-arc" d="M34,124 Q110,54 182,98" />
        <path className="globe-arc" d="M46,150 Q116,170 176,126" />
        <path className="globe-arc" d="M60,80 Q118,60 168,86" />
        <circle className="globe-node" cx="58" cy="122" r="3" />
        <circle className="globe-node" cx="92" cy="92" r="2.4" />
        <circle className="globe-node" cx="138" cy="96" r="3" />
        <circle className="globe-node" cx="174" cy="110" r="2.4" />
        <circle className="globe-node" cx="78" cy="152" r="2.4" />
        <circle className="globe-node" cx="150" cy="142" r="3" />
        <circle className="globe-node hub" cx="112" cy="120" r="4.5" />
      </svg>
      <div className="network-hero-action">
        <h3>Search and add your colleagues.</h3>
        <p>Find physicians you already work with.</p>
        <button className="button-primary" onClick={onAdd}>Add a colleague <span>→</span></button>
      </div>
    </div>
  </section>
}

/** A single compact row -- lighter than the main colleague list, never a full
 * card. The reason line is the whole point: every suggestion explains itself. */
function SuggestedConnectionRow({ suggestion, navigate, busy, onAdd }: {
  suggestion: SuggestedConnection; navigate: Navigate; busy: boolean; onAdd: () => void
}) {
  const persona = ENGAGEMENT_PERSONA_BY_NPI[suggestion.npi]
  return <div className="suggestion-row">
    <span className="lam-row-mark directory-avatar">{physicianInitials(suggestion.name)}</span>
    <div className="suggestion-row-main">
      <strong>{suggestion.name}</strong>
      <span>{suggestion.specialty} · {suggestion.location}</span>
      <small>{suggestion.reason}</small>
    </div>
    <div className="suggestion-row-actions">
      <button className="button-secondary suggestion-add" disabled={busy} onClick={onAdd}>Add <span>→</span></button>
      {persona && <button className="text-button" onClick={() => navigate(networkProfilePath('lucy', persona))}>View profile →</button>}
    </div>
  </div>
}

/** "People your agent thinks you should know" -- discovery, not an address book.
 * Every suggestion names a real reason (see buildSuggestions); none are ever
 * fabricated interaction counts. Shows 3 by default with a local expand, never a
 * second page. An honest quiet state when nothing is available -- never forced
 * placeholders (see MyNetworkTab for the empty-pool case). */
function SuggestedConnections({ suggestions, navigate, pendingNpi, onAdd }: {
  suggestions: SuggestedConnection[]; navigate: Navigate; pendingNpi: string | null; onAdd: (npi: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (suggestions.length === 0) return <section className="suggested-connections">
    <h2 className="network-section-title">People your agent thinks you should know</h2>
    <p className="agent-empty-note">Your agent will suggest relevant physicians as your network and activity grow.</p>
  </section>
  const visible = expanded ? suggestions : suggestions.slice(0, 3)
  const hidden = suggestions.length - visible.length
  return <section className="suggested-connections">
    <h2 className="network-section-title">People your agent thinks you should know</h2>
    <div className="suggestion-list">{visible.map((suggestion) => <SuggestedConnectionRow
      key={suggestion.npi}
      suggestion={suggestion}
      navigate={navigate}
      busy={pendingNpi === suggestion.npi}
      onAdd={() => onAdd(suggestion.npi)}
    />)}</div>
    {hidden > 0 && <button className="text-button suggestion-expand" onClick={() => setExpanded(true)}>See {hidden} more suggestion{hidden === 1 ? '' : 's'} →</button>}
  </section>
}

/** The redesigned Add-colleague experience: a search-first finder, not a cramped
 * admin table. Top = title/explanation/disclaimer, search controls, then clean
 * result cards (DirectoryResult) whether the list came from a real query or the
 * default synthetic demo physicians. */
function AddColleagueModal({ navigate, onClose, memberNpis, onChanged }: {
  navigate: Navigate; onClose: () => void; memberNpis: Set<string>; onChanged: () => void
}) {
  const [filters, setFilters] = useState({ q: '', specialty: '', location: '' })
  const [response, setResponse] = useState<ProviderSearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAllResults, setShowAllResults] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingNpi, setPendingNpi] = useState<string | null>(null)

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault(); setLoading(true); setError(null); setShowAllResults(false)
    try { setResponse(await searchProviders(filters)) }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Directory search failed') }
    finally { setLoading(false) }
  }
  useEffect(() => { void runSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const changeMembership = async (npi: string, action: () => Promise<unknown>) => {
    setPendingNpi(npi); setError(null)
    try { await action(); onChanged() }
    catch (membershipError) { setError(membershipError instanceof Error ? membershipError.message : 'Could not update your network') }
    finally { setPendingNpi(null) }
  }

  const results = response?.results || []
  const visibleResults = showAllResults ? results : results.slice(0, 4)
  const hiddenResults = results.length - visibleResults.length

  return <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog add-colleague-dialog" role="dialog" aria-modal="true" aria-label="Add a colleague">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">Add a colleague</p>
      <h2>Find a physician to add to your network.</h2>
      <p className="panel-intro">Search any physician in the U.S. using NPPES, or add from the synthetic demo physicians below.</p>
      <p className="network-boundary-notice quiet">Directory identities are sourced from NPPES; a reserved identity does not imply that the physician participates in Lamina. Adding a physician records your relationship — it does not activate their agent.</p>
      <form className="colleague-search-form" onSubmit={runSearch}>
        <label><span>Physician name</span><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="e.g. Jane Smith" /></label>
        <label><span>Specialty</span><input value={filters.specialty} onChange={(event) => setFilters({ ...filters, specialty: event.target.value })} placeholder="e.g. Nephrology" /></label>
        <label><span>Location</span><input value={filters.location} onChange={(event) => setFilters({ ...filters, location: event.target.value })} placeholder="City or state" /></label>
        <button className="button-primary colleague-search-submit" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </form>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="directory-results-heading quiet"><h3>{filters.q || filters.specialty || filters.location ? 'Matching physicians' : 'Synthetic demo physicians'}</h3><span>{response?.count ?? 0} shown{response?.directory_available ? ` · ${response.directory_records.toLocaleString()} directory records` : ''}</span></div>
      {response?.directory_status === 'unavailable' && <p className="directory-status-notice" role="status">{response.directory_message ?? 'The national provider directory is temporarily unavailable.'} Your Lamina network remains accessible.</p>}
      {response?.directory_status === 'invalid_query' && <p className="directory-status-notice" role="status">{response.directory_message ?? 'Try a more specific name, specialty, or location.'}</p>}
      {loading ? <div className="directory-loading"><NetworkGlyph active /><p>Searching physician identities…</p></div> : <div className="directory-results-list">{visibleResults.map((profile) => <DirectoryResult
        key={profile.npi}
        profile={profile}
        navigate={navigate}
        inNetwork={memberNpis.has(profile.npi)}
        busy={pendingNpi === profile.npi}
        onAdd={() => void changeMembership(profile.npi, () => addNetworkMember(profile.npi))}
        onRemove={() => void changeMembership(profile.npi, () => removeNetworkMember(profile.npi))}
      />)}{results.length === 0 && response?.directory_status !== 'unavailable' && response?.directory_status !== 'invalid_query' && <div className="empty-state"><NetworkGlyph /><h2>No physicians found</h2><p>Try fewer terms or search by a city, state, or specialty.</p></div>}{hiddenResults > 0 && <button className="text-button results-expand" onClick={() => setShowAllResults(true)}>Show {hiddenResults} more result{hiddenResults === 1 ? '' : 's'} →</button>}</div>}
    </div>
  </div>
}

/** Network → My Network content for Lucy (the only persona with a workspace-scoped roster today — see Pass 7C report). Restructured (Network+Feed refinement pass) into a hero, a ranked "Most connected" top 5, and an inline-expandable full list -- no specialty grouping, no graph/visualization. */
export function MyNetworkTab({ navigate }: { navigate: Navigate }) {
  const [network, setNetwork] = useState<AgentNetwork | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [showAllColleagues, setShowAllColleagues] = useState(false)
  const [pendingSuggestionNpi, setPendingSuggestionNpi] = useState<string | null>(null)

  const loadNetwork = () => getAgentNetwork().then(setNetwork).catch((loadError: Error) => setNetworkError(loadError.message))
  useEffect(() => { void loadNetwork() }, [])

  const ranked = network ? rankedNetworkList(network) : []
  const top = ranked.slice(0, 5)
  const rest = ranked.slice(5)
  const memberNpis = new Set([
    ...(network?.nodes.filter((node) => node.in_network).map((node) => node.npi) || []),
    ...(network?.members.map((member) => member.npi) || []),
  ])
  const suggestions = buildSuggestions(network, memberNpis, 6)

  const addSuggestion = async (npi: string) => {
    setPendingSuggestionNpi(npi)
    try { await addNetworkMember(npi); loadNetwork() }
    finally { setPendingSuggestionNpi(null) }
  }

  return <div className="my-network-tab">
    <NetworkHero onAdd={() => setAddOpen(true)} />

    {network && <SuggestedConnections suggestions={suggestions} navigate={navigate} pendingNpi={pendingSuggestionNpi} onAdd={addSuggestion} />}

    <section className="network-primary-section">
      {networkError && <div className="error-banner" role="alert">Network relationships unavailable: {networkError}</div>}
      {!network && !networkError && <div className="directory-loading"><NetworkGlyph active /><p>Loading your physician relationships…</p></div>}
      {network && !ranked.length && <div className="empty-state">
        <NetworkGlyph />
        <h2>Your network will grow as you consult physician agents and add colleagues you already work with.</h2>
        <button className="button-primary" onClick={() => setAddOpen(true)}>Add a colleague <span>→</span></button>
      </div>}
      {ranked.length > 0 && <>
        <h2 className="network-section-title">Most connected in your network</h2>
        <div className="lam-list">{top.map((member) => <ConnectionRow key={member.npi} member={member} navigate={navigate} />)}</div>
        {rest.length > 0 && <>
          <button className="text-button network-see-all" aria-expanded={showAllColleagues} onClick={() => setShowAllColleagues((value) => !value)}>{showAllColleagues ? 'Hide full list ↑' : 'See all colleagues ↓'}</button>
          <div className={`network-full-list ${showAllColleagues ? 'open' : ''}`}>
            <div className="lam-list">{rest.map((member) => <ConnectionRow key={member.npi} member={member} navigate={navigate} />)}</div>
          </div>
        </>}
        <p className="network-roster-note">{ranked.length} physician{ranked.length === 1 ? '' : 's'} in your network.</p>
      </>}
    </section>

    {addOpen && <AddColleagueModal navigate={navigate} onClose={() => setAddOpen(false)} memberNpis={memberNpis} onChanged={loadNetwork} />}
  </div>
}

/**
 * A read-only Physician Network context view. Claiming, verification and
 * activation all happen in the one canonical identity flow at /claim — see
 * Claim.tsx. This page only links into it (§31/§32: one claim experience,
 * never a second one built inside Physician Network).
 */
export function PhysicianProfilePage({ npi, navigate }: { npi: string; navigate: Navigate }) {
  const [profile, setProfile] = useState<PhysicianNetworkProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getProvider(npi).then(setProfile).catch((loadError: Error) => setError(loadError.message)) }, [npi])
  if (!profile) return <main className="page-shell physician-profile-page"><button className="text-button back-link" onClick={() => navigate('/network')}>← Network</button>{error ? <div className="error-banner">{error}</div> : <div className="directory-loading"><NetworkGlyph active /><p>Opening physician profile…</p></div>}</main>

  const synthetic = profile.source === 'SYNTHETIC'
  const copy = statusCopy[profile.agent.status]
  const name = physicianDisplayName(profile.display_name)
  const claimPath = `/claim/provider/${encodeURIComponent(profile.npi)}`
  return <main className="page-shell physician-profile-page">
    <button className="text-button back-link" onClick={() => navigate('/network')}>← Network</button>
    <section className="provider-profile-hero"><div className="profile-identity"><span className="directory-avatar large">{name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')}</span><div><p className="eyebrow">{synthetic ? 'Controlled synthetic physician' : 'NPPES physician profile'}</p><h1>{name}</h1><p>{profile.specialty}</p></div></div><StatusBadge status={profile.agent.status} /></section>
    <div className="profile-facts"><div><span>Practice location</span><strong>{profile.city || 'Not listed'}{profile.state ? `, ${profile.state}` : ''}</strong></div><div><span>Organisation</span><strong>{profile.organization || 'Not listed in directory'}</strong></div><div><span>NPI</span><strong>{profile.npi}</strong></div>{profile.phone && <div><span>Practice phone</span><strong>{profile.phone}</strong></div>}</div>
    <div className={`profile-provenance ${synthetic ? 'synthetic' : ''}`}><strong>{synthetic ? 'Synthetic demo profile' : 'Public directory record'}</strong><p>{profile.directory_disclaimer}</p></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {ENGAGEMENT_PERSONA_BY_NPI[profile.npi] && <section className="professional-profile-link-card"><div><p className="eyebrow">Professional identity</p><h2>How their agent represents their practice</h2></div><button className="button-secondary" onClick={() => navigate(networkProfilePath('lucy', ENGAGEMENT_PERSONA_BY_NPI[profile.npi]))}>View professional profile →</button></section>}

    <section className="agent-activation-card"><header><div><p className="eyebrow">Lamina Agent</p><h2>{copy.label}</h2><p>{copy.detail}</p></div><NetworkGlyph active={profile.agent.status === 'active'} /></header>
      {profile.agent.status === 'reserved' && profile.claimable
        ? <button className="button-primary" onClick={() => navigate(claimPath)}>Claim this identity <span>→</span></button>
        : <button className="button-secondary" onClick={() => navigate(claimPath)}>{profile.claimed_by_me ? 'Manage your claim' : 'View claim status'} <span>→</span></button>}
    </section>
    <section className="consult-boundary-card"><div><p className="eyebrow">Clinical network boundary</p><h2>{profile.consult_eligible ? 'Controlled consult identity' : 'Not eligible for Consult Network'}</h2><p>{profile.consult_eligible ? 'This synthetic physician’s richer practice footprint is already used in the Jordan Lee demo.' : 'National NPPES records are directory identities only and are not candidates for clinical recommendation.'}</p></div><button className="button-secondary" onClick={() => navigate('/patients/patient-ckd-htn-001')}>Return to Consult Network</button></section>
  </main>
}
