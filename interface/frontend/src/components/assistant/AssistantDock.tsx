import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAssistant } from './AssistantProvider'
import { TaskCenteredAssistantPanel } from './AssistantPage'

/**
 * Global, right-docked Assistant available on every page — summon it instead of navigating to
 * `/assistant`. Reuses the same panel and the shared provider state, so the conversation is
 * continuous whether opened from the dock or the full `/assistant` page. Hidden on `/assistant`
 * itself (the full page is the experience there).
 */
export function AssistantDock() {
  const { isOpen, openAssistant, closeAssistant } = useAssistant()
  const location = useLocation()
  const onAssistantRoute = location.pathname === '/assistant'
  const panelRef = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)

  // Cmd/Ctrl-J toggles the dock (Ctrl-K is the command palette); Esc closes it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        if (onAssistantRoute) return
        e.preventDefault()
        if (isOpen) closeAssistant()
        else openAssistant()
      } else if (e.key === 'Escape' && isOpen) {
        closeAssistant()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onAssistantRoute, openAssistant, closeAssistant])

  // Focus the composer on open; restore focus to the trigger on close.
  useEffect(() => {
    if (onAssistantRoute || !isOpen) return
    lastFocus.current = document.activeElement as HTMLElement
    const t = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')?.focus()
    }, 60)
    return () => {
      window.clearTimeout(t)
      lastFocus.current?.focus?.()
    }
  }, [isOpen, onAssistantRoute])

  if (onAssistantRoute) return null

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          data-testid="assistant-dock-toggle"
          onClick={() => openAssistant()}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition hover:bg-brand-700"
          aria-label="Open assistant (Ctrl+J)"
          title="Open assistant (Ctrl+J)"
        >
          <span aria-hidden>✦</span> Assistant
        </button>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Assistant">
          <div className="absolute inset-0 bg-gray-900/20" onClick={closeAssistant} aria-hidden />
          <aside
            ref={panelRef}
            className="relative flex h-full w-full max-w-5xl flex-col border-l border-gray-200 bg-gray-50 shadow-2xl"
            aria-label="Assistant panel"
          >
            <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2.5">
              <div className="text-sm font-semibold text-gray-900">Assistant</div>
              <div className="flex items-center gap-2">
                <span className="hidden text-[11px] text-gray-500 sm:inline">Esc to close · Ctrl+J to toggle</span>
                <button
                  type="button"
                  data-testid="assistant-dock-close"
                  onClick={closeAssistant}
                  className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-md text-sm text-gray-600 hover:bg-gray-100"
                  aria-label="Close assistant (Esc)"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TaskCenteredAssistantPanel heightClass="h-full" />
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
