import type { ReactNode } from 'react'

export const BUILDER_SECTIONS = [
  { id: 'builder-overview', label: 'Overview' },
  { id: 'builder-catalog', label: 'Catalog status' },
  { id: 'builder-section-media', label: '1. Medium stock', key: 'media' },
  { id: 'builder-section-mediaRecipe', label: '2. Media recipe', key: 'mediaRecipe' },
  { id: 'builder-section-condition', label: '3. Growth condition', key: 'condition' },
  { id: 'builder-section-tfCondition', label: '4. TF state rules', key: 'tfCondition' },
  { id: 'builder-section-timeline', label: '5. Media protocol', key: 'timeline' },
  { id: 'builder-summary', label: 'Build summary' },
] as const

export function BuilderNavigation({ active, onNavigate, status }: {
  active: string
  onNavigate: (id: string) => void
  status: (key: string) => string
}) {
  return <nav className="builder-navigation" aria-label="On this page">
    <div className="builder-mobile-navigation">
      <label htmlFor="builder-section-menu">Go to section</label>
      <select id="builder-section-menu" value={active} onChange={e => onNavigate(e.target.value)}>
        {BUILDER_SECTIONS.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select>
    </div>
    <div className="builder-desktop-navigation">
      <h2>On this page</h2>
      <ol>{BUILDER_SECTIONS.map(section => <li key={section.id} data-step={'key' in section}>
        <a href={`#${section.id}`} aria-label={section.label + ('key' in section ? ` ${status(section.key)}` : '')} aria-current={active === section.id ? 'location' : undefined}
          onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(section.id) }}>
          {'key' in section ? <span className="builder-step-label"><span className="builder-step-number" aria-hidden="true">{section.label.split('.')[0]}</span><span>{section.label.slice(3)}</span></span> : <span>{section.label}</span>}
          {'key' in section && <small>{status(section.key)}</small>}
        </a>
      </li>)}</ol>
    </div>
  </nav>
}

export function BuilderGuidanceLayout({ guidance, children }: { guidance: ReactNode; children: ReactNode }) {
  return <div className="builder-guidance-layout mt-4">
    <div role="group" aria-label="Guidance" className="builder-guidance">
      <h3>Guidance</h3>{guidance}
    </div>
    <div className="builder-editor space-y-4">{children}</div>
  </div>
}
