import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getPlatformStatus } from '../../api/client'
import type { PlatformStatus, ProviderStatus } from '../../types'

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
        <div className="text-xs text-gray-500">{provider.configuration_hint}</div>
      </div>
      <StatusPill tone={provider.configured ? 'ready' : 'neutral'}>
        {provider.configured ? 'Configured' : provider.category}
      </StatusPill>
    </div>
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

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">Assistant</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Central chat and contextual copilots are scaffolded here, but tool execution is disabled until the provider layer,
            typed tool harness, confirmations, and provenance records are implemented.
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
          <div className="mt-4 text-sm text-gray-600">
            <div className="font-medium text-gray-900">Confirmation required for</div>
            <div className="mt-1">
              {(status?.assistant.confirmation_required_for ?? ['run_simulation', 'publish_condition']).join(', ')}
            </div>
          </div>
        </Card>

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
              placeholder="Assistant chat will be enabled after provider configuration, typed tools, confirmations, and provenance are implemented."
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
