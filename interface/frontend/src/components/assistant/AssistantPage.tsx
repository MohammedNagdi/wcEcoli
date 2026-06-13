import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  clearAssistantProviderConfig,
  createAssistantConfirmation,
  createAssistantConversation,
  createAssistantMessage,
  streamAssistantMessage,
  warmAssistantProvider,
  getAssistantMemory,
  clearAssistantMemory,
  dismissAssistantToolCall,
  deleteAssistantConversation,
  executeAssistantTool,
  getAssistantProviderConfigs,
  getAssistantConfirmations,
  getAssistantConversations,
  getAssistantMessages,
  getOllamaModels,
  getAssistantProvenance,
  getAssistantToolCalls,
  getPlatformStatus,
  previewAssistantTool,
  removeAssistantProviderModel,
  resolveAssistantConfirmation,
  testAssistantProviderModel,
  updateAssistantProviderConfig,
} from '../../api/client'
import type {
  AssistantProviderConfig,
  AssistantToolExecution,
  AssistantToolPreview,
  AssistantToolSpec,
  AssistantConversation,
  AssistantContext,
  AssistantExchange,
  AssistantMessage,
  AssistantConfirmation,
  AssistantProvenance,
  AssistantToolCall,
  OllamaModelList,
  PlatformStatus,
  ProviderStatus,
} from '../../types'
import type { AssistantMemory } from '../../api/client'
import { useAssistant } from './AssistantProvider'
import type { ToolResultEntry } from './AssistantProvider'
import { RuntimeSettingsCard, ConnectionTestCard } from './AssistantSettings'

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

function InfoTooltip({ label, text }: { label: string; text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-bold text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-md bg-gray-950 px-3 py-2 text-xs font-normal normal-case leading-5 tracking-normal text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
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
  const selectedButNotConfigured = provider.selected_for_runtime && !provider.configured
  const selectedUnsupported = provider.selected_for_runtime && !provider.runtime_supported
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
          {selectedButNotConfigured && <StatusPill tone="blocked">needs config</StatusPill>}
          {selectedUnsupported && <StatusPill tone="blocked">unsupported chat</StatusPill>}
        </div>
      </div>
      <StatusPill tone={provider.configured ? 'ready' : selectedButNotConfigured || selectedUnsupported ? 'blocked' : 'neutral'}>
        {provider.configured ? 'Configured' : selectedButNotConfigured ? 'Not configured' : provider.category}
      </StatusPill>
    </div>
  )
}

function ProviderRuntimeSummary({ status }: { status: PlatformStatus | null }) {
  const providers = status?.providers
  const assistant = status?.assistant
  const runtimeReady = Boolean(providers?.runtime_ready)
  const toolsReady = Boolean(assistant?.tool_execution_enabled)
  const providerLabel = providers?.active_runtime_provider_id || providers?.selected_provider_id || ''
  return (
    <div className={`rounded-lg border p-4 text-sm ${
      runtimeReady
        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
        : 'border-amber-200 bg-amber-50 text-amber-900'
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold">
            {runtimeReady ? 'Provider-backed chat ready' : 'Provider-backed chat unavailable'}
          </div>
          <p className="mt-1 leading-6">
            {runtimeReady
              ? `Using ${providerLabel}${providers?.active_runtime_model ? ` with ${providers.active_runtime_model}` : ''}. Tool execution remains separated from model text.`
              : providers?.runtime_issue || 'Configure a provider key or local endpoint to enable model-generated answers.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={runtimeReady ? 'ready' : 'blocked'}>
            {runtimeReady ? 'chat ready' : 'chat offline'}
          </StatusPill>
          <StatusPill tone={toolsReady ? 'ready' : 'blocked'}>
            {toolsReady ? 'tools available' : 'tools unavailable'}
          </StatusPill>
        </div>
      </div>
      {!runtimeReady && toolsReady && (
        <p className="mt-2 text-xs leading-5">
          Deterministic inspections and proposal previews can still run; only free-form model answers need a configured provider.
        </p>
      )}
    </div>
  )
}

const FRONTIER_AND_LOCAL_PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Hosted frontier model with your OpenAI API key.',
    defaultModel: '',
    endpointHint: '',
    secretLabel: 'OpenAI API key',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Hosted Claude model with your Anthropic API key.',
    defaultModel: '',
    endpointHint: '',
    secretLabel: 'Anthropic API key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Hosted access to multiple model providers with your OpenRouter API key.',
    defaultModel: '',
    endpointHint: '',
    secretLabel: 'OpenRouter API key',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local model served by Ollama on your machine or network.',
    defaultModel: 'llama3.1',
    endpointHint: 'http://host.docker.internal:11434',
    secretLabel: '',
  },
]

function providerSetupCopy(providerId: string) {
  if (providerId === 'ollama') {
    return {
      secretHelp: 'Ollama does not use an API key here. The backend container must be able to reach the endpoint.',
      modelHelp: 'Use the name of a model already pulled in Ollama, for example llama3.1 or a domain-tuned local model.',
      endpointHelp: 'For Ollama running on the Windows host, host.docker.internal is usually reachable from Docker.',
    }
  }
  return {
    secretHelp: 'The key is stored only in this local wcEcoli database and is never returned by the API.',
    modelHelp: 'Use any chat model available to your provider account. The platform does not restrict this list.',
    endpointHelp: 'Hosted provider endpoint is managed by the backend adapter.',
  }
}

function AssistantProviderSetup({
  configs,
  runtimeStatus,
  loading,
  onRefresh,
}: {
  configs: AssistantProviderConfig[]
  runtimeStatus: PlatformStatus | null
  loading: boolean
  onRefresh: () => Promise<void>
}) {
  const activeConfig = configs.find((config) => config.is_active)
  const initialProvider = activeConfig?.provider_id || runtimeStatus?.providers.active_runtime_provider_id || 'openai'
  const [providerId, setProviderId] = useState(initialProvider)
  const [apiKey, setApiKey] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [endpointUrl, setEndpointUrl] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [ollamaModels, setOllamaModels] = useState<OllamaModelList | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [testingModel, setTestingModel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const selectedTemplate = FRONTIER_AND_LOCAL_PROVIDERS.find((provider) => provider.id === providerId) ?? FRONTIER_AND_LOCAL_PROVIDERS[0]
  const selectedConfig = configs.find((config) => config.provider_id === providerId)
  const selectedStatus = runtimeStatus?.providers.providers.find((provider) => provider.provider_id === providerId)
  const copy = providerSetupCopy(providerId)

  useEffect(() => {
    setProviderId(initialProvider)
  }, [initialProvider])

  useEffect(() => {
    const nextConfig = configs.find((config) => config.provider_id === providerId)
    const template = FRONTIER_AND_LOCAL_PROVIDERS.find((provider) => provider.id === providerId) ?? FRONTIER_AND_LOCAL_PROVIDERS[0]
    setEndpointUrl(nextConfig?.endpoint_url || template.endpointHint)
    setModel(nextConfig?.model || nextConfig?.default_model || template.defaultModel)
    setOllamaModels(null)
    setApiKey('')
    setReplacingKey(false)
    setCustomModel('')
    setMessage(null)
  }, [configs, providerId])

  async function loadOllamaModels(endpoint = endpointUrl) {
    if (providerId !== 'ollama') return
    setLoadingModels(true)
    setMessage(null)
    try {
      const result = await getOllamaModels(endpoint)
      setOllamaModels(result)
      if (result.reachable && result.models.length > 0 && !result.models.some((item) => item.name === model)) {
        setModel(result.models[0].name)
      }
      if (!result.reachable) {
        setMessage(`Could not reach Ollama: ${result.error}`)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (providerId === 'ollama' && endpointUrl) {
      loadOllamaModels(endpointUrl)
    }
  }, [providerId, endpointUrl])

  async function saveProvider() {
    setSaving(true)
    setMessage(null)
    try {
      await updateAssistantProviderConfig(providerId, {
        api_key: providerId === 'ollama' ? '' : apiKey,
        endpoint_url: providerId === 'ollama' ? endpointUrl : '',
        model,
        label: selectedTemplate.label,
        make_active: true,
      })
      await onRefresh()
      setApiKey('')
      setReplacingKey(false)
      setMessage(`${selectedTemplate.label} is now the active assistant provider.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function clearProvider() {
    setSaving(true)
    setMessage(null)
    try {
      await clearAssistantProviderConfig(providerId)
      await onRefresh()
      setMessage(`${selectedTemplate.label} setup was cleared.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function testAndAddModel() {
    const candidate = customModel.trim()
    if (!candidate) return
    setTestingModel(true)
    setMessage(null)
    try {
      const result = await testAssistantProviderModel(providerId, candidate, replacingKey ? apiKey : '')
      if (!result.success) {
        setMessage(`Model test failed: ${result.error}`)
        return
      }
      await onRefresh()
      setModel(candidate)
      setCustomModel('')
      setMessage(result.added ? `${candidate} tested and added.` : `${candidate} tested successfully.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingModel(false)
    }
  }

  async function removeModel(modelId: string) {
    setMessage(null)
    try {
      await removeAssistantProviderModel(providerId, modelId)
      await onRefresh()
      setMessage(`${modelId} removed.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="p-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-950">Assistant provider setup</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Choose the model backend used for assistant text. The model can answer and propose actions, but platform changes still require typed previews and explicit confirmations.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusPill tone={runtimeStatus?.providers.runtime_ready ? 'ready' : 'blocked'}>
            {runtimeStatus?.providers.runtime_ready ? 'active provider ready' : 'setup needed'}
          </StatusPill>
          <span
            className="max-w-xs truncate text-xs text-gray-500"
            title={runtimeStatus?.providers.runtime_ready
              ? `${runtimeStatus.providers.active_runtime_provider_id} (${runtimeStatus.providers.active_runtime_model})`
              : runtimeStatus?.providers.runtime_issue || 'No provider is active yet.'}
          >
            {runtimeStatus?.providers.runtime_ready
              ? `${runtimeStatus.providers.active_runtime_provider_id} · ${runtimeStatus.providers.active_runtime_model}`
              : runtimeStatus?.providers.runtime_issue || 'No active runtime'}
          </span>
          <InfoTooltip
            label="Current runtime help"
            text="Saved credentials are local to this installation. They are used only for assistant chat calls and are not exposed to tools or provenance payloads."
          />
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {FRONTIER_AND_LOCAL_PROVIDERS.map((provider) => {
          const config = configs.find((item) => item.provider_id === provider.id)
          const isSelected = providerId === provider.id
          const isReady = Boolean(config?.configured || runtimeStatus?.providers.providers.find((item) => item.provider_id === provider.id)?.configured)
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => setProviderId(provider.id)}
              className={`rounded-lg border p-4 text-left transition ${
                isSelected ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-blue-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-gray-950">{provider.label}</span>
                <StatusPill tone={config?.is_active ? 'planned' : isReady ? 'ready' : 'neutral'}>
                  {config?.is_active ? 'active' : isReady ? 'saved' : 'not set'}
                </StatusPill>
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-600">{provider.description}</p>
            </button>
          )
        })}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {providerId !== 'ollama' && (
          <div className="block">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {selectedTemplate.secretLabel}
              <InfoTooltip label={`${selectedTemplate.secretLabel} help`} text={copy.secretHelp} />
            </div>
            {selectedConfig?.secret_configured && !replacingKey ? (
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  readOnly
                  aria-label={`${selectedTemplate.secretLabel} saved`}
                  value="••••••••"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm tracking-widest text-gray-700 shadow-sm"
                />
                <button
                  type="button"
                  onClick={() => setReplacingKey(true)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                >
                  Replace key
                </button>
              </div>
            ) : (
              <div className="mt-1 flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste API key"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
                />
                {replacingKey && (
                  <button
                    type="button"
                    onClick={() => { setReplacingKey(false); setApiKey('') }}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {providerId === 'ollama' && (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Ollama endpoint</span>
            <input
              type="text"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder={selectedTemplate.endpointHint}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
            />
            <span className="ml-1 inline-flex"><InfoTooltip label="Ollama endpoint help" text={copy.endpointHelp} /></span>
          </label>
        )}
        {providerId === 'ollama' ? (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Installed model</span>
            <div className="mt-1 flex gap-2">
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
              >
                {model && !ollamaModels?.models.some((item) => item.name === model) && (
                  <option value={model}>{model}</option>
                )}
                {(ollamaModels?.models ?? []).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}{item.parameter_size ? ` · ${item.parameter_size}` : ''}
                  </option>
                ))}
                {(!ollamaModels || ollamaModels.models.length === 0) && (
                  <option value={model || selectedTemplate.defaultModel}>
                    {model || selectedTemplate.defaultModel}
                  </option>
                )}
              </select>
              <button
                type="button"
                onClick={() => loadOllamaModels()}
                disabled={loadingModels}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 disabled:text-gray-300"
              >
                {loadingModels ? 'Checking...' : 'Refresh'}
              </button>
            </div>
            {ollamaModels?.reachable && ollamaModels.models.length > 0 && (
              <span className="mt-1 block text-xs leading-5 text-gray-500">
                Found {ollamaModels.models.length} installed model{ollamaModels.models.length === 1 ? '' : 's'} at {ollamaModels.endpoint_url}.
              </span>
            )}
            {!ollamaModels?.reachable && (
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={selectedTemplate.defaultModel}
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
              />
            )}
            <span className="mt-1 inline-flex"><InfoTooltip label="Installed model help" text={copy.modelHelp} /></span>
          </label>
        ) : (
          <div className="block">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Default model
              <InfoTooltip label="Default model help" text={copy.modelHelp} />
            </div>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
            >
              {(selectedConfig?.models ?? []).map((item) => (
                <option key={item.model_id} value={item.model_id}>{item.model_id}</option>
              ))}
            </select>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder="Add another model identifier"
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={testAndAddModel}
                disabled={testingModel || !customModel.trim()}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 disabled:text-gray-300"
              >
                {testingModel ? 'Testing...' : 'Test and add'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(selectedConfig?.models ?? []).map((item) => (
                <span key={item.model_id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-700">
                  {item.model_id}
                  <button
                    type="button"
                    aria-label={`Remove ${item.model_id}`}
                    onClick={() => removeModel(item.model_id)}
                    disabled={(selectedConfig?.models.length ?? 0) <= 1}
                    className="rounded-full px-1 font-bold text-gray-400 hover:text-red-600 disabled:cursor-not-allowed disabled:text-gray-200"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveProvider}
          disabled={saving || loading}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {saving ? 'Saving...' : `Save and use ${selectedTemplate.label}`}
        </button>
        <button
          type="button"
          onClick={clearProvider}
          disabled={saving || loading || !selectedConfig?.updated_at}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:cursor-not-allowed disabled:text-gray-300"
        >
          Delete configuration
        </button>
        {message && <span className="text-sm text-gray-600">{message}</span>}
      </div>
    </section>
  )
}

const TIER_LABELS: Record<string, { label: string; tone: 'neutral' | 'ready' | 'blocked' | 'planned' }> = {
  read_only: { label: 'read-only', tone: 'ready' },
  draft: { label: 'draft', tone: 'planned' },
  queue: { label: 'queue', tone: 'planned' },
  publish_destructive: { label: 'destructive', tone: 'blocked' },
}

function ToolRow({ tool }: { tool: AssistantToolSpec }) {
  const tier = TIER_LABELS[tool.permission_tier ?? 'read_only']
  return (
    <div className="border-b border-gray-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-gray-900">{tool.label}</div>
        <div className="flex flex-wrap gap-2">
          {tier && <StatusPill tone={tier.tone}>{tier.label}</StatusPill>}
          <StatusPill tone={tool.status.includes('disabled') ? 'blocked' : 'ready'}>
            {tool.status.replace(/_/g, ' ')}
          </StatusPill>
          {tool.requires_confirmation && <StatusPill tone="planned">confirmation</StatusPill>}
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-500">{tool.description}</p>
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// --- Lightweight, dependency-free Markdown for assistant replies --------------
// Renders a safe subset (headers, bold/italic, inline code, code fences, lists,
// links, paragraphs) as React elements — never dangerouslySetInnerHTML, so no XSS.
const MD_INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g

function mdInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  MD_INLINE.lastIndex = 0
  while ((m = MD_INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    // Underscore emphasis (`_x_`, `__x__`) must ignore intraword underscores, or snake_case
    // identifiers like create_experiment / variant_index get pair-matched and mangled. Asterisk
    // emphasis has no such rule. (Boundary chars only — avoids lookbehind for WebKit.)
    const before = m.index > 0 ? text[m.index - 1] : ''
    const after = MD_INLINE.lastIndex < text.length ? text[MD_INLINE.lastIndex] : ''
    const intraword = /\w/.test(before) || /\w/.test(after)
    if (m[2] !== undefined) {
      out.push(<strong key={key++}>{m[2]}</strong>)
    } else if (m[3] !== undefined) {
      intraword ? out.push(m[0]) : out.push(<strong key={key++}>{m[3]}</strong>)
    } else if (m[4] !== undefined) {
      out.push(<em key={key++}>{m[4]}</em>)
    } else if (m[5] !== undefined) {
      intraword ? out.push(m[0]) : out.push(<em key={key++}>{m[5]}</em>)
    } else if (m[6] !== undefined) {
      out.push(<code key={key++} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[12px]">{m[6]}</code>)
    } else if (m[7] !== undefined) {
      const href = m[8]
      const safe = /^(https?:\/\/|\/)/i.test(href)
      out.push(safe
        ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">{m[7]}</a>
        : m[7])
    }
    last = MD_INLINE.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function MessageMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let key = 0
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{mdInline(it)}</li>)
    blocks.push(list.ordered
      ? <ol key={key++} className="my-1 ml-5 list-decimal space-y-0.5">{items}</ol>
      : <ul key={key++} className="my-1 ml-5 list-disc space-y-0.5">{items}</ul>)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      flush()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++ }
      blocks.push(
        <pre key={key++} className="my-1 overflow-x-auto rounded-md bg-gray-900/90 p-2 text-[12px] text-gray-100">
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }
    // GFM table: a row starting with "|" whose next line is a separator (---|---).
    const isTableRow = (l: string) => l.trim().startsWith('|')
    const isSeparator = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-')
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush()
      const splitRow = (l: string) =>
        l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const headers = splitRow(line)
      i += 2 // skip header + separator
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i]) && !isSeparator(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      i-- // the for-loop will re-increment
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} className="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-semibold text-gray-700">{mdInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="border border-gray-200 px-2 py-1 align-top text-gray-700">{mdInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flush()
      blocks.push(
        <div key={key++} className={`${heading[1].length <= 2 ? 'text-sm' : 'text-[13px]'} mt-2 font-semibold text-gray-900`}>
          {mdInline(heading[2])}
        </div>,
      )
      continue
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul) {
      if (!list || list.ordered) { flush(); list = { ordered: false, items: [] } }
      list.items.push(ul[1])
      continue
    }
    if (ol) {
      if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] } }
      list.items.push(ol[1])
      continue
    }
    if (line.trim() === '') { flush(); continue }
    flush()
    blocks.push(<p key={key++} className="my-1 leading-6">{mdInline(line)}</p>)
  }
  flush()
  return <div className="space-y-0.5">{blocks}</div>
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
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className={`min-w-0 break-words [overflow-wrap:anywhere] text-right font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

function ToolReviewPanel({
  title,
  preview,
  execution,
  embedded = false,
}: {
  title: string
  preview: AssistantToolPreview | null
  execution: AssistantToolExecution | null
  embedded?: boolean
}) {
  if (!preview && !execution) return null
  const previewData = asRecord(preview?.preview)
  const experiment = asRecord(execution?.result.experiment)
  const jobIds = numberListField(execution?.result.job_ids)
  const isCreate = preview?.tool_name === 'create_experiment' || execution?.tool_name === 'create_experiment'
  const isRun = preview?.tool_name === 'run_simulation' || execution?.tool_name === 'run_simulation'
  const isInspect = preview?.tool_name === 'inspect_result' || execution?.tool_name === 'inspect_result'
  const isInspectGene = preview?.tool_name === 'inspect_gene' || execution?.tool_name === 'inspect_gene'
  const previewGene = asRecord(previewData.gene)
  const executionGene = asRecord(execution?.result.gene)
  const resultLinks = Array.isArray(execution?.result.links)
    ? execution.result.links
        .map((item) => asRecord(item))
        .filter((item) => typeof item.label === 'string' && typeof item.path === 'string')
    : []

  return (
    <div className={embedded ? 'text-sm' : 'overflow-hidden rounded-md border border-gray-200 bg-white p-4 text-sm'}>
      {!embedded && (
        <div className="flex items-center justify-between gap-3">
          <div className="font-semibold text-gray-900">{title}</div>
          {preview && (
            <StatusPill tone={preview.valid ? 'ready' : 'blocked'}>
              {preview.valid ? 'valid preview' : 'needs attention'}
            </StatusPill>
          )}
        </div>
      )}
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
                <ReviewRow label="Gene" value={stringField(previewData.gene_symbol) || 'Not selected'} mono />
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
            {isInspectGene && (
              <>
                <ReviewRow label="Action" value="Read Genes Table metadata" />
                <ReviewRow label="Gene" value={stringField(previewGene.symbol) || stringField(executionGene.symbol) || 'Selected gene'} mono />
                <ReviewRow label="Category" value={stringField(previewGene.category) || stringField(executionGene.category) || 'Not cataloged'} />
                <ReviewRow label="KO index" value={String(previewGene.ko_index ?? executionGene.ko_index ?? 'n/a')} mono />
                <ReviewRow label="Protein" value={stringField(previewGene.monomer_id) || stringField(executionGene.monomer_id) || 'No linked protein'} mono />
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
          {execution.executed && (isInspect || isInspectGene) && resultLinks.length > 0 && (
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

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  sending: 'sending',
  failed: 'failed to send',
  provider_call_failed: 'provider error',
  no_provider_configured: 'no provider',
  selected_provider_not_configured: 'provider not configured',
  provider_not_supported: 'unsupported provider',
}

function messageStatusLabel(status: string): string {
  return MESSAGE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
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
  if (context.assistant_surface === 'ml' || route.includes('/ml')) return 'Machine Learning'
  if (context.assistant_surface === 'design' || route.includes('/design')) return 'Genome Design'
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
  if (surface === 'Network') {
    const gene = context.selected_gene ? ` focused on ${context.selected_gene}` : ''
    return `You are inspecting the transcription-factor network${gene}.`
  }
  if (surface === 'Genome Map') {
    const gene = context.selected_gene ? ` focused on ${context.selected_gene}` : ''
    return `You are inspecting the chromosome map${gene}.`
  }
  if (surface === 'Machine Learning') {
    const condition = context.selected_condition ? ` for ${context.selected_condition}` : ''
    const variant = context.selected_variant_type ? ` and ${context.selected_variant_type.replace(/_/g, ' ')}` : ''
    return `You are reviewing simulation-derived ML readiness${condition}${variant}.`
  }
  if (surface === 'Genome Design') {
    return 'You are reviewing simulation-derived genome-design summaries.'
  }
  if (context.selected_gene) return `You are focused on gene ${context.selected_gene}.`
  return 'You are in the central Assistant workspace.'
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
  if (surface === 'Network') {
    return [
      {
        title: 'Explain edge provenance',
        description: 'Clarify that TF edges are reconstruction-derived and not simulation-response overlays.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open selected gene in Workspace',
            description: `Review model state IDs and genomic context for ${gene}.`,
            kind: 'link' as const,
            path: `/?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Genome Map') {
    return [
      {
        title: 'Interpret genomic context',
        description: 'Relate selected gene position, nearby genes, strand, and functional category to other Explore views.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open linked network',
            description: `Check regulation around ${gene}.`,
            kind: 'link' as const,
            path: `/network?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Machine Learning') {
    return [
      {
        title: 'Assess data readiness',
        description: 'Check whether completed simulations are broad enough for the selected target and filters.',
        kind: 'proposal',
      },
      {
        title: 'Open result library',
        description: 'Review source simulations before trusting surrogate-model output.',
        kind: 'link',
        path: '/results',
      },
    ]
  }
  if (surface === 'Genome Design') {
    return [
      {
        title: 'Check design evidence',
        description: 'Separate current knockout summaries from what would be needed for a dedicated minimal-genome design workflow.',
        kind: 'proposal',
      },
      {
        title: 'Open batch experiments',
        description: 'Plan condition-diverse knockout coverage before interpreting design calls.',
        kind: 'link',
        path: '/experiments/batch',
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

function starterPrompts(context: AssistantContext): string[] {
  const prompts: string[] = []
  if (context.selected_gene) {
    prompts.push(`Tell me about ${context.selected_gene} and its regulators`)
    prompts.push(`Draft a ${context.selected_gene} knockout experiment`)
  }
  if (context.selected_job != null) {
    prompts.push('Inspect the current result and summarize growth')
  }
  if (context.selected_experiment != null) {
    prompts.push('Summarize this experiment and its runs')
  }
  prompts.push('How many genes are supported?')
  prompts.push('Explain what each page does')
  return prompts.slice(0, 4)
}

const CONFIRM_BUTTON_LABELS: Record<string, string> = {
  run_simulation: 'Confirm and queue',
  save_condition: 'Save condition draft',
  save_timeline: 'Save timeline draft',
  save_recipe: 'Save recipe draft',
  save_tf_condition: 'Save TF rule draft',
}

function confirmButtonLabel(toolName: string): string {
  return CONFIRM_BUTTON_LABELS[toolName] ?? 'Create draft experiment'
}

function proposalText(proposal: AssistantToolCall, key: string, fallback: string): string {
  const value = proposal.result[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

function proposalKind(proposal: AssistantToolCall): 'ready' | 'planned' {
  return proposal.result.side_effect ? 'planned' : 'ready'
}

function proposalSourceLabel(proposal: AssistantToolCall): string {
  const source = stringField(proposal.result.source)
  if (source === 'model_gene_mention') return 'model suggestion, gene validated'
  if (source === 'contextual_assistant') return 'current page context'
  return source ? source.replace(/_/g, ' ') : 'assistant proposal'
}

function proposalFactRows(proposal: AssistantToolCall): Array<{ label: string; value: string; mono?: boolean }> {
  if (proposal.tool_name === 'create_experiment') {
    const gene = stringField(proposal.arguments.gene_symbol)
    const condition = stringField(proposal.arguments.condition) || 'basal'
    const variant = stringField(proposal.arguments.variant_type).replace(/_/g, ' ') || 'experiment'
    const timeline = stringField(proposal.arguments.timeline) || 'No time-varying protocol'
    const includeWildtype = proposal.arguments.include_wildtype === true
    return [
      { label: 'Validated gene', value: gene || 'Not selected', mono: Boolean(gene) },
      { label: 'Draft type', value: variant },
      { label: 'Condition', value: condition, mono: true },
      { label: 'Protocol', value: timeline, mono: timeline !== 'No time-varying protocol' },
      { label: 'Wildtype control', value: includeWildtype ? 'Create or reuse if available' : 'Not requested' },
    ]
  }
  if (proposal.tool_name === 'run_simulation') {
    return [
      { label: 'Experiment', value: String(proposal.arguments.experiment_id ?? 'Not selected'), mono: true },
      { label: 'Seed', value: String(proposal.arguments.seed ?? 0), mono: true },
      { label: 'Generations', value: String(proposal.arguments.generations ?? 1), mono: true },
    ]
  }
  if (proposal.tool_name === 'save_condition') {
    const activeTfs = Array.isArray(proposal.arguments.active_tfs) ? (proposal.arguments.active_tfs as string[]) : []
    const inactiveTfs = Array.isArray(proposal.arguments.inactive_tfs) ? (proposal.arguments.inactive_tfs as string[]) : []
    return [
      { label: 'Condition name', value: stringField(proposal.arguments.name) || 'Unnamed', mono: true },
      { label: 'Media recipe', value: stringField(proposal.arguments.nutrients) || 'Not set', mono: true },
      { label: 'Doubling time', value: `${String(proposal.arguments.doubling_time ?? '?')} min` },
      { label: 'Active TFs', value: activeTfs.length ? activeTfs.join(', ') : 'None', mono: activeTfs.length > 0 },
      { label: 'Inactive TFs', value: inactiveTfs.length ? inactiveTfs.join(', ') : 'None', mono: inactiveTfs.length > 0 },
      { label: 'Cloned from', value: stringField(proposal.arguments.base_condition) || 'New condition', mono: Boolean(proposal.arguments.base_condition) },
    ]
  }
  if (proposal.tool_name === 'save_timeline') {
    return [
      { label: 'Timeline name', value: stringField(proposal.arguments.name) || 'Unnamed', mono: true },
      { label: 'Schedule', value: stringField(proposal.arguments.events) || '(empty)', mono: true },
    ]
  }
  if (proposal.tool_name === 'save_recipe') {
    const ingredients = Array.isArray(proposal.arguments.ingredients) ? (proposal.arguments.ingredients as string[]) : []
    return [
      { label: 'Recipe id', value: stringField(proposal.arguments.media_id) || 'Unnamed', mono: true },
      { label: 'Base medium', value: stringField(proposal.arguments.base_media) || 'Not set', mono: true },
      { label: 'Added medium', value: stringField(proposal.arguments.added_media) || 'None', mono: Boolean(proposal.arguments.added_media) },
      { label: 'Ingredients', value: ingredients.length ? ingredients.join(', ') : 'None', mono: ingredients.length > 0 },
    ]
  }
  if (proposal.tool_name === 'save_tf_condition') {
    return [
      { label: 'TF', value: stringField(proposal.arguments.tf) || 'Not set', mono: true },
      { label: 'Active on', value: stringField(proposal.arguments.active_nutrients) || 'Not set', mono: true },
      { label: 'Inactive on', value: stringField(proposal.arguments.inactive_nutrients) || 'Not set', mono: true },
      { label: 'TF type', value: stringField(proposal.arguments.tf_type) || 'Not set' },
    ]
  }
  if (proposal.tool_name === 'inspect_result') {
    return [
      { label: 'Job', value: String(proposal.arguments.job_id ?? 'Current result'), mono: true },
      { label: 'Gene', value: stringField(proposal.arguments.gene) || 'Current context', mono: Boolean(proposal.arguments.gene) },
      { label: 'Side effect', value: 'None' },
    ]
  }
  if (proposal.tool_name === 'inspect_gene') {
    return [
      { label: 'Gene', value: stringField(proposal.arguments.gene) || 'Current context', mono: Boolean(proposal.arguments.gene) },
      { label: 'Data source', value: 'Genes Table' },
      { label: 'Side effect', value: 'None' },
    ]
  }
  return []
}

function AssistantProposalCard({
  proposal,
  context,
  conversationId,
  busy,
  onRunReadOnly,
  onResolved,
}: {
  proposal: AssistantToolCall
  context: AssistantContext
  conversationId: number | null
  busy: boolean
  onRunReadOnly: (proposal: AssistantToolCall) => void
  onResolved: (proposalId: number, outcome: 'executed' | 'rejected') => void
}) {
  const [preview, setPreview] = useState<AssistantToolPreview | null>(null)
  const [execution, setExecution] = useState<AssistantToolExecution | null>(null)
  const [confirmation, setConfirmation] = useState<AssistantConfirmation | null>(null)
  const [cardBusy, setCardBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = proposalText(proposal, 'title', proposal.tool_name.replace(/_/g, ' '))
  const description = proposalText(proposal, 'description', 'Review this proposed assistant action.')
  const gene = typeof proposal.arguments.gene_symbol === 'string'
    ? proposal.arguments.gene_symbol
    : typeof proposal.arguments.gene === 'string'
      ? proposal.arguments.gene
      : ''
  const experimentId = typeof proposal.arguments.experiment_id === 'number' ? proposal.arguments.experiment_id : null
  const isReadOnly = (proposal.tool_name === 'inspect_result' || proposal.tool_name === 'inspect_gene') && !proposal.result.side_effect
  const isCreateExperiment = proposal.tool_name === 'create_experiment'
  const isRunSimulation = proposal.tool_name === 'run_simulation'
  const isSideEffect = Boolean(proposal.result.side_effect)
  const canConfirm = isSideEffect && preview?.valid && !execution?.executed && confirmation?.status !== 'rejected'
  const facts = proposalFactRows(proposal)

  async function previewProposal() {
    setCardBusy('preview')
    setError(null)
    try {
      const nextPreview = await previewAssistantTool(proposal.tool_name, { arguments: proposal.arguments, context })
      setPreview(nextPreview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCardBusy(null)
    }
  }

  async function rejectProposal() {
    if (!preview?.valid || !isSideEffect) {
      onResolved(proposal.id, 'rejected')
      return
    }
    setCardBusy('reject')
    setError(null)
    try {
      const pending = await createAssistantConfirmation({
        action: proposal.tool_name,
        payload: preview.normalized_arguments,
        conversation_id: conversationId,
        tool_call_id: proposal.id,
      })
      await resolveAssistantConfirmation(pending.id, {
        status: 'rejected',
        note: 'Rejected from assistant proposal card.',
      })
      onResolved(proposal.id, 'rejected')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCardBusy(null)
    }
  }

  async function confirmAndExecuteProposal() {
    if (!preview?.valid || !isSideEffect || cardBusy) return
    setCardBusy('execute')
    setError(null)
    try {
      const pending = await createAssistantConfirmation({
        action: proposal.tool_name,
        payload: preview.normalized_arguments,
        conversation_id: conversationId,
        tool_call_id: proposal.id,
      })
      const approved = await resolveAssistantConfirmation(pending.id, {
        status: 'approved',
        note: 'Approved from assistant proposal card.',
      })
      setConfirmation(approved)
      const result = await executeAssistantTool(proposal.tool_name, {
        arguments: proposal.arguments,
        context,
        conversation_id: conversationId,
        confirmation_id: approved.id,
      })
      setExecution(result)
      if (result.executed) {
        onResolved(proposal.id, 'executed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCardBusy(null)
    }
  }

  return (
    <div data-testid="proposal-card" data-tool={proposal.tool_name} className="rounded-md border border-gray-100 bg-gray-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold text-gray-900">{title}</div>
          <div className="mt-1 break-words text-xs leading-5 text-gray-500">{description}</div>
        </div>
        <StatusPill tone={proposalKind(proposal)}>
          {proposal.result.side_effect ? 'needs confirmation' : 'read-only'}
        </StatusPill>
      </div>
      {facts.length > 0 && !preview && (
        <dl className="mt-3 grid gap-2 rounded-md border border-gray-100 bg-white p-3 text-xs sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={`${proposal.id}-${fact.label}`} className="min-w-0">
              <dt className="font-semibold uppercase tracking-wide text-gray-500">{fact.label}</dt>
              <dd className={`mt-1 truncate text-gray-800 ${fact.mono ? 'font-mono' : ''}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill tone="neutral">{proposalSourceLabel(proposal)}</StatusPill>
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
        {isSideEffect && (
          <button
            type="button"
            data-testid="proposal-preview"
            onClick={previewProposal}
            disabled={Boolean(cardBusy)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {cardBusy === 'preview' ? 'Previewing...' : preview ? 'Refresh preview' : isCreateExperiment ? 'Preview draft' : 'Preview'}
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
      {preview && (
        <div className="mt-3 rounded-md border border-gray-100 bg-white p-3">
          <ToolReviewPanel title="Proposal preview" preview={preview} execution={execution} embedded />
        </div>
      )}
      {isSideEffect && preview && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="proposal-confirm"
            onClick={confirmAndExecuteProposal}
            disabled={!canConfirm || Boolean(cardBusy)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {cardBusy === 'execute' ? 'Executing...' : confirmButtonLabel(proposal.tool_name)}
          </button>
          <button
            type="button"
            data-testid="proposal-reject"
            onClick={rejectProposal}
            disabled={Boolean(cardBusy) || confirmation?.status === 'rejected' || Boolean(execution?.executed)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {cardBusy === 'reject' ? 'Rejecting...' : 'Reject'}
          </button>
          {confirmation && (
            <StatusPill tone={confirmation.status === 'approved' || confirmation.status === 'used' ? 'ready' : confirmation.status === 'rejected' ? 'blocked' : 'planned'}>
              {confirmation.status}
            </StatusPill>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
      )}
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

/** Collapsible "thinking" trail — the model's reasoning before each tool call (Claude/ChatGPT style). */
function ThinkingBlock({ segments, live = false }: { segments: string[]; live?: boolean }) {
  if (segments.length === 0) return null
  return (
    <div className="flex justify-start">
      <details className="max-w-[80%] rounded-xl border border-gray-200 bg-gray-50/70" open={live}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-gray-500">
          {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" />}
          <span>{live ? 'Thinking…' : `Thought process · ${segments.length} step${segments.length === 1 ? '' : 's'}`}</span>
        </summary>
        <div className="space-y-2 border-t border-gray-200 px-3 py-2">
          {segments.map((seg, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-xs italic leading-5 text-gray-500">{seg}</p>
          ))}
        </div>
      </details>
    </div>
  )
}

// --- Grounded tool-result cards: render read-only adapter output verbatim, so the data is correct
// even when the model paraphrases it wrong. Sourced from the tool JSON, not the model's prose. ---

type GroundedColumn = { key: string; label: string; mono?: boolean }
type GroundedField = { key: string; label: string }
type GroundedSection = { label: string; arrayKey: string; columns: GroundedColumn[] }
type GroundedSpec =
  | { label: string; mode: 'table'; arrayKey: string; columns: GroundedColumn[] }
  | { label: string; mode: 'totals'; totalsKey: string }
  | { label: string; mode: 'fields'; objectKey: string; fields: GroundedField[] }
  | { label: string; mode: 'multi'; sections: GroundedSection[] }

const M = (k: string, l: string) => ({ key: k, label: l, mono: true })

// Every read-only DATA adapter renders an authoritative card. Prose tools (platform_guide,
// explain_modeling) intentionally stay as the model's narration — they have no tabular ground truth.
const GROUNDED_TOOLS: Record<string, GroundedSpec> = {
  list_results: {
    label: 'Completed results', mode: 'table', arrayKey: 'results',
    columns: [M('job_id', 'Job'), { key: 'experiment_name', label: 'Experiment' }, M('condition', 'Condition'),
      M('gene_symbol', 'Gene'), M('metrics.growth_rate.mean', 'Growth rate'), M('metrics.doubling_time_min.mean', 'Doubling (min)')],
  },
  compare_results: {
    label: 'Result comparison', mode: 'table', arrayKey: 'comparison',
    columns: [M('job_id', 'Job'), { key: 'experiment_name', label: 'Experiment' }, M('condition', 'Condition'),
      M('metrics.growth_rate.mean', 'Growth rate'), M('metrics.doubling_time_min.mean', 'Doubling (min)'), M('metrics.final_mass_fg.mean', 'Final mass (fg)')],
  },
  list_conditions: {
    label: 'Conditions', mode: 'table', arrayKey: 'conditions',
    columns: [M('name', 'Condition'), M('nutrients', 'Nutrients'), M('doubling_time', 'Doubling'), M('active_tfs', 'Active TFs'), M('inactive_tfs', 'Inactive TFs')],
  },
  list_experiments: {
    label: 'Experiments', mode: 'table', arrayKey: 'experiments',
    columns: [M('id', 'ID'), { key: 'name', label: 'Name' }, { key: 'variant_type', label: 'Type' }, M('gene_symbol', 'Gene'), M('condition', 'Condition'), { key: 'status', label: 'Status' }],
  },
  inspect_experiment: {
    label: 'Experiment jobs', mode: 'table', arrayKey: 'jobs',
    columns: [M('id', 'Job'), { key: 'status', label: 'Status' }, M('seed', 'Seed'), M('generations', 'Gens'), M('condition', 'Condition')],
  },
  inspect_result: {
    label: 'Result metrics (per cell)', mode: 'table', arrayKey: 'summary.rows',
    columns: [M('seed', 'Seed'), M('generation', 'Gen'), M('division_time_sec', 'Division (s)'), M('final_mass_fg', 'Final mass (fg)'), M('growth_rate', 'Growth rate'), M('doubling_time_min', 'Doubling (min)'), { key: 'divided', label: 'Divided' }],
  },
  model_structure: {
    label: 'Metabolic reactions', mode: 'table', arrayKey: 'reactions',
    columns: [M('id', 'Reaction'), { key: 'direction', label: 'Direction' }, { key: 'reversible', label: 'Reversible' }, M('catalysts', 'Catalysts')],
  },
  inspect_tf_network: {
    label: 'TF regulation network', mode: 'multi',
    sections: [
      { label: 'Regulators', arrayKey: 'regulators', columns: [M('regulator', 'Regulator'), M('log2fc', 'log2FC'), { key: 'regulation', label: 'Dir' }] },
      { label: 'Targets', arrayKey: 'targets', columns: [M('target', 'Target'), M('log2fc', 'log2FC'), { key: 'regulation', label: 'Dir' }] },
    ],
  },
  inspect_gene: {
    label: 'Gene', mode: 'fields', objectKey: 'gene',
    fields: [{ key: 'symbol', label: 'Symbol' }, { key: 'ecoli_id', label: 'ECOLI id' }, { key: 'category', label: 'Category' },
      { key: 'ko_index', label: 'KO index' }, { key: 'monomer_id', label: 'Monomer' }, { key: 'position', label: 'Position' }, { key: 'strand', label: 'Strand' }],
  },
  inspect_molecule_trajectories: {
    label: 'Trajectory scope (this job)', mode: 'fields', objectKey: 'trajectory_scope',
    fields: [{ key: 'result_rows_for_this_job', label: 'Lineage trajectories' }, { key: 'seeds', label: 'Seeds' }, { key: 'generation_indices', label: 'Generations' }],
  },
  read_result_series: {
    label: 'Time-series stats', mode: 'fields', objectKey: 'series.stats',
    fields: [{ key: 'n_points', label: 'Points' }, { key: 't_start', label: 't start (s)' }, { key: 't_end', label: 't end (s)' },
      { key: 'min', label: 'Min' }, { key: 'max', label: 'Max' }, { key: 'mean', label: 'Mean' }, { key: 'first', label: 'First' }, { key: 'last', label: 'Last' }],
  },
  gene_catalog: { label: 'Gene catalog', mode: 'totals', totalsKey: 'totals' },
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)
}

function fmtGrounded(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length ? value.map((v) => fmtGrounded(v)).join(', ') : '—'
  if (typeof value === 'number') {
    if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2)
    return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  }
  return String(value)
}

function GroundedTable({ rows, columns }: { rows: unknown[]; columns: GroundedColumn[] }) {
  if (!Array.isArray(rows) || rows.length === 0) return <div className="px-2 py-1 text-xs text-gray-500">No rows.</div>
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className="border-b border-gray-200 px-2 py-1 text-left font-semibold text-gray-600">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 25).map((row, ri) => (
          <tr key={ri} className="even:bg-gray-50/60">
            {columns.map((c) => (
              <td key={c.key} className={`px-2 py-1 align-top text-gray-800 ${c.mono ? 'font-mono' : ''}`}>{fmtGrounded(getPath(row, c.key))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GroundedToolResults({ entries }: { entries: ToolResultEntry[] }) {
  const cards = entries.filter((e) => GROUNDED_TOOLS[e.tool_name])
  if (cards.length === 0) return null
  return (
    <div className="space-y-2" data-testid="grounded-results">
      {cards.map((entry, idx) => {
        const spec = GROUNDED_TOOLS[entry.tool_name]
        return (
          <div key={`${entry.tool_name}-${idx}`} className="rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">{spec.label}</span>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">from platform data</span>
            </div>
            <div className="overflow-x-auto p-2">
              {spec.mode === 'totals' && (
                <div className="flex flex-wrap gap-1.5 px-1 py-1">
                  {Object.entries((getPath(entry.result, spec.totalsKey) as Record<string, unknown>) ?? {}).map(([k, v]) => (
                    <span key={k} className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700">
                      <span className="text-gray-500">{k.replace(/_/g, ' ')}:</span> <span className="font-mono font-medium">{fmtGrounded(v)}</span>
                    </span>
                  ))}
                </div>
              )}
              {spec.mode === 'fields' && (
                <div className="grid gap-1.5 px-1 py-1 sm:grid-cols-2">
                  {spec.fields.map((f) => (
                    <div key={f.key} className="flex items-baseline justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-[11px]">
                      <span className="text-gray-500">{f.label}</span>
                      <span className="font-mono font-medium text-gray-800">{fmtGrounded(getPath(getPath(entry.result, spec.objectKey), f.key))}</span>
                    </div>
                  ))}
                </div>
              )}
              {spec.mode === 'table' && (
                <GroundedTable rows={(getPath(entry.result, spec.arrayKey) as unknown[]) ?? []} columns={spec.columns} />
              )}
              {spec.mode === 'multi' && (
                <div className="space-y-2">
                  {spec.sections.map((sec) => (
                    <div key={sec.label}>
                      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{sec.label}</div>
                      <GroundedTable rows={(getPath(entry.result, sec.arrayKey) as unknown[]) ?? []} columns={sec.columns} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Below the conversation list: a "current chat" group (inspect/result note/memory) + labels help.
 * Proposed actions render inline in the chat (Claude-style), not here. */
function SidePanelCards({
  context, inspecting, inspectCurrentResult, resolvedNote, hasActiveConversation, memory, clearMemory,
}: {
  context: AssistantContext
  inspecting: boolean
  inspectCurrentResult: () => void
  resolvedNote: string | null
  hasActiveConversation: boolean
  memory: AssistantMemory | null
  clearMemory: () => void
}) {
  const hasMemory = Boolean(memory && (memory.summary || memory.remembered_genes.length > 0))
  const showCurrentChat = hasActiveConversation || hasMemory || context.selected_job != null || Boolean(resolvedNote)
  return (
    <>
      {showCurrentChat && (
        <div className="space-y-2 rounded-xl border border-brand-100 bg-white p-2.5">
          <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            Current chat
          </div>

          {context.selected_job != null && (
            <button
              type="button"
              onClick={inspectCurrentResult}
              disabled={inspecting}
              className="w-full rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-left text-sm font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
            >
              {inspecting ? 'Inspecting…' : `Inspect current result (Job #${context.selected_job})`}
            </button>
          )}

          {resolvedNote && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
              {resolvedNote}
            </div>
          )}

          <details className="rounded-lg border border-gray-200 bg-gray-50" open={hasMemory}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <span>What this chat remembers</span>
              {hasMemory && (
                <button
                  type="button"
                  onClick={(event) => { event.preventDefault(); clearMemory() }}
                  className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
                >
                  Clear
                </button>
              )}
            </summary>
            <div className="space-y-2 border-t border-gray-200 p-3">
              {hasMemory ? (
                <>
                  {memory?.summary && (
                    <p className="break-words text-xs leading-5 text-gray-600">{memory.summary}</p>
                  )}
                  {memory && memory.remembered_genes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {memory.remembered_genes.map((gene) => (
                        <span key={gene} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">{gene}</span>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] leading-4 text-gray-500">
                    Older turns are compacted into this summary so long chats keep context. Clearing forgets it.
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-4 text-gray-500">
                  Nothing remembered yet — once this chat runs long enough, earlier turns are compacted here.
                </p>
              )}
            </div>
          </details>
        </div>
      )}

      <details className="rounded-lg border border-gray-200 bg-white">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          What the labels mean
        </summary>
        <div className="space-y-2 border-t border-gray-100 p-3 text-xs leading-5 text-gray-600">
          <div><span className="font-semibold text-gray-900">Platform fact</span> — read straight from the app's data or a read-only tool. Trustworthy.</div>
          <div><span className="font-semibold text-gray-900">Assistant reply</span> — the model's explanation, grounded in read-only tool results and platform data.</div>
          <div><span className="font-semibold text-gray-900">Proposed action</span> — a reviewable card. Never runs from chat text alone.</div>
        </div>
      </details>
    </>
  )
}

export function TaskCenteredAssistantPanel({ heightClass = 'h-[calc(100vh-180px)]' }: { heightClass?: string } = {}) {
  // `heightClass` sizes the three columns. The full `/assistant` page subtracts its header chrome
  // (the default); the dock passes `h-full` to fill the slide-over's own height instead, so the
  // chain section → grid → columns must all be height-defined for `h-full` to resolve.
  const {
    providerConfigured, runtimeLabel, context,
    providerModelOptions, selectedProviderId, selectedModel, selectionAvailable, selectConversationRuntime,
    conversations, activeConversation, messages, proposals, input, setInput,
    inspectPreview, inspectExecution, loading, sending, inspecting, error,
    streamingText, streamingTool, resolvedNote, memory, compactionNotice,
    thinkingSegments, messageThinking, messageToolResults, bottomRef, scrollRef,
    clearMemory, stopStreaming, loadConversationMessages, startNewChat,
    removeConversation, renameConversation, sendMessage, inspectCurrentResult, runReadOnlyProposal,
    handleProposalResolved,
  } = useAssistant()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showScrollDown, setShowScrollDown] = useState(false)
  const selectedProviderOption = providerModelOptions.find((option) => option.provider_id === selectedProviderId)

  function onMessagesScroll() {
    const el = scrollRef.current
    if (!el) return
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 200)
  }
  function scrollToLatest() {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  function beginRename(id: number, title: string) {
    setEditingId(id)
    setEditingTitle(title)
  }
  async function commitRename() {
    if (editingId != null) await renameConversation(editingId, editingTitle)
    setEditingId(null)
  }

  return (
    <section className="h-full min-h-0">
      <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className={`${heightClass} min-h-[560px] space-y-3 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-3`}>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Conversations</div>
            <button
              type="button"
              onClick={startNewChat}
              className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              + New chat
            </button>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {loading && <div className="text-xs text-gray-500">Loading conversations...</div>}
            {!loading && conversations.length === 0 && (
              <div className="text-xs leading-5 text-gray-500">No saved conversations yet.</div>
            )}
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`group flex items-start gap-2 rounded-md border border-l-[3px] px-3 py-2 text-xs transition-colors ${
                  activeConversation?.id === conversation.id
                    ? 'border-brand-200 border-l-brand-500 bg-brand-50 text-gray-900 shadow-sm'
                    : 'border-gray-100 border-l-gray-100 bg-white/70 text-gray-600 hover:bg-white'
                }`}
              >
                {editingId === conversation.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                      else if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                    }}
                    className="min-w-0 flex-1 rounded border border-brand-300 bg-white px-1.5 py-1 text-xs font-medium text-gray-900 focus:outline-none focus:ring-1 focus:ring-brand-300"
                    aria-label="Conversation name"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => loadConversationMessages(conversation)}
                    onDoubleClick={() => beginRename(conversation.id, conversation.title)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate font-medium">{conversation.title}</div>
                    <div className={`mt-1 ${activeConversation?.id === conversation.id ? 'font-medium text-brand-600' : 'text-gray-500'}`}>
                      {activeConversation?.id === conversation.id ? '● current chat' : conversation.status.replace(/_/g, ' ')}
                    </div>
                  </button>
                )}
                {editingId !== conversation.id && (
                  <>
                    <button
                      type="button"
                      onClick={() => beginRename(conversation.id, conversation.title)}
                      className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded text-gray-500 opacity-70 hover:bg-gray-200 hover:text-gray-800 group-hover:opacity-100"
                      title="Rename chat"
                      aria-label={`Rename ${conversation.title}`}
                    >
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 4l3 3M4 16l1-4 8-8 3 3-8 8-4 1z" /></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeConversation(conversation.id)}
                      disabled={sending}
                      className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded text-gray-500 opacity-70 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                      title="Delete chat"
                      aria-label={`Delete ${conversation.title}`}
                    >
                      x
                    </button>
                  </>
                )}
              </div>
            ))}
            </div>
          </div>
          <SidePanelCards
            context={context}
            inspecting={inspecting}
            inspectCurrentResult={inspectCurrentResult}
            resolvedNote={resolvedNote}
            hasActiveConversation={activeConversation != null}
            memory={memory}
            clearMemory={clearMemory}
          />
        </aside>

        <div className={`relative flex ${heightClass} min-h-[560px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-gray-900">
                {activeConversation?.title ?? 'New chat'}
              </div>
              <div className="mt-0.5 truncate text-xs leading-5 text-gray-500">{contextSummary(context)}</div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <label className="sr-only" htmlFor="chat-provider-select">Chat provider</label>
              <select
                id="chat-provider-select"
                value={selectedProviderId}
                disabled={sending}
                onChange={(event) => {
                  const option = providerModelOptions.find((item) => item.provider_id === event.target.value)
                  void selectConversationRuntime(event.target.value, option?.models[0] ?? '')
                }}
                className="max-w-40 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 disabled:bg-gray-50"
              >
                {!selectionAvailable && selectedProviderId && <option value={selectedProviderId}>{selectedProviderId} unavailable</option>}
                {providerModelOptions.map((option) => <option key={option.provider_id} value={option.provider_id}>{option.label}</option>)}
              </select>
              <label className="sr-only" htmlFor="chat-model-select">Chat model</label>
              <select
                id="chat-model-select"
                value={selectedModel}
                disabled={sending || !selectedProviderOption}
                onChange={(event) => void selectConversationRuntime(selectedProviderId, event.target.value)}
                className="max-w-56 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 disabled:bg-gray-50"
              >
                {!selectionAvailable && selectedModel && <option value={selectedModel}>{selectedModel} unavailable</option>}
                {(selectedProviderOption?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span className="shrink-0 text-[11px] text-gray-500">read-only · actions need confirmation</span>
            </div>
          </div>
          {!selectionAvailable && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              This chat's provider or model is unavailable. Choose a configured option before sending.
            </div>
          )}

          <div ref={scrollRef} onScroll={onMessagesScroll} className="flex-1 space-y-4 overflow-y-auto bg-gradient-to-b from-gray-50 to-white px-4 py-5">
            {(inspectPreview || inspectExecution) && (
              <ToolReviewPanel
                title="Read-only result inspection"
                preview={inspectPreview}
                execution={inspectExecution}
              />
            )}
            {messages.length === 0 && !sending && (
              <div className="mx-auto mt-10 max-w-md text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">✦</div>
                <p className="mt-3 text-sm font-medium text-gray-700">Ask about this page or a result</p>
                <p className="mt-1 text-xs leading-5 text-gray-500">
                  The assistant reads deterministic platform facts and proposes next steps. It never changes data on its own — side-effecting actions appear as confirmation cards.
                </p>
                <div className="mt-5 flex flex-col items-stretch gap-2 text-left">
                  {starterPrompts(context).map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => sendMessage(prompt)}
                      disabled={!providerConfigured}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) => {
              const isUser = message.role === 'user'
              const showStatus = !['stored', 'completed'].includes(message.status)
              const thinking = !isUser ? messageThinking[message.id] : undefined
              return (
                <div key={message.id}>
                {thinking && thinking.length > 0 && <ThinkingBlock segments={thinking} />}
                <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
                    <div className="mb-1 flex items-center gap-2 px-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        {isUser ? 'You' : 'Assistant'}
                      </span>
                      {!isUser && message.provider_id && (
                        <span className="max-w-56 truncate text-[11px] text-gray-400" title={`${message.provider_id} · ${message.model}`}>
                          {message.provider_id} · {message.model}
                        </span>
                      )}
                      {showStatus && (
                        <StatusPill tone={messageStatusTone(message.status)}>
                          {messageStatusLabel(message.status)}
                        </StatusPill>
                      )}
                    </div>
                    <div
                      data-testid={isUser ? 'message-user' : 'message-assistant'}
                      className={`overflow-hidden break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                        isUser
                          ? 'whitespace-pre-wrap rounded-br-sm bg-brand-600 text-white'
                          : 'rounded-bl-sm border border-gray-200 bg-white text-gray-800 shadow-sm'
                      } ${message.status === 'failed' ? 'opacity-60' : ''}`}
                    >
                      {isUser ? (
                        message.content
                      ) : message.content ? (
                        <MessageMarkdown text={message.content} />
                      ) : (
                        message.status === 'failed' ? 'Message could not be sent.' : ''
                      )}
                    </div>
                  </div>
                </div>
                {!isUser && messageToolResults[message.id] && (
                  <div className="mt-2 flex justify-start">
                    <div className="w-full max-w-[90%]">
                      <GroundedToolResults entries={messageToolResults[message.id]} />
                    </div>
                  </div>
                )}
                </div>
              )
            })}
            {/* Proposed actions appear inline at the end of the conversation (Claude-style). */}
            {proposals.length > 0 && (
              <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/50 p-3" data-testid="chat-proposals">
                <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
                  <span>Actions awaiting your review</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-blue-700">{proposals.length}</span>
                </div>
                <p className="text-xs leading-5 text-gray-600">
                  The assistant proposed these. Nothing runs until you preview and confirm.
                </p>
                {proposals.slice(0, 5).map((proposal) => (
                  <AssistantProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    context={context}
                    conversationId={activeConversation?.id ?? null}
                    busy={inspecting}
                    onRunReadOnly={runReadOnlyProposal}
                    onResolved={handleProposalResolved}
                  />
                ))}
                {proposals.length > 5 && (
                  <div className="rounded-md border border-dashed border-blue-200 bg-white/60 px-3 py-2 text-xs text-blue-700">
                    +{proposals.length - 5} more proposed action{proposals.length - 5 === 1 ? '' : 's'} — refine your request to narrow these down.
                  </div>
                )}
              </div>
            )}
            {/* Live reasoning trail (folds in before each tool call), then the in-progress answer. */}
            {sending && thinkingSegments.length > 0 && <ThinkingBlock segments={thinkingSegments} live />}
            {sending && streamingText !== null && streamingText.length > 0 && (
              <div className="flex justify-start">
                <div className="max-w-[80%]">
                  <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Assistant</div>
                  <div className="overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-2.5 text-sm leading-6 text-gray-800 shadow-sm">
                    {streamingText}
                    <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand-400 align-middle" />
                  </div>
                </div>
              </div>
            )}
            {sending && (streamingText === null || streamingText.length === 0) && (
              <div className="flex justify-start">
                <div className="max-w-[80%]">
                  <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Assistant</div>
                  <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-3 shadow-sm">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                    <span className="ml-2 text-xs text-gray-500">
                      {streamingTool ? `running ${streamingTool}…` : `thinking${runtimeLabel ? ` · ${runtimeLabel}` : ''}`}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {compactionNotice && !sending && (
              <div className="flex items-center gap-2 py-1" data-testid="assistant-compaction-notice">
                <span className="h-px flex-1 bg-gray-200" />
                <span className="shrink-0 text-[11px] text-gray-500">⤵ Summarized earlier turns to stay focused</span>
                <span className="h-px flex-1 bg-gray-200" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {showScrollDown && (
            <button
              type="button"
              onClick={scrollToLatest}
              data-testid="assistant-scroll-down"
              className="absolute bottom-24 left-1/2 z-10 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-md transition hover:bg-gray-50 hover:text-gray-900"
              title="Scroll to latest"
              aria-label="Scroll to latest message"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4v12m0 0l-5-5m5 5l5-5" /></svg>
            </button>
          )}

          <div className="border-t border-gray-100 bg-white p-3">
            {error && <div className="mb-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</div>}
            <div className="flex items-end gap-2 rounded-xl border border-gray-200 bg-white p-2 focus-within:border-brand-400 focus-within:ring-1 focus-within:ring-brand-200">
              <label htmlFor="assistant-chat-input" className="sr-only">Assistant message</label>
              <textarea
                id="assistant-chat-input"
                data-testid="assistant-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    sendMessage()
                  }
                }}
                rows={2}
                placeholder="Ask what to inspect next…"
                className="max-h-40 min-h-[44px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-0"
              />
              {sending ? (
                <button
                  type="button"
                  data-testid="assistant-stop"
                  onClick={stopStreaming}
                  className="mb-0.5 flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-gray-700" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="assistant-send"
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || !selectionAvailable}
                  className="mb-0.5 shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </div>
            <div className="mt-1.5 px-1 text-[11px] text-gray-500">Ctrl+Enter to send · chat cannot perform side effects</div>
          </div>
        </div>

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
      // Defensive: a malformed/empty API response must not crash the whole page on `.slice`/`.filter`.
      setConfirmations(Array.isArray(confirmationRows) ? confirmationRows : [])
      setToolCalls(Array.isArray(toolCallRows) ? toolCallRows : [])
      setProvenance(Array.isArray(provenanceRows) ? provenanceRows : [])
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
                <div className="mt-2 break-all font-mono text-gray-500">{compactJson(confirmation.payload)}</div>
                <div className="mt-2 text-gray-500">{formatDateTime(confirmation.created_at)}</div>
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
                <div className="mt-2 break-all font-mono text-gray-500">{compactJson(toolCall.arguments)}</div>
                <div className="mt-2 text-gray-500">{formatDateTime(toolCall.updated_at || toolCall.created_at)}</div>
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
                <div className="mt-2 break-all font-mono text-gray-500">{compactJson(record.response)}</div>
                <div className="mt-2 text-gray-500">{formatDateTime(record.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export function AssistantPage() {
  const {
    status,
    providerConfigs,
    statusLoading,
    statusError: error,
    refreshAssistantStatus,
    runtimeReady,
    activeConversation,
  } = useAssistant()
  const activeConversationId = activeConversation?.id ?? null

  const configuredProviders = status?.providers.configured_provider_count ?? 0
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
        <StatusPill tone={runtimeReady ? 'ready' : 'blocked'}>
          {runtimeReady ? 'Provider ready' : 'Chat offline'}
        </StatusPill>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Platform status could not be loaded: {error}
        </div>
      )}

      {!runtimeReady && (
        <details
          className="rounded-lg border border-gray-200 bg-white shadow-sm"
          open
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-gray-900">
            <span>Provider setup</span>
            <span className="text-xs font-normal text-gray-500">configure OpenAI, Anthropic, or Ollama</span>
          </summary>
          <div className="border-t border-gray-100 p-4">
            <AssistantProviderSetup
              configs={providerConfigs}
              runtimeStatus={status}
              loading={statusLoading}
              onRefresh={refreshAssistantStatus}
            />
          </div>
        </details>
      )}

      <TaskCenteredAssistantPanel />

      <AdvancedDisclosure title="Provider, runtime, and tool settings">
        {runtimeReady && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
            <AssistantProviderSetup
              configs={providerConfigs}
              runtimeStatus={status}
              loading={statusLoading}
              onRefresh={refreshAssistantStatus}
            />
          </div>
        )}
        <div className="space-y-4">
          <RuntimeSettingsCard />
          <ConnectionTestCard />
        </div>
      </AdvancedDisclosure>

      <AdvancedDisclosure title="Activity and provenance">
        <AssistantAuditPanel activeConversationId={activeConversationId} />
      </AdvancedDisclosure>
    </div>
  )
}
