import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type ResultsView = 'experiments' | 'batches' | 'jobs'
const views: { value: ResultsView; label: string }[] = [
  { value: 'experiments', label: 'Experiment outcomes' },
  { value: 'batches', label: 'Batches' },
  { value: 'jobs', label: 'Job diagnostics' },
]

export function ResultsTabs({ active, onChange }: { active: ResultsView; onChange: (view: ResultsView) => void }) {
  const [focused, setFocused] = useState(active)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => { setFocused(active) }, [active])
  const reveal = (button: HTMLButtonElement) => {
    const rail = button.parentElement!
    if (button.offsetLeft < rail.scrollLeft) rail.scrollLeft = button.offsetLeft
    else if (button.offsetLeft + button.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = button.offsetLeft + button.offsetWidth - rail.clientWidth
  }
  return <div role="tablist" aria-label="Results views" className="results-tabs">
    {views.map((view, index) => <button key={view.value} ref={node => { buttons.current[index] = node }} type="button"
      role="tab" id={`results-tab-${view.value}`} aria-controls="results-view-panel" aria-selected={active === view.value}
      tabIndex={focused === view.value ? 0 : -1} onFocus={event => { setFocused(view.value); reveal(event.currentTarget) }}
      onClick={() => onChange(view.value)} onKeyDown={event => {
        let next: number | undefined
        if (event.key === 'ArrowRight') next = (index + 1) % views.length
        if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = views.length - 1
        if (next !== undefined) { event.preventDefault(); buttons.current[next]?.focus({ preventScroll: true }) }
      }}>{view.label}</button>)}
  </div>
}

export function ResultsChevron({ expanded = false }: { expanded?: boolean }) {
  return <svg aria-hidden="true" className={`results-chevron ${expanded ? 'results-chevron-open' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg>
}

/** Local portal adaptation: existing owners retain menu and action state. */
export function ResultsActionPopup({ anchor, onClose, label, children, enabled = true, fallbackClassName }: {
  anchor: RefObject<HTMLDivElement>; onClose: () => void; label: string; children: ReactNode; enabled?: boolean; fallbackClassName?: string
}) {
  const popup = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const id = useId()
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const trigger = anchor.current?.querySelector<HTMLButtonElement>('button')
    const node = popup.current
    if (!trigger || !node) return
    trigger.setAttribute('aria-controls', id)
    const update = () => {
      const rect = trigger.getBoundingClientRect()
      const width = node.offsetWidth, height = node.offsetHeight
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      const top = rect.bottom + height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)
      setPosition({ left, top })
    }
    update()
    const focusFrame = window.requestAnimationFrame(() => node.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }))
    const pointer = (event: PointerEvent) => { if (!node.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current() }
    const observer = new IntersectionObserver(entries => { if (!entries[0].isIntersecting) close.current() })
    observer.observe(trigger)
    document.addEventListener('pointerdown', pointer)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => { window.cancelAnimationFrame(focusFrame); trigger.removeAttribute('aria-controls'); observer.disconnect(); document.removeEventListener('pointerdown', pointer); window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true) }
  }, [anchor, enabled, id])
  if (!enabled) return <div className={fallbackClassName}>{children}</div>
  return createPortal(<div ref={popup} id={id} role="group" aria-label={label} className="results-action-popup"
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'Tab') {
      const trigger = anchor.current?.querySelector<HTMLButtonElement>('button')
      const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex="0"]')).filter(node => node.getClientRects().length && !popup.current?.contains(node))
      const next = trigger ? controls[controls.indexOf(trigger) + 1] : undefined
      if (trigger && (event.shiftKey || next)) { event.preventDefault(); close.current(); (event.shiftKey ? trigger : next)?.focus({ preventScroll: true }) }
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); anchor.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }) } }}>{children}</div>, document.body)
}
