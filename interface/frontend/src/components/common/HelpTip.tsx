import { useState, useRef, useEffect, useLayoutEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Inline help, positioned outside clipping ancestors and inside the viewport. */
export function HelpTip({
  text,
  position = 'top',
  className = '',
}: {
  text: string
  position?: 'top' | 'top-start' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const id = useId()
  const open = !dismissed && (hovered || focused || pinned)

  const enter = () => {
    clearTimeout(leaveTimer.current)
    setDismissed(false)
    setHovered(true)
  }
  const leave = () => {
    clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setHovered(false), 150)
  }
  useEffect(() => () => clearTimeout(leaveTimer.current), [])

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      if (!trigger.current || !popup.current) return
      const anchor = trigger.current.getBoundingClientRect()
      const panel = popup.current.getBoundingClientRect()
      const gutter = 12
      const gap = 8
      const viewport = window.visualViewport
      const x = viewport?.offsetLeft ?? 0
      const y = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      // Visual viewport dimensions also cover mobile keyboards and pinch zoom.
      popup.current.style.maxWidth = `${Math.max(0, width - gutter * 2)}px`
      popup.current.style.maxHeight = `${Math.max(0, height - gutter * 2)}px`
      let left = anchor.left + (anchor.width - panel.width) / 2
      let top = anchor.top - panel.height - gap
      if (position === 'left' || position === 'right') {
        const before = anchor.left - panel.width - gap
        const after = anchor.right + gap
        left = position === 'left' ? before : after
        if (left < x + gutter) left = after
        if (left + panel.width > x + width - gutter) left = before
        top = anchor.top + (anchor.height - panel.height) / 2
      } else {
        const above = anchor.top - panel.height - gap
        const below = anchor.bottom + gap
        top = position === 'bottom' ? below : above
        if (top < y + gutter) top = below
        if (top + panel.height > y + height - gutter) top = above
        if (position === 'top-start') left = anchor.left
      }
      left = Math.max(x + gutter, Math.min(left, x + width - panel.width - gutter))
      top = Math.max(y + gutter, Math.min(top, y + height - panel.height - gutter))
      setPlacement(previous => previous?.left === left && previous?.top === top ? previous : { left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    if (popup.current) observer.observe(popup.current)
    if (trigger.current) observer.observe(trigger.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open, position, text])

  useEffect(() => {
    if (!open) return
    const dismiss = () => {
      setDismissed(true)
      setPinned(false)
      setHovered(false)
    }
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) dismiss()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      trigger.current?.focus({ preventScroll: true })
      dismiss()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        ref={trigger}
        type="button"
        onClick={() => { setDismissed(pinned); setPinned(!pinned) }}
        onPointerEnter={event => { if (event.pointerType === 'mouse') enter() }}
        onPointerLeave={leave}
        onFocus={() => { setDismissed(false); setFocused(true) }}
        onBlur={() => setFocused(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full
                   bg-gray-200 hover:bg-gray-300 text-gray-500 hover:text-gray-700
                   text-[10px] font-bold leading-none transition-colors cursor-help
                   focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        aria-label="More info"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        aria-controls={open ? id : undefined}
      >
        ?
      </button>
      {open && createPortal(
        <span
          ref={popup}
          id={id}
          role="tooltip"
          className="help-tip-popup"
          onPointerEnter={enter}
          onPointerLeave={leave}
          style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, visibility: placement ? 'visible' : 'hidden' }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}

/**
 * A larger contextual note block for section-level explanations.
 */
export function HelpNote({
  children,
  variant = 'info',
}: {
  children: ReactNode
  variant?: 'info' | 'warning' | 'model-depth'
}) {
  const styles: Record<string, string> = {
    info: 'bg-blue-50 border-blue-200 text-blue-700',
    warning: 'bg-amber-50 border-amber-200 text-amber-700',
    'model-depth': 'bg-indigo-50 border-indigo-200 text-indigo-700',
  }

  const icons: Record<string, string> = {
    info: 'i',
    warning: '!',
    'model-depth': '~',
  }

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed flex gap-2 ${styles[variant]}`}>
      <span className="shrink-0 w-4 h-4 rounded-full bg-current/10 flex items-center justify-center text-[10px] font-bold mt-0.5">
        {icons[variant]}
      </span>
      <div>{children}</div>
    </div>
  )
}
