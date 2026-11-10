import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'

/**
 * Presentational primitives of the polished Lamina demo shell, for the real pilot.
 *
 * Every element renders the demo's exact markup and class names (styles.css is the one
 * shared design system), so the pilot inherits the demo's typography, spacing, tokens,
 * and responsive rules rather than restyling them. Nothing here touches data: no demo
 * personas, fixtures, or storage — the pilot passes in only real, server-derived values.
 *
 * The demo's own copies of these elements stay where they are (its shell in App.tsx and
 * its dock module): demo source is pinned by its regression tests, and demo behavior
 * must not change.
 */

type Navigate = (path: string) => void

export function Brand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

/* Sidebar glyphs: same 18-unit grid, 17px size, 1.5 stroke as the demo's physician shell. */
export function HomeNavIcon() {
  return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M2.5 8.25 9 2.75l6.5 5.5" /><path d="M4.25 7v7.25a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V7" /><path d="M7.25 15.25v-4.5h3.5v4.5" /></svg>
}
export function ForYouNavIcon() {
  return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M2 10.5l2-7h10l2 7v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M2 10.5h4l1 2h4l1-2h4" /></svg>
}
export function AgentNavIcon() {
  return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M9 1.75l1.7 4.55 4.55 1.7-4.55 1.7L9 14.25l-1.7-4.55L2.75 8l4.55-1.7z" /><path d="M14.25 12.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" /></svg>
}

/** The demo's Network people glyph (two heads + shoulders), same strokes as the demo. */
export function NetworkNavIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="7.5" r="3" />
    <path d="M2 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <circle cx="16.5" cy="9" r="2.3" />
    <path d="M14.3 13.1c.7-.26 1.5-.4 2.2-.4 2.8 0 5 2.1 5 5.3" />
  </svg>
}

/** The demo Network hero's wireframe globe (decorative; same geometry as the demo). */
export function NetworkGlobeArt() {
  return <svg className="network-hero-globe-art" viewBox="0 0 240 240" fill="none" aria-hidden="true">
    <g className="globe-tilt">
      <circle className="globe-sphere" cx="120" cy="120" r="84" />
      <ellipse className="globe-ring" cx="120" cy="120" rx="84" ry="19" />
      <ellipse className="globe-ring" cx="120" cy="86" rx="67" ry="11" />
      <ellipse className="globe-ring" cx="120" cy="154" rx="67" ry="11" />
      <ellipse className="globe-ring" cx="120" cy="120" rx="34" ry="84" />
      <ellipse className="globe-ring" cx="120" cy="120" rx="62" ry="84" />
      <path className="globe-arc" d="M176,66 Q199,92 198,120" />
      <path className="globe-arc" d="M198,120 Q196,150 172,172" />
      <path className="globe-arc" d="M130,118 Q156,88 176,66" />
      <path className="globe-arc" d="M130,122 Q127,160 120,184" />
      <path className="globe-arc dashed" d="M128,119 Q96,132 70,150" />
      <circle className="globe-node" cx="176" cy="66" r="3" />
      <circle className="globe-node" cx="198" cy="120" r="2.6" />
      <circle className="globe-node" cx="172" cy="172" r="3" />
      <circle className="globe-node" cx="120" cy="184" r="2.6" />
      <circle className="globe-node" cx="70" cy="150" r="2.4" />
      <circle className="globe-node hub" cx="130" cy="119" r="4.5" />
    </g>
  </svg>
}

/** The agent presence orb (breathes unless `still` or reduced motion). */
export function AgentOrb({ still = false }: { still?: boolean }) {
  return <span className={`agent-orb ${still ? 'still' : ''}`} aria-hidden="true" />
}

export type NavEntry = { id: string; title: string; icon: ReactNode; path: string; count?: number }

/** The demo's agent-first physician shell: brand, primary nav, the account pill pinned
 * bottom-left, a quiet status pill top-right, and (on Home / For you) the docked agent. */
export function LaminaShell({ items, section, navigate, homePath, account, status, agentDock = false, children }: {
  items: NavEntry[]; section: string; navigate: Navigate; homePath: string
  account: ReactNode; status: string; agentDock?: boolean; children: ReactNode
}) {
  return <div className={`app-shell physician-shell pilot-shell ${agentDock ? 'has-agent-dock' : ''}`}>
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate(homePath)} aria-label="Lamina home"><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          {items.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.path)}>
            <span className="nav-icon">{item.icon}</span><span className="nav-item-label">{item.title}</span>
            {!!item.count && <span className="nav-count" aria-label={`${item.count} need you`}>{item.count}</span>}
          </button>)}
        </nav>
      </div>
      {account}
    </aside>
    <div className="workspace"><header className="workspace-bar"><div className="workspace-bar-actions"><div className="synthetic-status"><span />{status}</div></div></header>{children}</div>
  </div>
}

export type AccountMenuItem = { label: string; onSelect: () => void } | 'divider' | { note: string }

/** The demo's bottom-left avatar pill + menu (same classes as its perspective switch). */
export function AccountMenu({ initials, name, items }: { initials: string; name: string; items: AccountMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open])
  return <div className="perspective-switch sidebar-account" ref={containerRef}>
    <button className="profile-control avatar-control" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
      <span>{initials}</span><strong>{name}</strong>
    </button>
    {open && <div className="perspective-menu" role="menu" aria-label="Account menu">
      {items.map((item, index) => item === 'divider'
        ? <div key={index} className="perspective-menu-divider" role="separator" />
        : 'note' in item
          ? <p key={index} className="perspective-menu-label">{item.note}</p>
          : <button key={index} role="menuitem" className="perspective-option" onClick={() => { setOpen(false); item.onSelect() }}>{item.label}</button>)}
    </div>}
  </div>
}

/* ----------------------------------------------------------- docked agent */

/** A structured card under an agent reply (the demo's agent-msg-card). `execute` is an
 * opaque instruction the page's own handler carries out when the HUMAN clicks; the dock
 * itself never acts on it. */
export type DockCard = { label: string; detail: string; action: string; path?: string | null; execute?: unknown }
export type DockReply = { paragraphs: string[]; bullets?: string[]; link?: { label: string; detail: string; action: string; path: string }; cards?: DockCard[] }
export type DockMessage = { id: string; role: 'physician' | 'agent'; text?: string; reply?: DockReply; pending?: boolean }
type CardState = 'busy' | 'done' | { error: string }

const DOCK_WIDE_QUERY = '(min-width: 1101px)'

/** The demo's docked agent conversation (Home / For you), wired to a real handler.
 * Open by default on wide screens, a floating pill otherwise. The conversation itself is
 * persisted server-side (loadHistory); nothing is kept in browser storage. */
export function AgentDock({ title, subtitle, greeting, suggestions, placeholder, onSend, navigate, loadHistory, onCard }: {
  title: string; subtitle: string; greeting: string; suggestions: string[]; placeholder: string
  onSend: (text: string) => Promise<DockReply>; navigate: Navigate
  loadHistory?: () => Promise<DockMessage[]>; onCard?: (card: DockCard) => Promise<void>
}) {
  const [open, setOpenState] = useState(() => window.matchMedia?.(DOCK_WIDE_QUERY).matches ?? true)
  const [messages, setMessages] = useState<DockMessage[]>([{ id: 'hello', role: 'agent', reply: { paragraphs: [greeting] } }])
  const [sent, setSent] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const setOpen = (next: boolean, focus = false) => {
    setOpenState(next)
    if (next && focus) window.setTimeout(() => inputRef.current?.focus(), 220)
  }
  useEffect(() => {
    document.body.classList.toggle('agent-dock-open', open)
    return () => document.body.classList.remove('agent-dock-open')
  }, [open])
  useEffect(() => {
    if (!loadHistory) return
    let live = true
    loadHistory().then((history) => {
      if (!live || !history.length) return
      setMessages((prev) => [prev[0], ...history, ...prev.slice(1)])
      setSent(true)
    }).catch(() => undefined)
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const body = bodyRef.current; if (body) body.scrollTop = body.scrollHeight }, [messages, open])

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setSent(true); setOpen(true); setInput(''); setBusy(true)
    const pendingId = `pending-${Date.now()}`
    setMessages((prev) => [...prev, { id: `me-${Date.now()}`, role: 'physician', text: trimmed }, { id: pendingId, role: 'agent', pending: true }])
    let reply: DockReply
    try { reply = await onSend(trimmed) } catch (err) { reply = { paragraphs: [err instanceof Error && err.message ? err.message : 'I couldn’t take that in just now. Try again in a moment.'] } }
    setMessages((prev) => prev.map((item) => (item.id === pendingId ? { id: pendingId, role: 'agent', reply } : item)))
    setBusy(false)
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input) }
  const runCard = async (key: string, card: DockCard) => {
    if (!card.execute || !onCard) { if (card.path) navigate(card.path); return }
    setCards((prev) => ({ ...prev, [key]: 'busy' }))
    try { await onCard(card); setCards((prev) => ({ ...prev, [key]: 'done' })) }
    catch (err) { setCards((prev) => ({ ...prev, [key]: { error: err instanceof Error && err.message ? err.message : 'That didn’t work. Try from the referral.' } })) }
  }

  if (!open) return <aside className="agent-dock collapsed" aria-label={title}>
    <button className="agent-dock-rail" onClick={() => setOpen(true, true)} aria-label={`Open ${title.toLowerCase()}`} aria-expanded={false}><AgentOrb /><span>{title}</span></button>
  </aside>

  return <aside className="agent-dock" aria-label={title}>
    <div className="agent-dock-head">
      <AgentOrb />
      <div className="agent-dock-who">{title}<span>{subtitle}</span></div>
      <button className="agent-dock-toggle" onClick={() => setOpen(false)} aria-label="Collapse conversation" aria-expanded={true} title="Collapse">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" /><line x1="10" y1="2.5" x2="10" y2="13.5" /><path d="M5.5 6 L7.25 8 L5.5 10" /></svg>
      </button>
    </div>
    <div className="agent-dock-body" ref={bodyRef} aria-live="polite">{messages.map((message) => message.role === 'physician'
      ? <div key={message.id} className="agent-msg me">{message.text}</div>
      : <div key={message.id} className="agent-msg agent"><AgentOrb still />
        {message.pending
          ? <div className="agent-typing" role="status" aria-label="Your agent is responding"><i /><i /><i /></div>
          : <div className="agent-msg-body">
            {message.reply?.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            {message.reply?.bullets && message.reply.bullets.length > 0 && <ul>{message.reply.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}
            {message.reply?.link && <div className="agent-msg-card"><div><strong>{message.reply.link.label}</strong><span>{message.reply.link.detail}</span></div><button className="agent-btn primary" onClick={() => navigate(message.reply!.link!.path)}>{message.reply.link.action}</button></div>}
            {message.reply?.cards?.map((card, index) => {
              const key = `${message.id}:${index}`
              const state = cards[key]
              return <div key={key} className="agent-msg-card">
                <div><strong>{card.label}</strong><span>{typeof state === 'object' ? state.error : state === 'done' ? 'Done' : card.detail}</span></div>
                {state === 'done'
                  ? (card.path ? <button className="agent-btn" onClick={() => navigate(card.path!)}>Open</button> : null)
                  : <button className={`agent-btn ${card.execute ? 'primary' : ''}`} disabled={state === 'busy'} onClick={() => void runCard(key, card)}>{state === 'busy' ? 'Working…' : card.action}</button>}
              </div>
            })}
          </div>}
      </div>)}</div>
    {!sent && suggestions.length > 0 && <div className="agent-dock-suggest">{suggestions.map((prompt) => <button key={prompt} onClick={() => void send(prompt)}>{prompt}</button>)}</div>}
    <form className="agent-dock-input" onSubmit={submit}>
      <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder={placeholder} aria-label={title} autoComplete="off" maxLength={2000} />
      <button className="agent-dock-send" aria-label="Send" disabled={busy || !input.trim()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
      </button>
    </form>
  </aside>
}

/** My Agent Overview's copper radiating-rings band (same classes/geometry as the demo). */
export function TrainingReminderBand({ title, support, action }: { title: string; support: string; action?: ReactNode }) {
  return <section className="training-reminder">
    <div className="training-reminder-glyph" aria-hidden="true">
      <span className="training-reminder-ring r1" /><span className="training-reminder-ring r2" /><span className="training-reminder-ring r3" /><span className="training-reminder-ring r4" />
      <span className="training-reminder-spark">✧</span>
    </div>
    <div className="training-reminder-copy">
      <h2>{title}</h2>
      <p className="training-reminder-support">{support}</p>
      {action && <div className="training-reminder-actions">{action}</div>}
    </div>
  </section>
}
