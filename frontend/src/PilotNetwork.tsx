import { useEffect, useState } from 'react'
import { LaminaMark } from './LaminaMark.tsx'
import { getPublicProfile, getPublicProfilePreview, listReferrals, type PilotStatus } from './pilotApi.ts'
import { pilotPaths, referringClinicians, type ReferringClinician } from './pilotState.ts'
import { useOnPilotDataChange } from './pilotSync.ts'
import { NetworkGlobeArt, PageLoading } from './pilotUi.tsx'

type Navigate = (path: string) => void

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * Network, in the demo's Network page structure (directory hero → network hero →
 * colleagues column + right rail). The pilot has no physician network yet, and no
 * network endpoint is mounted in pilot mode, so this page never shows a colleague,
 * connection, or suggestion. The only list is clinicians who have actually referred to
 * this practice, derived from its own received referrals and labeled as exactly that.
 */
export function NetworkPage({ status, navigate }: { status: PilotStatus; navigate: Navigate }) {
  const physician = status.role === 'physician'
  // What referring offices can actually see: the PUBLISHED page (not the draft), and whether it
  // lists referral criteria. Unknown until both reads return; then the card says only what's true.
  const [publicPage, setPublicPage] = useState<'unknown' | 'none' | 'contact_only' | 'with_criteria'>('unknown')
  useEffect(() => {
    let live = true
    getPublicProfilePreview().then(async (preview) => {
      if (preview.status !== 'published' || !preview.published_version) { if (live) setPublicPage('none'); return }
      const published = await getPublicProfile(preview.slug)
      if (live) setPublicPage(published.profile.referral_types.length > 0 ? 'with_criteria' : 'contact_only')
    }).catch(() => { if (live) setPublicPage('unknown') })
    return () => { live = false }
  }, [])
  const [referrers, setReferrers] = useState<ReferringClinician[] | null>(null)
  const [error, setError] = useState('')
  const load = () => { listReferrals().then((items) => setReferrers(referringClinicians(items))).catch(() => setError('Could not load referring clinicians')) }
  useEffect(load, [])
  useOnPilotDataChange(load)

  return <main className="page-shell physician-directory-page pilot-network-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>The clinicians and practices who refer to you. Connecting with colleagues on Lamina comes later.</p></div></header>

    <div className="my-network-tab">
      <section className="network-hero">
        <div className="network-hero-copy">
          <p className="eyebrow">Physician network</p>
          <h2>Your Lamina network is being built.</h2>
          <p>Connecting with colleagues isn’t available to pilot practices yet. Until it is, nothing here suggests or adds physicians on your behalf.</p>
        </div>
        <NetworkGlobeArt />
        <div className="network-hero-action">
          {publicPage === 'with_criteria' && <><h3>Referring offices can reach you today.</h3>
            <p>Your published public page shows what you need before a referral and lets offices send one securely.</p></>}
          {publicPage === 'contact_only' && <><h3>Your public page is published.</h3>
            <p>It doesn’t list referral criteria yet, so offices see your contact and how-to-refer details only.</p></>}
          {publicPage === 'none' && <><h3>Referring offices reach you the usual way.</h3>
            <p>You haven’t published a public page, so offices refer by fax, phone or email as they do today.</p></>}
          {publicPage === 'unknown' && <><h3>Referring offices reach you the usual way.</h3>
            <p>By fax, phone or email, as they do today.</p></>}
          {physician && <button className="button-primary" onClick={() => navigate(pilotPaths.publicProfile)}>{publicPage === 'none' ? 'Set up a public page' : 'Public physician profile'} <span>→</span></button>}
        </div>
      </section>

      <div className="network-colleagues-layout">
        <div className="network-colleagues-main">
          <section className="network-primary-section">
            <h2 className="network-section-title">Your colleagues</h2>
            <div className="empty-state pilot-network-empty">
              <LaminaMark directory />
              <h2>No colleagues on Lamina yet.</h2>
              <p>When the network opens to your practice, the physicians you choose to connect with will appear here.</p>
            </div>
          </section>

          <section className="network-primary-section">
            <h2 className="network-section-title">Clinicians who have referred to you</h2>
            {error && <div className="error-banner" role="alert">{error}</div>}
            {!referrers && !error && <PageLoading label="Loading referring clinicians…" />}
            {referrers && referrers.length === 0 && <p className="agent-empty-note">Clinicians appear here once your practice receives referrals from them in Lamina.</p>}
            {referrers && referrers.length > 0 && <>
              <div className="lam-list">{referrers.map((referrer) => <div key={referrer.key} className="lam-row connection-row pilot-referrer-row">
                <div className="connection-row-main">
                  <span className="lam-row-mark directory-avatar">{referrer.initials}</span>
                  <span className="lam-row-main">
                    <strong>{referrer.name}</strong>
                    <span>{referrer.practice ?? 'Practice not listed'}</span>
                    <small>{referrer.count} referral{referrer.count === 1 ? '' : 's'} received · most recent {formatDate(referrer.lastAt)}</small>
                  </span>
                </div>
              </div>)}</div>
              <p className="network-roster-note">From referrals your practice received in Lamina, as the referring office entered them. These are referral relationships, not Lamina network connections.</p>
            </>}
          </section>
        </div>

        <aside className="active-network-rail">
          <section className="ask-network-card">
            <h3>Coordinating with colleagues today</h3>
            <p className="muted-note">Information requests to referring offices, and their replies, live on each patient’s referral. Offices follow progress through a private status link.</p>
            <button className="text-button" onClick={() => navigate(pilotPaths.patients)}>Open patients →</button>
          </section>
        </aside>
      </div>
    </div>
  </main>
}
