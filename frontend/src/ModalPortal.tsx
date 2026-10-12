import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const MODAL_ROOT_ID = 'lamina-modal-root'

function getModalRoot(): HTMLElement {
  const existing = document.getElementById(MODAL_ROOT_ID)
  if (existing) return existing
  const node = document.createElement('div')
  node.id = MODAL_ROOT_ID
  document.body.appendChild(node)
  return node
}

let openModalCount = 0

function lockBodyScroll() {
  if (openModalCount === 0) document.body.style.overflow = 'hidden'
  openModalCount += 1
}

function unlockBodyScroll() {
  openModalCount = Math.max(0, openModalCount - 1)
  if (openModalCount === 0) document.body.style.overflow = ''
}

/**
 * Mounts its children into a dedicated node appended directly under
 * document.body -- a sibling of #root, not a descendant of it. This is the
 * real fix for modal/chart stacking bugs: once the modal is structurally
 * outside the Patient Detail DOM subtree, nothing inside that subtree
 * (trend-chart SVGs, grid/flex layout, future CSS) can ever paint above it,
 * regardless of z-index or stacking-context details elsewhere in the app.
 * One shared implementation for every full-screen overlay/dialog in Lamina.
 */
export function ModalPortal({ children }: { children: React.ReactNode }) {
  const [root] = useState(getModalRoot)
  useEffect(() => {
    lockBodyScroll()
    return unlockBodyScroll
  }, [])
  return createPortal(children, root)
}
