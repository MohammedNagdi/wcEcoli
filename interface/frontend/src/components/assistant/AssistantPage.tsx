import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  createAssistantConversation,
  createAssistantMessage,
  executeAssistantTool,
  getAssistantConfirmations,
  getAssistantConversations,
  getAssistantMessages,
  getAssistantProvenance,
  getAssistantToolCalls,
  getPlatformStatus,
  previewAssistantTool,
} from '../../api/client'
import type {
  AssistantToolExecution,
  AssistantToolPreview,
  AssistantToolSpec,
  AssistantConversation,
  AssistantContext,
  AssistantMessage,
  AssistantConfirmation,
  AssistantProvenance,
  AssistantToolCall,
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
  children,
}: {
  title: string
  issue?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
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
  const isInspect = preview?.tool_name === 'inspect_result' || execution?.tool_name === 'inspect_result'
  const resultLinks = Array.isArray(execution?.result.links)
    ? execution.result.links
        .map((item) => asRecord(item))
        .filter((item) => typeof item.label === 'string' && typeof item.path === 'string')
    : []

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
            {isInspect && (
              <>
                <ReviewRow label="Action" value="Inspect result without mutating data" />
                <ReviewRow label="Job status" value={stringField(previewData.status) || 'Selected result'} mono />
                <ReviewRow label="Side effect" value={stringField(previewData.side_effect_if_executed) || 'None'} />
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
          {execution.executed && isInspect && resultLinks.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {resultLinks.map((link) => (
                <Link
                  key={String(link.path)}
                  to={String(link.path)}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  {String(link.label)}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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

function parseOptionalNumber(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function surfaceName(context: AssistantContext): string {
  const route = context.route || ''
  if (context.assistant_surface === 'results' || route.includes('/results')) return 'Results'
  if (context.assistant_surface === 'workspace' || route === '/' || route.includes('workspace')) return 'Workspace'
  if (context.assistant_surface === 'conditions_builder' || route.includes('environment-builder')) return 'Conditions Builder'
  if (context.assistant_surface === 'experiments' || route.includes('/experiments')) return 'Experiments'
  if (context.assistant_surface === 'network' || route.includes('/network')) return 'Network'
  if (context.assistant_surface === 'genome' || route.includes('/genome')) return 'Genome Map'
  return 'Assistant'
}

function contextSummary(context: AssistantContext): string {
  const surface = surfaceName(context)
  if (surface === 'Results') {
    const gene = context.selected_gene ? `${context.selected_gene} ` : ''
    const condition = context.selected_condition ? ` under ${context.selected_condition}` : ''
    const job = context.selected_job != null ? `, Job #${context.selected_job}` : ''
    return `You are viewing ${gene}simulation results${condition}${job}.`
  }
  if (surface === 'Workspace' && context.selected_gene) {
    return `You are inspecting gene ${context.selected_gene} in Workspace.`
  }
  if (surface === 'Conditions Builder') {
    const section = context.selected_builder_section
      ? ` in the ${context.selected_builder_section.replace(/_/g, ' ')} section`
      : ''
    return `You are editing environment inputs${section}.`
  }
  if (surface === 'Experiments') {
    const gene = context.selected_gene ? ` for ${context.selected_gene}` : ''
    const variant = context.selected_variant_type ? ` as ${context.selected_variant_type.replace(/_/g, ' ')}` : ''
    return `You are designing or reviewing an experiment${gene}${variant}.`
  }
  if (context.selected_gene) return `You are focused on gene ${context.selected_gene}.`
  return 'You are in the central Assistant workspace.'
}

function contextFacts(context: AssistantContext): Array<{ label: string; value: string }> {
  const facts = [
    { label: 'Surface', value: surfaceName(context) },
    context.selected_gene ? { label: 'Gene', value: context.selected_gene } : null,
    context.selected_condition ? { label: 'Condition', value: context.selected_condition } : null,
    context.selected_variant_type ? { label: 'Experiment type', value: context.selected_variant_type.replace(/_/g, ' ') } : null,
    context.selected_builder_section ? { label: 'Builder section', value: context.selected_builder_section.replace(/_/g, ' ') } : null,
    context.selected_job != null ? { label: 'Job', value: `#${context.selected_job}` } : null,
    context.selected_experiment != null ? { label: 'Experiment', value: `#${context.selected_experiment}` } : null,
  ]
  return facts.filter((fact): fact is { label: string; value: string } => Boolean(fact))
}

function suggestedActions(context: AssistantContext): Array<{
  title: string
  description: string
  kind: 'read' | 'proposal' | 'link'
  path?: string
}> {
  const surface = surfaceName(context)
  const gene = context.selected_gene
  if (surface === 'Results') {
    return [
      {
        title: 'Inspect current result',
        description: 'Ask the platform to summarize available deterministic outputs for this job.',
        kind: 'read',
      },
      {
        title: 'Compare with WT delta',
        description: 'Prioritize state variables whose final values diverge from the wildtype control.',
        kind: 'proposal',
      },
      {
        title: 'Review linked model states',
        description: 'Check mRNA, monomer, complex, reaction, and metabolite links before interpreting the phenotype.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open linked network',
            description: `Inspect local regulation around ${gene}.`,
            kind: 'link' as const,
            path: `/network?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Workspace' && gene) {
    return [
      {
        title: 'Inspect model state IDs',
        description: `List the mRNA, protein, complex, pathway, and metabolite IDs connected to ${gene}.`,
        kind: 'proposal',
      },
      {
        title: 'Open local TF network',
        description: 'Check whether regulation provides a plausible route to downstream effects.',
        kind: 'link',
        path: `/network?gene=${encodeURIComponent(gene)}`,
      },
      {
        title: 'Draft follow-up knockout',
        description: 'Open the canonical Experiment Designer with this gene preselected.',
        kind: 'link',
        path: `/experiments/new?gene=${encodeURIComponent(gene)}`,
      },
    ]
  }
  if (surface === 'Conditions Builder') {
    return [
      {
        title: 'Review dependency chain',
        description: 'Check stock, recipe, condition, TF-state rules, and time-varying protocol consistency.',
        kind: 'proposal',
      },
      {
        title: 'Validate current draft',
        description: 'Ask for missing IDs, ambiguous fields, and publish-readiness issues.',
        kind: 'proposal',
      },
    ]
  }
  if (surface === 'Experiments') {
    return [
      {
        title: 'Check experiment meaning',
        description: 'Clarify what the selected experiment type changes in the model before saving.',
        kind: 'proposal',
      },
      {
        title: 'Review condition and timeline',
        description: 'Check whether the selected environment is static or uses a time-varying protocol.',
        kind: 'proposal',
      },
    ]
  }
  return [
    {
      title: 'Start from current page',
      description: 'Ask what this page can do, what data it uses, or what to inspect next.',
      kind: 'proposal',
    },
    {
      title: 'Open Experiment Designer',
      description: 'Create or review a simulation through the canonical experiment workflow.',
      kind: 'link',
      path: '/experiments/new',
    },
  ]
}

function FactBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-100 bg-white px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-gray-900">{value}</div>
    </div>
  )
}

function proposalText(proposal: AssistantToolCall, key: string, fallback: string): string {
  const value = proposal.result[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

function proposalKind(proposal: AssistantToolCall): 'ready' | 'planned' {
  return proposal.result.side_effect ? 'planned' : 'ready'
}

function AssistantProposalCard({
  proposal,
  busy,
  onRunReadOnly,
}: {
  proposal: AssistantToolCall
  busy: boolean
  onRunReadOnly: (proposal: AssistantToolCall) => void
}) {
  const title = proposalText(proposal, 'title', proposal.tool_name.replace(/_/g, ' '))
  const description = proposalText(proposal, 'description', 'Review this proposed assistant action.')
  const gene = typeof proposal.arguments.gene_symbol === 'string'
    ? proposal.arguments.gene_symbol
    : typeof proposal.arguments.gene === 'string'
      ? proposal.arguments.gene
      : ''
  const experimentId = typeof proposal.arguments.experiment_id === 'number' ? proposal.arguments.experiment_id : null
  const isReadOnly = proposal.tool_name === 'inspect_result' && !proposal.result.side_effect
  const isCreateExperiment = proposal.tool_name === 'create_experiment'
  const isRunSimulation = proposal.tool_name === 'run_simulation'

  return (
    <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="mt-1 text-xs leading-5 text-gray-500">{description}</div>
        </div>
        <StatusPill tone={proposalKind(proposal)}>
          {proposal.result.side_effect ? 'needs confirmation' : 'read-only'}
        </StatusPill>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {isReadOnly && (
          <button
            type="button"
            onClick={() => onRunReadOnly(proposal)}
            disabled={busy}
            className="rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50"
          >
            {busy ? 'Inspecting...' : 'Run read-only inspection'}
          </button>
        )}
        {isCreateExperiment && (
          <Link
            to={`/experiments/new${gene ? `?gene=${encodeURIComponent(gene)}` : ''}`}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Open Experiment Designer
          </Link>
        )}
        {isRunSimulation && experimentId != null && (
          <Link
            to={`/experiments?experiment=${experimentId}`}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Review experiment
          </Link>
        )}
      </div>
    </div>
  )
}

function AdvancedDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-gray-900">
        {title}
        <span className="ml-2 text-xs font-normal text-gray-500">advanced</span>
      </summary>
      <div className="border-t border-gray-100 p-5">
        {children}
      </div>
    </details>
  )
}

function TaskCenteredAssistantPanel({
  providerConfigured,
  onConversationChange,
}: {
  providerConfigured: boolean
  onConversationChange: (conversationId: number | null) => void
}) {
  const location = useLocation()
  const [conversations, setConversations] = useState<AssistantConversation[]>([])
  const [activeConversation, setActiveConversation] = useState<AssistantConversation | null>(null)
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [proposals, setProposals] = useState<AssistantToolCall[]>([])
  const [input, setInput] = useState('')
  const [inspectPreview, setInspectPreview] = useState<AssistantToolPreview | null>(null)
  const [inspectExecution, setInspectExecution] = useState<AssistantToolExecution | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const context = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return {
      route: params.get('route') || `${location.pathname}${location.search}`,
      selected_gene: params.get('gene') || null,
      selected_experiment: parseOptionalNumber(params.get('experiment')),
      selected_job: parseOptionalNumber(params.get('job')),
      selected_result: parseOptionalNumber(params.get('result')),
      selected_condition: params.get('condition') || null,
      selected_variant_type: params.get('variant_type') || null,
      selected_builder_section: params.get('builder_section') || null,
      assistant_surface: params.get('surface') || 'central',
    }
  }, [location.pathname, location.search])

  const suggestedPrompt = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return params.get('prompt') || ''
  }, [location.search])
  const actionCards = useMemo(() => suggestedActions(context), [context])
  const facts = useMemo(() => contextFacts(context), [context])

  async function loadConversationMessages(conversation: AssistantConversation) {
    setError(null)
    setActiveConversation(conversation)
    onConversationChange(conversation.id)
    try {
      const [rows, proposalRows] = await Promise.all([
        getAssistantMessages(conversation.id),
        getAssistantToolCalls({ conversation_id: conversation.id, status: 'proposed' }),
      ])
      setMessages(rows)
      setProposals(proposalRows)
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
        onConversationChange(null)
        setMessages([])
        setProposals([])
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

  useEffect(() => {
    if (suggestedPrompt && !input.trim() && messages.length === 0) {
      setInput(suggestedPrompt)
    }
  }, [suggestedPrompt, input, messages.length])

  async function startNewChat() {
    setError(null)
    setActiveConversation(null)
    onConversationChange(null)
    setMessages([])
    setProposals([])
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
    onConversationChange(conversation.id)
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
      setProposals(exchange.proposals ?? [])
      setActiveConversation(exchange.conversation)
      onConversationChange(exchange.conversation.id)
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

  async function inspectCurrentResult() {
    if (context.selected_job == null || inspecting) return
    setInspecting(true)
    setError(null)
    try {
      const args = { job_id: context.selected_job, gene: context.selected_gene || '' }
      const preview = await previewAssistantTool('inspect_result', { arguments: args, context })
      setInspectPreview(preview)
      if (!preview.valid) {
        setInspectExecution(null)
        return
      }
      const execution = await executeAssistantTool('inspect_result', { arguments: args, context })
      setInspectExecution(execution)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspecting(false)
    }
  }

  async function runReadOnlyProposal(proposal: AssistantToolCall) {
    if (proposal.tool_name !== 'inspect_result' || inspecting) return
    setInspecting(true)
    setError(null)
    try {
      const preview = await previewAssistantTool(proposal.tool_name, { arguments: proposal.arguments, context })
      setInspectPreview(preview)
      if (!preview.valid) {
        setInspectExecution(null)
        return
      }
      const execution = await executeAssistantTool(proposal.tool_name, {
        arguments: proposal.arguments,
        context,
        conversation_id: activeConversation?.id ?? null,
      })
      setInspectExecution(execution)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspecting(false)
    }
  }

  function useSuggestedAction(title: string) {
    setInput((current) => current.trim() ? current : title)
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 pb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Assistant workspace</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Ask questions, inspect deterministic platform facts, and review proposed next steps. Side-effecting actions still require explicit preview and confirmation.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={providerConfigured ? 'ready' : 'blocked'}>
            {providerConfigured ? 'provider configured' : 'no provider'}
          </StatusPill>
          <StatusPill tone="ready">read-only inspection</StatusPill>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
        <aside className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Conversations</div>
          <button
            type="button"
            onClick={startNewChat}
            className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white"
          >
            New chat
          </button>
          <div className="mt-3 max-h-[520px] space-y-2 overflow-auto">
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

        <div className="flex min-h-[620px] flex-col rounded-md border border-gray-100">
          <div className="border-b border-gray-100 px-4 py-3">
            <div className="text-sm font-medium text-gray-900">
              {activeConversation?.title ?? 'New assistant conversation'}
            </div>
            <div className="mt-1 text-xs leading-5 text-gray-500">{contextSummary(context)}</div>
          </div>

          <div className="flex-1 space-y-3 overflow-auto bg-gray-50 px-4 py-4">
            {(inspectPreview || inspectExecution) && (
              <ToolReviewPanel
                title="Read-only result inspection"
                preview={inspectPreview}
                execution={inspectExecution}
              />
            )}
            {messages.length === 0 && (
              <div className="rounded-md border border-dashed border-gray-200 bg-white p-4 text-sm leading-6 text-gray-500">
                Ask about the current page, a result you are inspecting, or what the platform can safely do next. The assistant can propose actions, but text alone never executes them.
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
              placeholder="Ask what to inspect next, or use a suggested action..."
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

        <aside className="space-y-4 rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="rounded-md border border-brand-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Current context</div>
            <div className="mt-2 text-sm font-medium leading-6 text-gray-900">{contextSummary(context)}</div>
            <div className="mt-3 grid gap-2">
              {facts.map((fact) => (
                <FactBadge key={`${fact.label}-${fact.value}`} label={fact.label} value={fact.value} />
              ))}
            </div>
          </div>

          <div className="rounded-md border border-gray-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Suggested next steps</div>
            <div className="mt-3 space-y-2">
              {actionCards.map((action) => (
                <div key={action.title} className="rounded-md border border-gray-100 bg-gray-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{action.title}</div>
                      <div className="mt-1 text-xs leading-5 text-gray-500">{action.description}</div>
                    </div>
                    <StatusPill tone={action.kind === 'read' ? 'ready' : action.kind === 'link' ? 'neutral' : 'planned'}>
                      {action.kind === 'read' ? 'platform fact' : action.kind === 'link' ? 'open page' : 'proposal'}
                    </StatusPill>
                  </div>
                  <div className="mt-3">
                    {action.kind === 'read' && context.selected_job != null ? (
                      <button
                        type="button"
                        onClick={inspectCurrentResult}
                        disabled={inspecting}
                        className="rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                      >
                        {inspecting ? 'Inspecting...' : 'Run read-only inspection'}
                      </button>
                    ) : action.path ? (
                      <Link
                        to={action.path}
                        className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Open
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => useSuggestedAction(action.title)}
                        className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Ask
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {proposals.length > 0 && (
            <div className="rounded-md border border-blue-100 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Assistant proposals</div>
              <p className="mt-1 text-xs leading-5 text-gray-500">
                These are typed proposal records from the latest exchange. They are not executed by assistant text.
              </p>
              <div className="mt-3 space-y-2">
                {proposals.map((proposal) => (
                  <AssistantProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    busy={inspecting}
                    onRunReadOnly={runReadOnlyProposal}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="rounded-md border border-gray-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Trust boundary</div>
            <div className="mt-2 space-y-2 text-xs leading-5 text-gray-600">
              <div><span className="font-semibold text-gray-900">Platform fact:</span> fetched from deterministic app data or a read-only adapter.</div>
              <div><span className="font-semibold text-gray-900">Assistant interpretation:</span> model-generated explanation that should cite platform facts.</div>
              <div><span className="font-semibold text-gray-900">Proposed action:</span> never executed from text alone.</div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

function AssistantAuditPanel({ activeConversationId }: { activeConversationId: number | null }) {
  const [confirmations, setConfirmations] = useState<AssistantConfirmation[]>([])
  const [toolCalls, setToolCalls] = useState<AssistantToolCall[]>([])
  const [provenance, setProvenance] = useState<AssistantProvenance[]>([])
  const [scope, setScope] = useState<'all' | 'conversation'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function loadAuditTrail() {
    setLoading(true)
    setError(null)
    try {
      const filters = scope === 'conversation' && activeConversationId != null
        ? { conversation_id: activeConversationId }
        : {}
      const [confirmationRows, toolCallRows, provenanceRows] = await Promise.all([
        getAssistantConfirmations(filters),
        getAssistantToolCalls(filters),
        getAssistantProvenance(filters),
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
  }, [scope, activeConversationId])

  useEffect(() => {
    if (activeConversationId == null && scope === 'conversation') {
      setScope('all')
    }
  }, [activeConversationId, scope])

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
          <button
            type="button"
            onClick={() => setScope('all')}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
              scope === 'all'
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            All records
          </button>
          <button
            type="button"
            onClick={() => setScope('conversation')}
            disabled={activeConversationId == null}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
              scope === 'conversation'
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Current chat
          </button>
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
      {scope === 'conversation' && activeConversationId != null && (
        <div className="mt-3 rounded-md border border-brand-100 bg-brand-50 p-3 text-xs text-brand-700">
          Showing records attached to assistant conversation #{activeConversationId}.
        </div>
      )}

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

export function AssistantPage() {
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)

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
            Use the current page context to ask questions, inspect deterministic outputs, and review proposed next steps before anything changes.
          </p>
        </div>
        <StatusPill tone={assistantReady ? 'ready' : 'blocked'}>
          {assistantReady ? 'Ready' : 'Provider needed'}
        </StatusPill>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Platform status could not be loaded: {error}
        </div>
      )}

      <TaskCenteredAssistantPanel
        providerConfigured={Boolean(status?.assistant.provider_configured)}
        onConversationChange={setActiveConversationId}
      />

      <AdvancedDisclosure title="Provider, runtime, and tool settings">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Local-first runtime">
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

          <Card title="BYOK and local model providers">
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

          <Card title="Typed assistant harness">
            <p className="text-sm leading-6 text-gray-600">
              The assistant receives validated page context and returns messages, records, proposals, links, and pending confirmations.
              It does not receive direct database, filesystem, Docker, shell, or Python access.
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
          </Card>

          <Card title="Registered tools">
            <p className="text-sm leading-6 text-gray-600">
              Tools are typed contracts. Dry-run previews validate arguments and local references. Read-only result inspection can
              execute now; side effects require explicit confirmation.
            </p>
            <div className="mt-4 rounded-md border border-gray-100 px-3">
              {(status?.assistant.tool_registry ?? []).map((tool) => (
                <ToolRow key={tool.name} tool={tool} />
              ))}
            </div>
          </Card>
        </div>
      </AdvancedDisclosure>

      <AdvancedDisclosure title="Activity and provenance">
        <AssistantAuditPanel activeConversationId={activeConversationId} />
      </AdvancedDisclosure>
    </div>
  )
}
