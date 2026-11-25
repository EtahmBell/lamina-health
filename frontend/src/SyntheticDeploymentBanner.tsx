import { useEffect, useState } from 'react'
import { AI_LIMITED_EVENT, apiRequest } from './api.ts'
import { SYNTHETIC_BANNER_TEXT, aiLimitedText, isSyntheticDeployment } from './syntheticDeployment.ts'

/**
 * A persistent strip on every page (demo and pilot, every width) of the hosted synthetic
 * deployment. Local dev and e2e never show it: their API does not report `deployment`.
 */
export function SyntheticDeploymentBanner() {
  const [synthetic, setSynthetic] = useState(false)
  const [limited, setLimited] = useState('')
  useEffect(() => {
    const onLimited = (event: Event) => setLimited(String((event as CustomEvent).detail ?? ''))
    globalThis.addEventListener(AI_LIMITED_EVENT, onLimited)
    return () => globalThis.removeEventListener(AI_LIMITED_EVENT, onLimited)
  }, [])
  useEffect(() => {
    let live = true
    apiRequest<unknown>('/health').then((health) => { if (live) setSynthetic(isSyntheticDeployment(health)) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  if (!synthetic) return null
  return <div className="synthetic-deployment-banner" role="note">{SYNTHETIC_BANNER_TEXT}
    {limited && <span className="synthetic-ai-limited" role="status"> · {aiLimitedText(limited)}</span>}</div>
}
