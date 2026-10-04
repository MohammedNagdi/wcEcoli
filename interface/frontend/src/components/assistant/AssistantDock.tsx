import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAssistant } from './AssistantProvider'
import { AssistantWorkbench } from './AssistantWorkbench'
import { useAssistantFocus } from './AssistantUI'

export function AssistantDock({ besideWorkspace = false }: { besideWorkspace?: boolean }) {
  const a = useAssistant()
  const location = useLocation()
  const onAssistantRoute = location.pathname === '/assistant'
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !a.isOpen && !onAssistantRoute) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="assistant-dock-toggle"]')?.focus())
    wasOpen.current = a.isOpen && !onAssistantRoute
  }, [a.isOpen, onAssistantRoute])
  const panel = useRef<HTMLElement>(null)
  useAssistantFocus(panel, a.isOpen && !onAssistantRoute, a.closeAssistant, !besideWorkspace)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j' && !onAssistantRoute) { event.preventDefault(); if (a.isOpen) a.closeAssistant(); else a.openAssistant() }
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n' && !a.sending) { event.preventDefault(); if (!a.isOpen && !onAssistantRoute) a.openAssistant(); const newChat = document.querySelector<HTMLButtonElement>('.assistant-toolbar button[aria-label="New chat"]'); if (newChat) newChat.click(); else void a.startNewChat() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a.isOpen, a.sending, onAssistantRoute, a.closeAssistant, a.openAssistant, a.startNewChat])
  if (onAssistantRoute) return null
  return <><button hidden={a.isOpen} type="button" data-testid="assistant-dock-toggle" className="assistant-launcher" aria-label="Open assistant (Ctrl+J)" onClick={() => a.openAssistant()}><span aria-hidden="true">✦</span> Assistant</button>
  {a.isOpen && <aside ref={panel} tabIndex={-1} data-testid="assistant-dock" className={besideWorkspace ? 'assistant-side-panel' : 'assistant-modal-panel'} role={besideWorkspace ? 'complementary' : 'dialog'} aria-modal={besideWorkspace ? undefined : true} aria-label="Assistant"><AssistantWorkbench dock onClose={a.closeAssistant} /></aside>}</>
}
