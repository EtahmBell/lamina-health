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
import { membershipLabel, networkRoster, physicianDisplayName, rosterSize, type NetworkRelationship } from './networkRoster.ts'

type Navigate = (path: string) => void

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

function DirectoryResult({ profile, navigate, inNetwork, busy, onAdd, onRemove }: {
  profile: PhysicianNetworkProfile; navigate: Navigate; inNetwork: boolean; busy: boolean
  onAdd: () => void; onRemove: () => void
}) {
  const name = physicianDisplayName(profile.display_name)
  const initials = name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')
  const location = `${profile.city || 'Location not listed'}${profile.state ? `, ${profile.state}` : ''}`
  return <div className={`lam-row directory-result ${profile.agent.status === 'active' ? '' : 'muted'}`}>
    <span className="lam-row-mark directory-avatar">{initials}</span>
    <span className="lam-row-main"><strong>{name}</strong><span>{profile.specialty}</span><small>{location}</small></span>
    <StatusBadge status={profile.agent.status} />
    <span className="directory-result-actions">
      {inNetwork
        ? <button className="text-button quiet-remove" disabled={busy} onClick={onRemove}>Remove colleague</button>
        : <button className="button-secondary add-to-network" disabled={busy} onClick={onAdd}>Add colleague <span>→</span></button>}
      <button className="text-button" onClick={() => navigate(`/network/${profile.npi}`)}>View profile →</button>
    </span>
  </div>
}

function NetworkRelationshipRow({ member, navigate }: { member: NetworkRelationship; navigate: Navigate }) {
  return <button className="lam-row" onClick={() => navigate(`/network/${member.npi}`)}>
    <span className="lam-row-mark directory-avatar">{member.initials}</span>
    <span className="lam-row-main">
      <strong>{member.name}</strong>
      <span>{membershipLabel(member.source)}</span>
      <small>{[
        member.lastRecommendation ? `Last recommended ${interactionDate(member.lastRecommendation)}` : null,
        member.resolved ? member.location : 'Directory record unavailable',
      ].filter(Boolean).join(' · ')}</small>
    </span>
    {member.status ? <StatusBadge status={member.status} /> : <span className="agent-status-badge unknown"><i />Agent state unknown</span>}
    <span className="lam-row-action">View physician <b>→</b></span>
  </button>
}

const interactionDate = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** Network → My Network content for Lucy (the only persona with a workspace-scoped roster today — see Pass 7C report). The network graph/visualization was removed in the Dashboard+Network polish pass: Colleagues is a focused list now, not a visualization. */
export function MyNetworkTab({ navigate }: { navigate: Navigate }) {
  const [filters, setFilters] = useState({ q: '', specialty: '', location: '' })
  const [response, setResponse] = useState<ProviderSearchResponse | null>(null)
  const [network, setNetwork] = useState<AgentNetwork | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAllResults, setShowAllResults] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingNpi, setPendingNpi] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault(); setLoading(true); setError(null); setShowAllResults(false)
    try { setResponse(await searchProviders(filters)) }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Directory search failed') }
    finally { setLoading(false) }
  }
  const loadNetwork = () => getAgentNetwork().then(setNetwork).catch((loadError: Error) => setNetworkError(loadError.message))
  useEffect(() => { void runSearch(); void loadNetwork() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!addOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addOpen])

  const changeMembership = async (npi: string, action: () => Promise<unknown>) => {
    setPendingNpi(npi); setError(null)
    try { await action(); await loadNetwork() }
    catch (membershipError) { setError(membershipError instanceof Error ? membershipError.message : 'Could not update your network') }
    finally { setPendingNpi(null) }
  }

  const groups = network ? networkRoster(network) : []
  const memberNpis = new Set([
    ...(network?.nodes.filter((node) => node.in_network).map((node) => node.npi) || []),
    ...(network?.members.map((member) => member.npi) || []),
  ])
  const results = response?.results || []
  const visibleResults = showAllResults ? results : results.slice(0, 4)
  const hiddenResults = results.length - visibleResults.length

  return <div className="my-network-tab">
    <div className="my-network-tab-header">
      <p className="network-intro">Your professional network grows through physicians you add and meaningful interactions between physician agents.</p>
      <button className="button-secondary add-colleague-trigger" onClick={() => setAddOpen(true)}>Add a colleague <span>+</span></button>
    </div>

    <section className="network-primary-section">
      {networkError && <div className="error-banner" role="alert">Network relationships unavailable: {networkError}</div>}
      {!network && !networkError && <div className="directory-loading"><NetworkGlyph active /><p>Loading your physician relationships…</p></div>}
      {network && !groups.length && <div className="empty-state">
        <NetworkGlyph />
        <h2>Your network will grow as you consult physician agents and add colleagues you already work with.</h2>
        <button className="button-primary" onClick={() => setAddOpen(true)}>Add a colleague <span>→</span></button>
      </div>}
      {groups.map((group) => <section className="network-specialty-group" key={group.specialty}>
        <div className="network-specialty-heading"><h3>{group.specialty}</h3><span>{group.members.length}</span></div>
        <div className="lam-list">{group.members.map((member) => <NetworkRelationshipRow key={member.npi} member={member} navigate={navigate} />)}</div>
      </section>)}
      {network && groups.length > 0 && <p className="network-roster-note">{rosterSize(groups)} physician{rosterSize(groups) === 1 ? '' : 's'} across {groups.length} specialt{groups.length === 1 ? 'y' : 'ies'}.</p>}
    </section>

    {addOpen && <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setAddOpen(false) }}>
      <div className="post-flow-dialog" role="dialog" aria-modal="true" aria-label="Add a colleague">
        <button className="text-button post-flow-close" onClick={() => setAddOpen(false)} aria-label="Close">×</button>
        <p className="eyebrow">Add a colleague</p>
        <h2>Add physicians and practices you already work with.</h2>
        <p className="panel-intro">Lamina preserves this relationship alongside your broader network.</p>
        <p className="network-boundary-notice quiet">Directory identities are sourced from NPPES; a reserved identity does not imply that the physician participates in Lamina. Adding a physician records your relationship — it does not activate their agent.</p>
        <form className="directory-search-panel quiet" onSubmit={runSearch}>
          <label className="directory-search-main"><span>Physician name</span><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="e.g. Jane Smith" /></label>
          <label><span>Specialty</span><input value={filters.specialty} onChange={(event) => setFilters({ ...filters, specialty: event.target.value })} placeholder="e.g. Nephrology" /></label>
          <label><span>Location</span><input value={filters.location} onChange={(event) => setFilters({ ...filters, location: event.target.value })} placeholder="City or state" /></label>
          <button className="button-secondary" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
        </form>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="directory-results-heading quiet"><h3>{filters.q || filters.specialty || filters.location ? 'Matching physicians' : 'Synthetic demo physicians'}</h3><span>{response?.count ?? 0} shown{response?.directory_available ? ` · ${response.directory_records.toLocaleString()} directory records` : ''}</span></div>
        {response?.directory_status === 'unavailable' && <p className="directory-status-notice" role="status">{response.directory_message ?? 'The national provider directory is temporarily unavailable.'} Your Lamina network remains accessible.</p>}
        {response?.directory_status === 'invalid_query' && <p className="directory-status-notice" role="status">{response.directory_message ?? 'Try a more specific name, specialty, or location.'}</p>}
        {loading ? <div className="directory-loading"><NetworkGlyph active /><p>Searching physician identities…</p></div> : <><div className="lam-list quiet">{visibleResults.map((profile) => <DirectoryResult
          key={profile.npi}
          profile={profile}
          navigate={navigate}
          inNetwork={memberNpis.has(profile.npi)}
          busy={pendingNpi === profile.npi}
          onAdd={() => void changeMembership(profile.npi, () => addNetworkMember(profile.npi))}
          onRemove={() => void changeMembership(profile.npi, () => removeNetworkMember(profile.npi))}
        />)}{results.length === 0 && response?.directory_status !== 'unavailable' && response?.directory_status !== 'invalid_query' && <div className="empty-state"><NetworkGlyph /><h2>No physicians found</h2><p>Try fewer terms or search by a city, state, or specialty.</p></div>}</div>{hiddenResults > 0 && <button className="text-button results-expand" onClick={() => setShowAllResults(true)}>Show {hiddenResults} more result{hiddenResults === 1 ? '' : 's'} →</button>}</>}
      </div>
    </div>}
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
