import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createAssistantConfirmation,
  executeAssistantTool,
  getPlatformStatus,
  previewAssistantTool,
  resolveAssistantConfirmation,
} from '../../api/client'
import type { AssistantToolExecution, AssistantToolPreview, AssistantToolSpec, PlatformStatus, ProviderStatus } from '../../types'

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

function PreviewPanel({
  title,
  preview,
  execution,
}: {
  title: string
  preview: AssistantToolPreview | null
  execution: AssistantToolExecution | null
}) {
  if (!preview && !execution) return null
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50 p-3 text-xs">
      <div className="font-semibold text-gray-800">{title}</div>
      {preview && (
        <div className="mt-2 space-y-1 text-gray-600">
          <div>{preview.valid ? 'Preview valid' : 'Preview blocked'}</div>
          {preview.warnings.map((warning) => (
            <div key={warning} className="text-amber-700">{warning}</div>
          ))}
          {preview.errors.map((error) => (
            <div key={error} className="text-red-700">{error}</div>
          ))}
          <pre className="mt-2 max-h-36 overflow-auto rounded bg-white p-2 text-[11px] leading-5 text-gray-700">
            {JSON.stringify(preview.preview, null, 2)}
          </pre>
        </div>
      )}
      {execution && (
        <div className="mt-3 space-y-1 text-gray-600">
          <div className={execution.executed ? 'text-emerald-700' : 'text-amber-700'}>
            Execution status: {execution.status}
          </div>
          {execution.errors.map((error) => (
            <div key={error} className="text-red-700">{error}</div>
          ))}
          <pre className="mt-2 max-h-36 overflow-auto rounded bg-white p-2 text-[11px] leading-5 text-gray-700">
            {JSON.stringify(execution.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function AssistantRunFlow() {
  const [gene, setGene] = useState('dnaA')
  const [condition, setCondition] = useState('basal')
  const [seed, setSeed] = useState(0)
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)
  const [experimentId, setExperimentId] = useState<number | null>(null)
  const [createPreview, setCreatePreview] = useState<AssistantToolPreview | null>(null)
  const [createExecution, setCreateExecution] = useState<AssistantToolExecution | null>(null)
  const [runPreview, setRunPreview] = useState<AssistantToolPreview | null>(null)
  const [runExecution, setRunExecution] = useState<AssistantToolExecution | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      setRunPreview(null)
      setRunExecution(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function previewRun() {
    if (!experimentId) {
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
    if (!experimentId) {
      setError('Create an experiment draft before queueing the run.')
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

      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <label className="text-sm">
          <span className="font-medium text-gray-700">Gene</span>
          <input
            value={gene}
            onChange={(event) => setGene(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700">Condition</span>
          <input
            value={condition}
            onChange={(event) => setCondition(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700">Seed</span>
          <input
            type="number"
            min={0}
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2"
          />
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
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={previewDraft}
          disabled={Boolean(busy)}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Preview draft
        </button>
        <button
          type="button"
          onClick={confirmAndCreate}
          disabled={Boolean(busy)}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm and create draft
        </button>
        <button
          type="button"
          onClick={previewRun}
          disabled={Boolean(busy) || !experimentId}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Preview run
        </button>
        <button
          type="button"
          onClick={confirmAndQueueRun}
          disabled={Boolean(busy) || !experimentId}
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

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <PreviewPanel title="Experiment draft side effect" preview={createPreview} execution={createExecution} />
        <PreviewPanel title="Simulation queue side effect" preview={runPreview} execution={runExecution} />
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

        <AssistantRunFlow />

        <Card title="Assistant UI surfaces" issue="#12">
          <p className="text-sm leading-6 text-gray-600">
            This page is the central assistant route. Contextual copilot entry points should later appear in Workspace,
            Conditions Builder, Experiments, Results, ML, and Genome Design after the harness and provider layer are active.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Chat input</label>
            <textarea
              disabled
              value=""
              placeholder="Provider-backed chat is still disabled. Use the guided run flow above to exercise the confirmation-bound tool path."
              className="mt-2 h-24 w-full resize-none rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-500"
            />
            <button
              type="button"
              disabled
              className="mt-3 rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-500"
            >
              Send disabled
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}
