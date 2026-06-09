import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  createAssistantConfirmation,
  createAssistantConversation,
  createAssistantMessage,
  executeAssistantTool,
  getAssistantConfirmations,
  getAssistantConversations,
  getAssistantMessages,
  getAssistantProvenance,
  getAssistantToolCalls,
  getConditions,
  getPlatformStatus,
  previewAssistantTool,
  resolveAssistantConfirmation,
  searchGenes,
} from '../../api/client'
import type {
  AssistantToolExecution,
  AssistantToolPreview,
  AssistantToolSpec,
  AssistantConversation,
  AssistantMessage,
  AssistantConfirmation,
  AssistantProvenance,
  AssistantToolCall,
  Condition,
  Gene,
  PlatformStatus,
  ProviderStatus,
} from '../../types'

function StatusPill({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'ready' | 'blocked' | 'planned' }) {
  const classes = {
    neutral: 'border-gray-200 bg-gray-50 text-gray-600',
    ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    blocked: 'border-amber-200 bg-amber-50 text-amber-800',
    planned: 'border-blue-200 bg-blue-50 text-blue-700',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  )
}

function Card({
  title,
  issue,
  children,
}: {
  title: string
  issue: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        <StatusPill tone="planned">{issue}</StatusPill>
      </div>
      {children}
    </section>
  )
}

function ProviderRow({ provider }: { provider: ProviderStatus }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 py-2 last:border-b-0">
      <div>
        <div className="font-medium text-gray-900">{provider.label}</div>
        <div className="text-xs text-gray-500">
          {provider.configuration_hint} Health: {provider.health.replace(/_/g, ' ')}.
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
          <StatusPill tone={provider.runtime_supported ? 'ready' : 'neutral'}>
            {provider.runtime_supported ? 'runtime adapter' : 'status only'}
          </StatusPill>
          {provider.default_model && <StatusPill>{provider.default_model}</StatusPill>}
          {provider.selected_for_runtime && <StatusPill tone="planned">selected</StatusPill>}
        </div>
      </div>
      <StatusPill tone={provider.configured ? 'ready' : 'neutral'}>
        {provider.configured ? 'Configured' : provider.category}
      </StatusPill>
    </div>
  )
}

function ToolRow({ tool }: { tool: AssistantToolSpec }) {
  return (
    <div className="border-b border-gray-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-gray-900">{tool.label}</div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={tool.status.includes('disabled') ? 'blocked' : 'ready'}>
            {tool.status.replace(/_/g, ' ')}
          </StatusPill>
          {tool.requires_confirmation && <StatusPill tone="planned">confirmation</StatusPill>}
          {tool.side_effect && <StatusPill tone="blocked">side effect</StatusPill>}
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-500">{tool.description}</p>
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numericField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberListField(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
}

function ReviewRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gray-100 py-2 last:border-b-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`text-right font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

function ToolReviewPanel({
  title,
  preview,
  execution,
}: {
  title: string
  preview: AssistantToolPreview | null
  execution: AssistantToolExecution | null
}) {
  if (!preview && !execution) return null
  const previewData = asRecord(preview?.preview)
  const experiment = asRecord(execution?.result.experiment)
  const jobIds = numberListField(execution?.result.job_ids)
  const isCreate = preview?.tool_name === 'create_experiment' || execution?.tool_name === 'create_experiment'
  const isRun = preview?.tool_name === 'run_simulation' || execution?.tool_name === 'run_simulation'

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="font-semibold text-gray-900">{title}</div>
        {preview && (
          <StatusPill tone={preview.valid ? 'ready' : 'blocked'}>
            {preview.valid ? 'valid preview' : 'needs attention'}
          </StatusPill>
        )}
      </div>
      {preview && (
        <div className="mt-3">
          <p className="text-sm leading-6 text-gray-600">
            {stringField(previewData.summary) || stringField(previewData.action)}
          </p>
          {preview.warnings.map((warning) => (
            <div key={warning} className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{warning}</div>
          ))}
          {preview.errors.map((error) => (
            <div key={error} className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
          ))}
          <dl className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-3 text-xs">
            {isCreate && (
              <>
                <ReviewRow label="Experiment type" value={stringField(previewData.variant_type) || 'Not selected'} />
                <ReviewRow label="Condition" value={stringField(previewData.condition) || 'Not selected'} mono />
                <ReviewRow label="Time-varying protocol" value={stringField(previewData.timeline) || 'No time-varying protocol'} mono />
                <ReviewRow label="Wildtype control" value={previewData.include_wildtype ? 'Create or reuse' : 'Not requested'} />
              </>
            )}
            {isRun && (
              <>
                <ReviewRow label="Action" value="Queue one simulation job" />
                <ReviewRow label="Experiment" value={stringField(previewData.experiment_name) || 'Selected draft'} />
                <ReviewRow label="Condition" value={stringField(previewData.condition) || 'From experiment'} mono />
              </>
            )}
          </dl>
        </div>
      )}
      {execution && (
        <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className={execution.executed ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}>
            {execution.executed ? 'Completed' : 'Not executed'}: {execution.status.replace(/_/g, ' ')}
          </div>
          {execution.errors.map((error) => (
            <div key={error} className="mt-2 text-xs text-red-700">{error}</div>
          ))}
          {execution.executed && isCreate && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to={`/experiments?experiment=${numericField(experiment.id) ?? ''}`}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Open experiment
              </Link>
              <Link
                to={`/experiments/new?variant=${encodeURIComponent(stringField(experiment.variant_type) || 'gene_knockout')}`}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit similar
              </Link>
            </div>
          )}
          {execution.executed && isRun && jobIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {jobIds.map((jobId) => (
                <Link
                  key={jobId}
                  to={`/results/${jobId}`}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Open job #{jobId}
                </Link>
              ))}
              <Link
                to="/experiments"
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Monitor queue
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GeneSearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (symbol: string) => void
}) {
  const [query, setQuery] = useState(value)
  const [options, setOptions] = useState<Gene[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setQuery(value)
  }, [value])

  useEffect(() => {
    let active = true
    const search = query.trim()
    if (search.length < 1) {
      setOptions([])
      return
    }
    setLoading(true)
    searchGenes(search, 8)
      .then((genes) => {
        if (active) setOptions(genes)
      })
      .catch(() => {
        if (active) setOptions([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [query])

  return (
    <div className="text-sm">
      <label htmlFor="assistant-gene" className="font-medium text-gray-700">Gene</label>
      <input
        id="assistant-gene"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          onChange(event.target.value)
        }}
        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
        placeholder="Search by symbol, synonym, or ID"
      />
      <div className="mt-2 min-h-20 rounded-md border border-gray-100 bg-gray-50 p-2">
        {loading && <div className="px-2 py-1 text-xs text-gray-500">Searching genes...</div>}
        {!loading && options.length === 0 && (
          <div className="px-2 py-1 text-xs text-gray-500">Type a gene symbol, synonym, or EcoCyc ID.</div>
        )}
        {!loading && options.map((gene) => (
          <button
            key={`${gene.ecoli_id}-${gene.symbol}`}
            type="button"
            onClick={() => {
              onChange(gene.symbol)
              setQuery(gene.symbol)
            }}
            className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-white ${gene.symbol === value ? 'bg-white ring-1 ring-brand-200' : ''}`}
          >
            <span>
              <span className="font-mono font-semibold text-bio-gene">{gene.symbol}</span>
              <span className="ml-2 text-gray-500">{gene.ecoli_id}</span>
            </span>
            <span className="text-gray-400">KO #{gene.ko_index || '-'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ConditionSelect({
  value,
  onChange,
  conditions,
  loading,
}: {
  value: string
  onChange: (condition: string) => void
  conditions: Condition[]
  loading: boolean
}) {
  return (
    <label className="text-sm">
      <span className="font-medium text-gray-700">Condition</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
      >
        {conditions.length === 0 && <option value={value}>{loading ? 'Loading conditions...' : value}</option>}
        {conditions.map((condition) => (
          <option key={condition.name} value={condition.name}>
            {condition.name}{condition.nutrients ? ` - ${condition.nutrients}` : ''}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500">
        Pick the saved growth condition the model should use unless the experiment type overrides it internally.
      </p>
    </label>
  )
}

function messageStatusTone(status: string): 'neutral' | 'ready' | 'blocked' | 'planned' {
  if (status === 'completed') return 'ready'
  if (status.includes('failed') || status.includes('no_provider') || status.includes('not_configured')) return 'blocked'
  return 'neutral'
}

function actionStatusTone(status: string): 'neutral' | 'ready' | 'blocked' | 'planned' {
  if (['executed', 'used', 'approved', 'completed'].includes(status)) return 'ready'
  if (['pending', 'pending_confirmation', 'confirmation_required', 'proposed'].includes(status)) return 'planned'
  if (['rejected', 'cancelled', 'failed', 'validation_failed', 'adapter_not_enabled'].includes(status)) return 'blocked'
  return 'neutral'
}

function compactJson(value: unknown, maxLength = 140): string {
  const text = JSON.stringify(value ?? {}, null, 0)
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

function formatDateTime(value: string): string {
  if (!value) return 'not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function AssistantChatPanel({ providerConfigured }: { providerConfigured: boolean }) {
  const location = useLocation()
  const [conversations, setConversations] = useState<AssistantConversation[]>([])
  const [activeConversation, setActiveConversation] = useState<AssistantConversation | null>(null)
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const context = useMemo(() => ({
    route: `${location.pathname}${location.search}`,
    selected_gene: null,
    selected_experiment: null,
    selected_job: null,
    selected_result: null,
    assistant_surface: 'central',
  }), [location.pathname, location.search])

  async function loadConversationMessages(conversation: AssistantConversation) {
    setError(null)
    setActiveConversation(conversation)
    try {
      const rows = await getAssistantMessages(conversation.id)
      setMessages(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadConversations() {
    setLoading(true)
    setError(null)
    try {
      const rows = await getAssistantConversations()
      setConversations(rows)
      if (rows[0]) {
        await loadConversationMessages(rows[0])
      } else {
        setActiveConversation(null)
        setMessages([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConversations()
  }, [])

  async function startNewChat() {
    setError(null)
    setActiveConversation(null)
    setMessages([])
    setInput('')
  }

  async function ensureConversation(content: string): Promise<AssistantConversation> {
    if (activeConversation) return activeConversation
    const title = content.trim().slice(0, 64) || 'Assistant chat'
    const conversation = await createAssistantConversation({
      title,
      assistant_surface: 'central',
      context,
    })
    setActiveConversation(conversation)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    return conversation
  }

  async function sendMessage() {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    setError(null)
    try {
      const conversation = await ensureConversation(content)
      setInput('')
      const exchange = await createAssistantMessage(conversation.id, { content, context })
      setMessages((current) => [...current, exchange.user_message, exchange.assistant_message])
      setActiveConversation(exchange.conversation)
      setConversations((current) => [
        exchange.conversation,
        ...current.filter((item) => item.id !== exchange.conversation.id),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Assistant chat</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Chat receives the current page context and can answer normally. It cannot execute tools, queue simulations, or edit data.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={providerConfigured ? 'ready' : 'blocked'}>
            {providerConfigured ? 'provider configured' : 'no provider'}
          </StatusPill>
          <StatusPill tone="planned">no tool access</StatusPill>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <button
            type="button"
            onClick={startNewChat}
            className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white"
          >
            New chat
          </button>
          <div className="mt-3 max-h-72 space-y-2 overflow-auto">
            {loading && <div className="text-xs text-gray-500">Loading conversations...</div>}
            {!loading && conversations.length === 0 && (
              <div className="text-xs leading-5 text-gray-500">No saved conversations yet.</div>
            )}
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => loadConversationMessages(conversation)}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  activeConversation?.id === conversation.id
                    ? 'border-brand-200 bg-white text-gray-900'
                    : 'border-gray-100 bg-white/70 text-gray-600 hover:bg-white'
                }`}
              >
                <div className="truncate font-medium">{conversation.title}</div>
                <div className="mt-1 text-gray-400">{conversation.status.replace(/_/g, ' ')}</div>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-h-[420px] flex-col rounded-md border border-gray-100">
          <div className="border-b border-gray-100 px-4 py-3">
            <div className="text-sm font-medium text-gray-900">
              {activeConversation?.title ?? 'New assistant conversation'}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              Context: <span className="font-mono">{context.route || '/assistant'}</span>
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-auto bg-gray-50 px-4 py-4">
            {messages.length === 0 && (
              <div className="rounded-md border border-dashed border-gray-200 bg-white p-4 text-sm leading-6 text-gray-500">
                Ask about the current page, a result you are inspecting, or what the platform can safely do next. If no provider is configured,
                the platform will store the message and return a clear no-provider response.
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-md border p-3 ${
                  message.role === 'user'
                    ? 'ml-auto max-w-[82%] border-brand-100 bg-brand-50'
                    : 'mr-auto max-w-[88%] border-gray-200 bg-white'
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {message.role === 'user' ? 'You' : 'Assistant'}
                  </span>
                  <StatusPill tone={messageStatusTone(message.status)}>
                    {message.status.replace(/_/g, ' ')}
                  </StatusPill>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-gray-800">{message.content}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-100 bg-white p-3">
            {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</div>}
            <label htmlFor="assistant-chat-input" className="sr-only">Assistant message</label>
            <textarea
              id="assistant-chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  sendMessage()
                }
              }}
              placeholder="Ask about the selected route or what to inspect next..."
              className="h-24 w-full resize-none rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-800"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-gray-500">Ctrl+Enter sends. Chat cannot perform side effects.</span>
              <button
                type="button"
                onClick={sendMessage}
                disabled={sending || !input.trim()}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function AssistantAuditPanel() {
  const [confirmations, setConfirmations] = useState<AssistantConfirmation[]>([])
  const [toolCalls, setToolCalls] = useState<AssistantToolCall[]>([])
  const [provenance, setProvenance] = useState<AssistantProvenance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function loadAuditTrail() {
    setLoading(true)
    setError(null)
    try {
      const [confirmationRows, toolCallRows, provenanceRows] = await Promise.all([
        getAssistantConfirmations(),
        getAssistantToolCalls(),
        getAssistantProvenance(),
      ])
      setConfirmations(confirmationRows)
      setToolCalls(toolCallRows)
      setProvenance(provenanceRows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAuditTrail()
  }, [])

  const pendingConfirmations = confirmations.filter((item) => item.status === 'pending')
  const recentConfirmations = confirmations.slice(0, 5)
  const recentToolCalls = toolCalls.slice(0, 5)
  const recentProvenance = provenance.slice(0, 5)

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Assistant audit trail</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Review pending confirmations, tool-call records, and provider provenance. This panel is intentionally read-only:
            approvals and execution still happen inside explicit guided flows.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={pendingConfirmations.length > 0 ? 'planned' : 'ready'}>
            {`${pendingConfirmations.length} pending`}
          </StatusPill>
          <button
            type="button"
            onClick={loadAuditTrail}
            disabled={loading}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {loading && <div className="mt-3 text-sm text-gray-500">Loading assistant audit trail...</div>}

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Confirmations</h3>
            <StatusPill>{confirmations.length.toString()}</StatusPill>
          </div>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            User approvals are stored before any side-effecting tool can run.
          </p>
          <div className="mt-3 space-y-2">
            {recentConfirmations.length === 0 && (
              <div className="rounded-md border border-dashed border-gray-200 bg-white p-3 text-xs text-gray-500">
                No confirmations recorded yet.
              </div>
            )}
            {recentConfirmations.map((confirmation) => (
              <div key={confirmation.id} className="rounded-md border border-gray-100 bg-white p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-gray-900">#{confirmation.id} {confirmation.action}</span>
                  <StatusPill tone={actionStatusTone(confirmation.status)}>
                    {confirmation.status.replace(/_/g, ' ')}
                  </StatusPill>
                </div>
                <div className="mt-2 font-mono text-gray-500">{compactJson(confirmation.payload)}</div>
                <div className="mt-2 text-gray-400">{formatDateTime(confirmation.created_at)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Tool calls</h3>
            <StatusPill>{toolCalls.length.toString()}</StatusPill>
          </div>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            Tool records show validation failures, required confirmations, and completed adapter runs.
          </p>
          <div className="mt-3 space-y-2">
            {recentToolCalls.length === 0 && (
              <div className="rounded-md border border-dashed border-gray-200 bg-white p-3 text-xs text-gray-500">
                No tool calls recorded yet.
              </div>
            )}
            {recentToolCalls.map((toolCall) => (
              <div key={toolCall.id} className="rounded-md border border-gray-100 bg-white p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-gray-900">#{toolCall.id} {toolCall.tool_name}</span>
                  <StatusPill tone={actionStatusTone(toolCall.status)}>
                    {toolCall.status.replace(/_/g, ' ')}
                  </StatusPill>
                </div>
                <div className="mt-2 font-mono text-gray-500">{compactJson(toolCall.arguments)}</div>
                <div className="mt-2 text-gray-400">{formatDateTime(toolCall.updated_at || toolCall.created_at)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Provenance</h3>
            <StatusPill>{provenance.length.toString()}</StatusPill>
          </div>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            Provenance records provider/model metadata and sanitized request/response summaries.
          </p>
          <div className="mt-3 space-y-2">
            {recentProvenance.length === 0 && (
              <div className="rounded-md border border-dashed border-gray-200 bg-white p-3 text-xs text-gray-500">
                No provenance records yet.
              </div>
            )}
            {recentProvenance.map((record) => (
              <div key={record.id} className="rounded-md border border-gray-100 bg-white p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-gray-900">#{record.id} {record.provider_id || 'no provider'}</span>
                  <StatusPill>{record.model || 'no model'}</StatusPill>
                </div>
                <div className="mt-2 text-gray-500">
                  Hash <span className="font-mono">{record.prompt_hash.slice(0, 12)}</span>
                </div>
                <div className="mt-2 font-mono text-gray-500">{compactJson(record.response)}</div>
                <div className="mt-2 text-gray-400">{formatDateTime(record.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function AssistantRunFlow() {
  const [gene, setGene] = useState('dnaA')
  const [condition, setCondition] = useState('basal')
  const [conditions, setConditions] = useState<Condition[]>([])
  const [conditionsLoading, setConditionsLoading] = useState(true)
  const [seed, setSeed] = useState(0)
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)
  const [experimentId, setExperimentId] = useState<number | null>(null)
  const [createdDraftKey, setCreatedDraftKey] = useState('')
  const [queuedRunKey, setQueuedRunKey] = useState('')
  const [createPreview, setCreatePreview] = useState<AssistantToolPreview | null>(null)
  const [createExecution, setCreateExecution] = useState<AssistantToolExecution | null>(null)
  const [runPreview, setRunPreview] = useState<AssistantToolPreview | null>(null)
  const [runExecution, setRunExecution] = useState<AssistantToolExecution | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getConditions()
      .then((items) => {
        if (!active) return
        setConditions(items)
        if (!items.some((item) => item.name === condition) && items[0]) {
          setCondition(items[0].name)
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setConditionsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const context = {
    route: '/assistant',
    selected_gene: gene || null,
    selected_experiment: experimentId,
    selected_job: null,
    selected_result: null,
    assistant_surface: 'central',
  }

  const createArguments = {
    name: `${gene || 'selected gene'} knockout`,
    description: 'Assistant-guided draft experiment',
    variant_type: 'gene_knockout',
    variant_index: 0,
    condition,
    timeline: '',
    sim_params: { seeds: 1, generations, length_sec: lengthSec },
    gene_symbol: gene,
    gene_symbols: [],
    include_wildtype: false,
  }

  const draftKey = useMemo(
    () => JSON.stringify(createArguments),
    [gene, condition, generations, lengthSec]
  )
  const runKey = useMemo(
    () => JSON.stringify({ experimentId, seed, generations }),
    [experimentId, seed, generations]
  )
  const hasCurrentDraft = experimentId !== null && createdDraftKey === draftKey
  const hasQueuedCurrentRun = queuedRunKey === runKey

  useEffect(() => {
    setCreatePreview(null)
    setCreateExecution(null)
    setExperimentId(null)
    setCreatedDraftKey('')
    setRunPreview(null)
    setRunExecution(null)
    setQueuedRunKey('')
  }, [draftKey])

  useEffect(() => {
    setRunPreview(null)
    setRunExecution(null)
    setQueuedRunKey('')
  }, [runKey])

  async function previewDraft() {
    setBusy('preview-create')
    setError(null)
    try {
      const preview = await previewAssistantTool('create_experiment', { arguments: createArguments, context })
      setCreatePreview(preview)
      setCreateExecution(null)
      setRunPreview(null)
      setRunExecution(null)
      setExperimentId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function confirmAndCreate() {
    setBusy('execute-create')
    setError(null)
    try {
      const preview = await previewAssistantTool('create_experiment', { arguments: createArguments, context })
      setCreatePreview(preview)
      if (!preview.valid) return
      const confirmation = await createAssistantConfirmation({
        action: 'create_experiment',
        payload: preview.normalized_arguments,
      })
      const approved = await resolveAssistantConfirmation(confirmation.id, {
        status: 'approved',
        note: 'Approved from assistant run flow.',
      })
      const executed = await executeAssistantTool('create_experiment', {
        arguments: createArguments,
        context,
        confirmation_id: approved.id,
      })
      setCreateExecution(executed)
      const experiment = asRecord(executed.result.experiment)
      const id = numericField(experiment.id)
      setExperimentId(id)
      setCreatedDraftKey(draftKey)
      setRunPreview(null)
      setRunExecution(null)
      setQueuedRunKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function previewRun() {
    if (!experimentId || !hasCurrentDraft) {
      setError('Create an experiment draft before previewing the run.')
      return
    }
    setBusy('preview-run')
    setError(null)
    try {
      const preview = await previewAssistantTool('run_simulation', {
        arguments: { experiment_id: experimentId, seed, generations },
        context: { ...context, selected_experiment: experimentId },
      })
      setRunPreview(preview)
      setRunExecution(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function confirmAndQueueRun() {
    if (!experimentId || !hasCurrentDraft) {
      setError('Create an experiment draft before queueing the run.')
      return
    }
    if (hasQueuedCurrentRun) {
      setError('This exact seed/generation run has already been queued from the current draft.')
      return
    }
    setBusy('execute-run')
    setError(null)
    try {
      const runArguments = { experiment_id: experimentId, seed, generations }
      const preview = await previewAssistantTool('run_simulation', {
        arguments: runArguments,
        context: { ...context, selected_experiment: experimentId },
      })
      setRunPreview(preview)
      if (!preview.valid) return
      const confirmation = await createAssistantConfirmation({
        action: 'run_simulation',
        payload: preview.normalized_arguments,
      })
      const approved = await resolveAssistantConfirmation(confirmation.id, {
        status: 'approved',
        note: 'Approved from assistant run flow.',
      })
      const executed = await executeAssistantTool('run_simulation', {
        arguments: runArguments,
        context: { ...context, selected_experiment: experimentId },
        confirmation_id: approved.id,
      })
      setRunExecution(executed)
      if (executed.executed) setQueuedRunKey(runKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Guided run flow</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            This separates the two side effects: first create a reviewed experiment draft, then queue one simulation job from that draft.
          </p>
        </div>
        <StatusPill tone="ready">confirmation bound</StatusPill>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <GeneSearchBox value={gene} onChange={setGene} />
        <ConditionSelect
          value={condition}
          onChange={setCondition}
          conditions={conditions}
          loading={conditionsLoading}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="text-sm">
          <span className="font-medium text-gray-700">Seed</span>
          <input
            type="number"
            min={0}
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">One deterministic replicate index for this guided run.</p>
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700">Generations</span>
          <input
            type="number"
            min={1}
            value={generations}
            onChange={(event) => setGenerations(Number(event.target.value))}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">How many generations the worker should attempt for the queued job.</p>
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700">Max duration (s)</span>
          <input
            type="number"
            min={1}
            value={lengthSec}
            onChange={(event) => setLengthSec(Number(event.target.value))}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">Maximum simulated time allowed for each generation attempt.</p>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={previewDraft}
          disabled={Boolean(busy) || !gene.trim() || !condition.trim()}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Preview draft
        </button>
        <button
          type="button"
          onClick={confirmAndCreate}
          disabled={Boolean(busy) || !gene.trim() || !condition.trim()}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm and create draft
        </button>
        <button
          type="button"
          onClick={previewRun}
          disabled={Boolean(busy) || !hasCurrentDraft}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Preview run
        </button>
        <button
          type="button"
          onClick={confirmAndQueueRun}
          disabled={Boolean(busy) || !hasCurrentDraft || hasQueuedCurrentRun}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm and queue run
        </button>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {busy && <div className="mt-3 text-sm text-gray-500">Working: {busy.replace(/-/g, ' ')}</div>}
      {experimentId && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Draft experiment #{experimentId} is ready for a separately confirmed run.
        </div>
      )}
      {experimentId && !hasCurrentDraft && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          The form changed after draft creation. Create a new draft before queueing a run.
        </div>
      )}
      {hasQueuedCurrentRun && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          This seed/generation run has already been queued from the current draft.
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <ToolReviewPanel title="Experiment draft side effect" preview={createPreview} execution={createExecution} />
        <ToolReviewPanel title="Simulation queue side effect" preview={runPreview} execution={runExecution} />
      </div>
    </section>
  )
}

export function AssistantPage() {
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPlatformStatus()
      .then((data) => {
        if (!cancelled) {
          setStatus(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const configuredProviders = status?.providers.configured_provider_count ?? 0
  const assistantReady = Boolean(status?.assistant.provider_configured && status?.assistant.tool_execution_enabled)
  const toolCount = status?.assistant.tool_registry.length ?? 0

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">Assistant</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Central chat and contextual copilots are scaffolded here. The typed tool harness now supports previews,
            provenance, and confirmation-bound experiment creation and simulation queueing.
          </p>
        </div>
        <StatusPill tone={assistantReady ? 'ready' : 'blocked'}>
          {assistantReady ? 'Ready' : 'Scaffold only'}
        </StatusPill>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Platform status could not be loaded: {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Local-first runtime" issue="#9">
          <p className="text-sm leading-6 text-gray-600">
            The platform should start and run locally through Docker without a hosted backend or paid platform account. Optional
            artifact bootstrap can later download prepared data, seed databases, or precomputed examples.
          </p>
          <div className="mt-4 grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Mode</span>
              <span className="font-medium text-gray-900">{status?.distribution.mode ?? 'local-first'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Runtime</span>
              <span className="font-medium text-gray-900">{status?.distribution.runtime ?? 'Docker Compose'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Hosted backend required</span>
              <span className="font-medium text-gray-900">
                {status?.distribution.requires_hosted_backend ? 'Yes' : 'No'}
              </span>
            </div>
          </div>
          {status?.distribution.notes.map((note) => (
            <p key={note} className="mt-3 text-xs leading-5 text-gray-500">{note}</p>
          ))}
        </Card>

        <Card title="BYOK and local model providers" issue="#10">
          <p className="text-sm leading-6 text-gray-600">
            The app must remain usable without an LLM. Provider configuration should be explicit, local-first, and separate from
            the scientific assistant behavior.
          </p>
          <div className="mt-4 rounded-md border border-gray-100 px-3">
            {(status?.providers.providers ?? []).map((provider) => (
              <ProviderRow key={provider.provider_id} provider={provider} />
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {configuredProviders} provider{configuredProviders === 1 ? '' : 's'} configured in this environment.
          </p>
        </Card>

        <Card title="Typed assistant harness" issue="#11">
          <p className="text-sm leading-6 text-gray-600">
            The assistant should receive validated page context and return messages, tool-call records, proposals, links, and
            pending confirmations. It should not receive direct database, filesystem, Docker, shell, or Python access.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(status?.assistant.context_contract ?? ['route', 'selected_gene', 'selected_experiment', 'selected_job']).map((item) => (
              <StatusPill key={item}>{item}</StatusPill>
            ))}
          </div>
          <div className="mt-4 grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Message persistence</span>
              <span className="font-medium text-gray-900">
                {status?.assistant.db_persistence_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Tool execution</span>
              <span className="font-medium text-gray-900">
                {status?.assistant.tool_execution_enabled ? 'Partial' : 'Disabled'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Side-effect execution</span>
              <span className="font-medium text-gray-900">
                {status?.assistant.side_effect_execution_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Dry-run previews</span>
              <span className="font-medium text-gray-900">
                {status?.assistant.tool_preview_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Registered tools</span>
              <span className="font-medium text-gray-900">{toolCount}</span>
            </div>
          </div>
          <div className="mt-4 text-sm text-gray-600">
            <div className="font-medium text-gray-900">Executable now</div>
            <div className="mt-1">
              {(status?.assistant.execution_enabled_tools ?? []).join(', ') || 'No tools'}
            </div>
          </div>
          <div className="mt-4 text-sm text-gray-600">
            <div className="font-medium text-gray-900">Confirmation required for</div>
            <div className="mt-1">
              {(status?.assistant.confirmation_required_for ?? ['run_simulation', 'publish_condition']).join(', ')}
            </div>
          </div>
        </Card>

        <Card title="Registered tools" issue="#11">
          <p className="text-sm leading-6 text-gray-600">
            Tools are visible to the UI as typed contracts. Dry-run previews can validate arguments and local references.
            Read-only result inspection can execute now, and simulations can be queued only after explicit confirmation.
            Other side-effecting adapters remain disabled.
          </p>
          <div className="mt-4 rounded-md border border-gray-100 px-3">
            {(status?.assistant.tool_registry ?? []).map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </div>
        </Card>

        <AssistantChatPanel providerConfigured={Boolean(status?.assistant.provider_configured)} />

        <AssistantRunFlow />

        <AssistantAuditPanel />

        <Card title="Assistant UI surfaces" issue="#12">
          <p className="text-sm leading-6 text-gray-600">
            This page is the central assistant route. Contextual copilot entry points should later appear in Workspace,
            Conditions Builder, Experiments, Results, ML, and Genome Design after the harness and provider layer are active.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm leading-6 text-gray-600">
            Central chat is now active on this page. Contextual entry points are still pending and should pass richer page state into
            the same message/runtime path.
          </div>
        </Card>
      </div>
    </div>
  )
}
