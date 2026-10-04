import { useState } from 'react'
import { useAssistant } from './AssistantProvider'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { AssistantNotice } from './AssistantUI'
import type { AssistantConversation } from '../../types'

export function AssistantHistory({ onSelect }: { onSelect?: () => void }) {
  const { conversations, activeConversation, sending, loading, historyError, reloadConversations, loadConversationMessages, renameConversation, removeConversation, startNewChat } = useAssistant()
  const [search, setSearch] = useState('')
  const [rename, setRename] = useState<AssistantConversation | null>(null)
  const [title, setTitle] = useState('')
  const [localError, setLocalError] = useState('')
  const [deleting, setDeleting] = useState<AssistantConversation | null>(null)
  const [busy, setBusy] = useState(false)
  const matching = conversations.filter(c => c.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  async function saveRename() {
    if (!rename || busy) return
    if (!title.trim()) { setLocalError('Enter a conversation name.'); return }
    setBusy(true)
    if (await renameConversation(rename.id, title)) { setRename(null); setLocalError('') }
    else setLocalError('The name could not be saved. Your edit is still here.')
    setBusy(false)
  }
  return <div className="assistant-history">
    <div className="assistant-history-heading"><h2>Conversations</h2><span>{conversations.length}</span></div>
    <button className="assistant-button assistant-button--primary" disabled={sending} onClick={() => { void startNewChat(); onSelect?.() }}>+ New chat</button>
    <label className="assistant-search"><span className="sr-only">Search conversation titles</span><input type="search" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)} /></label>
    {loading && <p role="status" className="assistant-muted">Loading conversations…</p>}
    {historyError && <AssistantNotice retry={() => void reloadConversations()}>{historyError}</AssistantNotice>}
    {!loading && !historyError && !conversations.length && <p className="assistant-muted">No saved conversations yet.</p>}
    {!loading && !historyError && conversations.length > 0 && !matching.length && <p className="assistant-muted">No matching conversations.</p>}
    <div className="assistant-history-list">
      {matching.map(c => <div key={c.id} className="assistant-history-row" data-selected={activeConversation?.id === c.id}>
        {rename?.id === c.id ? <form className="assistant-rename" onSubmit={e => { e.preventDefault(); void saveRename() }}>
          <label className="sr-only" htmlFor={`rename-${c.id}`}>Conversation name</label>
          <input id={`rename-${c.id}`} autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRename(null) } }} />
          <div><button className="assistant-button" disabled={busy || sending}>Save name</button><button type="button" className="assistant-button" disabled={busy} onClick={() => setRename(null)}>Cancel</button></div>
          {localError && <span role="alert">{localError}</span>}
        </form> : <>
          <button className="assistant-history-select" disabled={sending} aria-current={activeConversation?.id === c.id ? 'true' : undefined} onClick={() => { void loadConversationMessages(c); onSelect?.() }}><span>{c.title}</span><small>{activeConversation?.id === c.id ? 'Current chat' : c.status.replace(/_/g, ' ')}</small></button>
          <details className="assistant-history-menu" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.removeAttribute('open'); e.currentTarget.querySelector('summary')?.focus() } }}><summary aria-label={`Actions for ${c.title}`}>···</summary><div>
            <button disabled={sending} aria-label={`Rename ${c.title}`} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setRename(c); setTitle(c.title); setLocalError('') }}>Rename</button>
            <button disabled={sending} aria-label={`Delete ${c.title}`} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDeleting(c) }}>Delete</button>
          </div></details>
        </>}
      </div>)}
    </div>
    <ConfirmDialog open={Boolean(deleting)} title="Delete conversation?" message={`Delete “${deleting?.title ?? ''}” and its saved messages? This cannot be undone.`} confirmLabel="Delete conversation" destructive busy={busy} onCancel={() => setDeleting(null)} onConfirm={async () => { if (!deleting || busy) return; setBusy(true); if (await removeConversation(deleting.id)) setDeleting(null); else setLocalError('Conversation could not be deleted.'); setBusy(false) }} />
    {localError && !rename && <AssistantNotice>{localError}</AssistantNotice>}
  </div>
}
