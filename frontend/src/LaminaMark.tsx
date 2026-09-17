import laminaLogo from './assets/lamina-logo-source.png'

/** The same cropped source-logo geometry across Home, My Agent and Network. */
export function LaminaMark({ active = false, resolved = false, directory = false }: { active?: boolean; resolved?: boolean; directory?: boolean }) {
  return <span className={`${directory ? 'directory-network-glyph' : 'network-motif'} ${active ? 'active' : ''} ${resolved ? 'resolved' : ''}`} aria-hidden="true"><span className="motif-logo"><img src={laminaLogo} alt="" /></span></span>
}
