import { useEffect, useRef, useState } from 'react'
import { getAssistantConfirmations, getAssistantToolCalls, getAssistantProvenance } from '../../api/client'
import type { AssistantConfirmation, AssistantToolCall, AssistantProvenance } from '../../types'
import { formatDateTime } from './assistantPresentation'
import { StatusPill } from './AssistantPrimitives'
import { AssistantNotice } from './AssistantUI'

export function AssistantAuditPanel({ activeConversationId }: { activeConversationId: number | null }) {
  const [scope, setScope] = useState<'all' | 'conversation'>(activeConversationId == null ? 'all' : 'conversation')
  const [data, setData] = useState<{ confirmations: AssistantConfirmation[]; calls: AssistantToolCall[]; provenance: AssistantProvenance[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(10)
  const request = useRef(0)
  async function load() {
    const id = ++request.current
    setLoading(true); setError(null)
    try {
      const filter = scope === 'conversation' && activeConversationId != null ? { conversation_id: activeConversationId } : {}
      const [confirmations, calls, provenance] = await Promise.all([getAssistantConfirmations(filter), getAssistantToolCalls(filter), getAssistantProvenance(filter)])
      if (id !== request.current) return
      if (![confirmations, calls, provenance].every(Array.isArray)) throw new Error('Activity records could not be read.')
      setData({ confirmations, calls, provenance })
    } catch (err) { if (id === request.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (id === request.current) setLoading(false) }
  }
  useEffect(() => { setData(null); setLimit(10); void load(); return () => { ++request.current } }, [scope, activeConversationId])
  return <section className="assistant-activity">
    <div className="assistant-section-heading"><h2>Activity</h2><p>Tool calls, confirmations, and recorded provenance.</p></div>
    <div className="my-4 flex flex-wrap gap-2"><button className="assistant-button" aria-pressed={scope === 'conversation'} disabled={activeConversationId == null} onClick={() => setScope('conversation')}>Current chat</button><button className="assistant-button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All records</button><button className="assistant-button" disabled={loading} onClick={() => void load()}>Refresh</button></div>
    {loading && <p className="assistant-muted" role="status">Loading activity…</p>}
    {error && <AssistantNotice retry={() => void load()}>{error}</AssistantNotice>}
    {!loading && !error && data && <div className="grid gap-4">
      {([
        { title: 'Confirmations', rows: data.confirmations, label: (r: AssistantConfirmation) => r.action, status: (r: AssistantConfirmation) => r.status },
        { title: 'Tool calls', rows: data.calls, label: (r: AssistantToolCall) => r.tool_name, status: (r: AssistantToolCall) => r.status },
        { title: 'Provenance', rows: data.provenance, label: (r: AssistantProvenance) => `${r.provider_id || 'Provider unspecified'} · ${r.model || 'Model unspecified'}`, status: () => '' },
      ] as const).map(group => <section key={group.title} className="rounded-[10px] border border-gray-200 p-4"><h3 className="text-sm font-semibold">{group.title} <span className="font-normal text-gray-500">({group.rows.length})</span></h3>
        {!group.rows.length && <p className="assistant-muted mt-3">No {group.title.toLowerCase()} recorded for this scope.</p>}
        {group.rows.slice(0, limit).map(row => <details key={row.id} className="mt-3 border-t border-gray-200 pt-3 text-xs"><summary className="flex cursor-pointer flex-wrap items-center gap-2"><span className="font-mono">#{row.id}</span><span>{(group.label as (record: AssistantConfirmation | AssistantToolCall | AssistantProvenance) => string)(row)}</span>{'status' in row && <StatusPill>{row.status.replace(/_/g, ' ')}</StatusPill>}<span className="text-gray-500">{formatDateTime(row.created_at)}</span></summary><pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-gray-50 p-3 font-mono">{JSON.stringify(row, null, 2)}</pre></details>)}
        {group.rows.length > limit && <button className="assistant-button mt-3" onClick={() => setLimit(n => n + 10)}>Show more records</button>}
      </section>)}
    </div>}
  </section>
}
