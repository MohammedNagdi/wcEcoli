import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAssistant } from './AssistantProvider'
import type { AssistantView } from './AssistantProvider'
import { AssistantConversation } from './AssistantConversation'
import { AssistantHistory } from './AssistantHistory'
import { AssistantProviderSetup } from './AssistantProviderSetup'
import { RuntimeSettingsCard, ConnectionTestCard } from './AssistantSettings'
import { AssistantAuditPanel } from './AssistantActivity'
import { AssistantIcon, AssistantNotice, useAssistantFocus } from './AssistantUI'
import { useNavigationGuard } from '../common/NavigationGuard'
import { ConfirmDialog } from '../common/ConfirmDialog'
import '../../styles/assistant.css'

export function AssistantWorkbench({ dock = false, onClose }: { dock?: boolean; onClose?: () => void }) {
  const a = useAssistant()
  const location = useLocation()
  const navigate = useNavigate()
  const param = new URLSearchParams(location.search).get('assistantView')
  const view: AssistantView = dock ? a.dockView : param === 'settings' || param === 'activity' ? param : 'chat'
  const root = useRef<HTMLDivElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsVisited, setSettingsVisited] = useState(view === 'settings')
  const [settingsVersion, setSettingsVersion] = useState(0)
  const [dirty, setDirty] = useState({ provider: false, runtime: false })
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const hasEdits = dirty.provider || dirty.runtime
  const allowNavigation = useRef(false)
  const blocker = useNavigationGuard(({ currentLocation, nextLocation }) => hasEdits && !allowNavigation.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  useEffect(() => { allowNavigation.current = false }, [location.pathname, location.search])
  const markProvider = useCallback((value: boolean) => setDirty(d => d.provider === value ? d : { ...d, provider: value }), [])
  const markRuntime = useCallback((value: boolean) => setDirty(d => d.runtime === value ? d : { ...d, runtime: value }), [])
  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(entries => setWide(!dock && entries[0].contentRect.width >= 1000))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [dock])
  useEffect(() => { if (wide || view !== 'chat') setHistoryOpen(false); if (view === 'settings') setSettingsVisited(true) }, [wide, view])
  useAssistantFocus(history, historyOpen && !wide, () => setHistoryOpen(false))
  useEffect(() => {
    a.registerLeaveGuard(hasEdits ? leave => setPendingLeave(() => leave) : null)
    const unload = (event: BeforeUnloadEvent) => { if (hasEdits) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => { a.registerLeaveGuard(null); window.removeEventListener('beforeunload', unload) }
  }, [hasEdits, a.registerLeaveGuard, location.pathname, location.search, navigate])
  function applyView(next: AssistantView) {
    if (dock) a.setDockView(next)
    else { const params = new URLSearchParams(location.search); params.set('assistantView', next); navigate({ pathname: '/assistant', search: params.toString(), hash: location.hash }) }
  }
  function leave(action: () => void) { if (hasEdits) setPendingLeave(() => action); else action() }
  function setView(next: AssistantView) { if (next !== view) leave(() => applyView(next)) }
  function fullPage() {
    const params = new URLSearchParams(location.search)
    Object.entries({ route: a.context.route, gene: a.context.selected_gene, experiment: a.context.selected_experiment, job: a.context.selected_job, result: a.context.selected_result, condition: a.context.selected_condition, variant_type: a.context.selected_variant_type, builder_section: a.context.selected_builder_section, surface: a.context.assistant_surface }).forEach(([key, value]) => { if (value != null) params.set(key, String(value)) })
    params.set('assistantView', view)
    leave(() => navigate(`/assistant?${params}`))
  }
  return <div className={`assistant-workbench ${dock ? 'assistant-workbench--dock' : ''}`} ref={root}>
    <header className="assistant-toolbar">
      <h1>Assistant</h1>
      <div className="assistant-toolbar-actions">
        {view === 'chat' && !wide && <button className="assistant-icon-button" aria-label="History" title="History" onClick={() => setHistoryOpen(true)}><AssistantIcon name="history" /></button>}
        <button className="assistant-icon-button" aria-label="New chat" title="New chat (Alt+N)" disabled={a.sending} onClick={() => leave(() => { void a.startNewChat(); applyView('chat') })}><AssistantIcon name="plus" /></button>
        {dock && <button className="assistant-icon-button" aria-label="Open full page" title="Open full page" onClick={fullPage}><AssistantIcon name="expand" /></button>}
        {onClose && <button className="assistant-icon-button" data-testid="assistant-dock-close" aria-label="Close assistant" title="Close assistant (Esc)" onClick={onClose}><AssistantIcon name="close" /></button>}
      </div>
    </header>
    <nav className="assistant-view-nav" aria-label="Assistant views">{(['chat', 'settings', 'activity'] as const).map(item => <button key={item} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}><AssistantIcon name={item} size={16} />{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {dock && view !== 'chat' && <button className="assistant-back" onClick={() => setView('chat')}>← Back to chat</button>}
    <div className="assistant-workbench-body">
      {wide && view === 'chat' && <aside className="assistant-history-rail" aria-label="Conversation history"><AssistantHistory /></aside>}
      {view === 'chat' && <AssistantConversation openSettings={() => setView('settings')} />}
      {settingsVisited && <div className="assistant-secondary" hidden={view !== 'settings'} key={settingsVersion}>
        <div className="assistant-section-heading"><h2>Settings</h2><p>Providers, models, and runtime controls.</p></div>
        {a.statusLoading && <AssistantNotice tone="neutral">Loading provider configuration…</AssistantNotice>}
        {a.statusError && <AssistantNotice retry={() => void a.refreshAssistantStatus()}>{a.statusError}</AssistantNotice>}
        <AssistantProviderSetup configs={a.providerConfigs} runtimeStatus={a.status} loading={a.statusLoading} disabled={a.sending} onDirtyChange={markProvider} onRefresh={a.refreshAssistantStatus} />
        <RuntimeSettingsCard disabled={a.sending} onDirtyChange={markRuntime} />
        <ConnectionTestCard />
      </div>}
      {view === 'activity' && <div className="assistant-secondary"><AssistantAuditPanel activeConversationId={a.activeConversation?.id ?? null} /></div>}
    </div>
    {historyOpen && !wide && createPortal(<div className="assistant-history-backdrop" onClick={() => setHistoryOpen(false)}><div ref={history} data-assistant-overlay="history" className="assistant-history-drawer" role="dialog" aria-modal="true" aria-label="Conversation history" tabIndex={-1} onClick={e => e.stopPropagation()}><header><h2>Conversation history</h2><button className="assistant-icon-button" aria-label="Close history" onClick={() => setHistoryOpen(false)}><AssistantIcon name="close" /></button></header><AssistantHistory onSelect={() => setHistoryOpen(false)} /></div></div>, document.body)}
    <ConfirmDialog open={Boolean(pendingLeave) || blocker.state === 'blocked'} title="Discard unsaved settings?" message="Your provider or runtime changes have not been saved." confirmLabel="Discard changes" onCancel={() => { setPendingLeave(null); if (blocker.state === 'blocked') blocker.reset() }} onConfirm={() => { const action = pendingLeave; allowNavigation.current = true; a.registerLeaveGuard(null); setDirty({ provider: false, runtime: false }); setSettingsVersion(n => n + 1); setPendingLeave(null); if (blocker.state === 'blocked') blocker.proceed(); else action?.() }} />
  </div>
}
