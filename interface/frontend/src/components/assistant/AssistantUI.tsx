import { useEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'

export function AssistantIcon({ name, size = 18 }: { name: 'history' | 'plus' | 'settings' | 'activity' | 'expand' | 'close' | 'arrow' | 'chat'; size?: number }) {
  const paths = {
    history: 'M4 5h16M4 12h16M4 19h10', plus: 'M12 5v14M5 12h14',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6L7 7m10 10l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
    activity: 'M3 12h4l3-8 4 16 3-8h4', expand: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    close: 'M6 6l12 12M18 6L6 18', arrow: 'M12 19V5m-6 6l6-6 6 6', chat: 'M4 4h16v12H8l-4 4V4z',
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function AssistantNotice({ children, retry, tone = 'error' }: { children: ReactNode; retry?: () => void; tone?: 'error' | 'neutral' }) {
  return <div className={`assistant-notice assistant-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}><span>{children}</span>{retry && <button className="assistant-button" onClick={retry}>Retry</button>}</div>
}

/** Modal-only containment. Portalled model controls remain part of the assistant's focus scope. */
export function useAssistantFocus(panel: RefObject<HTMLElement>, active: boolean, close: () => void, modal = true) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0)
    const id = requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('[data-testid="assistant-input"]') ?? focusables()[0] ?? panel.current)?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="alertdialog"], [data-assistant-overlay]')).some(el => el !== panel.current && !panel.current?.contains(el)) || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); const menu = panel.current?.querySelector<HTMLDetailsElement>('.assistant-history-menu[open], .assistant-help[open]'); if (menu) { menu.open = false; menu.querySelector('summary')?.focus() } else closeRef.current(); return }
      if (!modal || event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); panel.current?.focus(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    const contain = (event: FocusEvent) => {
      if (!modal || Array.from(document.querySelectorAll('[role="alertdialog"], [data-assistant-overlay]')).some(el => el !== panel.current && !panel.current?.contains(el))) return
      if (!panel.current?.contains(event.target as Node)) (focusables()[0] ?? panel.current)?.focus()
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('focusin', contain)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('focusin', contain)
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLButtonElement>('[data-testid="assistant-dock-toggle"]')?.focus()
    }
  }, [active, modal])
}
