import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Local presentation helpers; scientific state and actions remain with their owners. */
export function ExperimentScrollRegion({ label, children, className = 'experiment-table-wrap', enabled = true, labelWhenDisabled = false }: {
  label: string; children: ReactNode; className?: string; enabled?: boolean; labelWhenDisabled?: boolean
}) {
  const region = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [verticalOverflow, setVerticalOverflow] = useState(false)
  const id = useId()
  useLayoutEffect(() => {
    const node = region.current
    if (!node || !enabled) return
    const measure = () => {
      if (node.clientWidth && node.getClientRects().length) {
        setOverflows(node.scrollWidth > node.clientWidth + 1)
        setVerticalOverflow((node.firstElementChild?.getBoundingClientRect().height ?? 0) > node.clientHeight + 1)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [enabled])
  if (!enabled) return <div className={className} role={labelWhenDisabled ? 'region' : undefined}
    aria-label={labelWhenDisabled ? label : undefined} tabIndex={labelWhenDisabled ? 0 : undefined}>{children}</div>
  return <div className="experiment-scroll-container">
    {overflows && <p id={id} className="experiment-scroll-hint">Scroll horizontally for more information.</p>}
    <div ref={region} className={className} role="region" aria-label={label} aria-describedby={overflows ? id : undefined} tabIndex={0} data-overflow-y={verticalOverflow}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 80 : -80, behavior: 'instant' })
        }
      }}>{children}</div>
  </div>
}

export function ExperimentActionPopup({ anchor, onClose, label, children, enabled = true, fallbackClassName }: {
  anchor: RefObject<HTMLDivElement>; onClose: () => void; label: string; children: ReactNode; enabled?: boolean; fallbackClassName?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const id = useId()
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const trigger = anchor.current?.querySelector<HTMLElement>('button, summary')
    const node = panel.current
    if (!node || !trigger) return
    trigger.setAttribute('aria-controls', id)
    const measure = () => {
      const rect = trigger.getBoundingClientRect()
      const height = node.offsetHeight, width = node.offsetWidth
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.bottom + height + 6 <= innerHeight - 8 ? rect.bottom + 6 : rect.top - height - 6, innerHeight - height - 8)),
      })
    }
    const dismiss = (event: PointerEvent) => {
      if (!node.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
      trigger.focus({ preventScroll: true })
    }
    measure()
    const frame = requestAnimationFrame(() => node.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }))
    const resize = new ResizeObserver(measure)
    resize.observe(node)
    const visible = new IntersectionObserver(entries => { if (!entries[0].isIntersecting) close.current() })
    visible.observe(trigger)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    document.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      visible.disconnect()
      trigger.removeAttribute('aria-controls')
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchor, enabled, id])
  // Retain the fallback contract used by the shared batch card.
  if (!enabled) return <div className={fallbackClassName}>{children}</div>
  return createPortal(<div id={id} ref={panel} role="group" aria-label={label} className="experiment-action-popup"
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}
    onClickCapture={event => {
      // Confirmation dialogs should restore the persistent trigger, not a menu
      // action that is removed as soon as it is activated.
      if ((event.target as Element).closest('button')) anchor.current?.querySelector<HTMLElement>('button, summary')?.focus({ preventScroll: true })
    }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const trigger = anchor.current?.querySelector<HTMLElement>('button, summary')
      const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
        .filter(element => element.getClientRects().length && !panel.current?.contains(element))
      const next = trigger ? controls[controls.indexOf(trigger) + (event.shiftKey ? 0 : 1)] : undefined
      if (next) { event.preventDefault(); close.current(); next.focus({ preventScroll: true }) }
    }}>{children}</div>, document.body)
}

/** Restore both table axes after the narrow inspector temporarily hides its catalog. */
export function useCatalogScrollRestoration(inspecting: boolean, view: string) {
  const saved = useRef(new Map<HTMLElement, { top: number; left: number }>())
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const capture = (event: Event) => {
      const node = event.target
      if (node instanceof HTMLElement && root.current?.getClientRects().length &&
          (root.current.contains(node) || node === root.current.closest('main')) && node.getClientRects().length) {
        saved.current.set(node, { top: node.scrollTop, left: node.scrollLeft })
      }
    }
    const node = root.current
    const main = node?.closest('main')
    const snapshot = () => {
      if (!node?.getClientRects().length) return
      for (const region of [main, ...node.querySelectorAll<HTMLElement>('[role="region"]')]) {
        if (region?.getClientRects().length) saved.current.set(region, { top: region.scrollTop, left: region.scrollLeft })
      }
    }
    node?.addEventListener('scroll', capture, true)
    node?.addEventListener('click', snapshot, true)
    node?.addEventListener('keydown', snapshot, true)
    main?.addEventListener('scroll', capture)
    return () => {
      node?.removeEventListener('scroll', capture, true)
      node?.removeEventListener('click', snapshot, true)
      node?.removeEventListener('keydown', snapshot, true)
      main?.removeEventListener('scroll', capture)
    }
  }, [])
  useLayoutEffect(() => {
    saved.current.forEach((position, node) => {
      if (!node.isConnected) saved.current.delete(node)
      else if (root.current?.getClientRects().length && node.getClientRects().length) { node.scrollTop = position.top; node.scrollLeft = position.left }
    })
  }, [inspecting, view])
  return root
}
