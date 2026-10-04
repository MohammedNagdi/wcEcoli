import { useEffect, useRef, useState } from 'react'
import { getOllamaModels, updateAssistantProviderConfig, clearAssistantProviderConfig, testAssistantProviderModel, removeAssistantProviderModel } from '../../api/client'
import type { AssistantProviderConfig, PlatformStatus, OllamaModelList } from '../../types'


import { ConfirmDialog } from '../common/ConfirmDialog'
import { StatusPill, InfoTooltip } from './AssistantPrimitives'

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

export function providerSetupCopy(providerId: string) {
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

export function AssistantProviderSetup({
  configs,
  runtimeStatus,
  loading,
  onRefresh,
  disabled = false,
  onDirtyChange,
}: {
  configs: AssistantProviderConfig[]
  runtimeStatus: PlatformStatus | null
  loading: boolean
  onRefresh: () => Promise<void>
  disabled?: boolean
  onDirtyChange?: (dirty: boolean) => void
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

  const lastProvider = useRef(providerId)
  const dirtyRef = useRef(false)
  const operation = useRef(false)
  const [nextProvider, setNextProvider] = useState<string | null>(null)
  useEffect(() => { if (!dirtyRef.current) setProviderId(initialProvider) }, [initialProvider])

  useEffect(() => {
    if (dirtyRef.current && lastProvider.current === providerId) return
    lastProvider.current = providerId
    dirtyRef.current = false
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

  useEffect(() => {
    const changed = Boolean(apiKey || replacingKey || customModel || endpointUrl !== (selectedConfig?.endpoint_url || selectedTemplate.endpointHint) || model !== (selectedConfig?.model || selectedConfig?.default_model || selectedTemplate.defaultModel))
    dirtyRef.current = changed
    onDirtyChange?.(changed)
  }, [apiKey, replacingKey, customModel, endpointUrl, model, selectedConfig, selectedTemplate, onDirtyChange])
  const modelsRequest = useRef(0)
  useEffect(() => () => { ++modelsRequest.current }, [])
  async function loadOllamaModels(endpoint = endpointUrl) {
    if (providerId !== 'ollama') return
    const request = ++modelsRequest.current
    setLoadingModels(true)
    setMessage(null)
    try {
      const result = await getOllamaModels(endpoint)
      if (request !== modelsRequest.current) return
      setOllamaModels(result)
      if (result.reachable && result.models.length > 0 && !result.models.some((item) => item.name === model)) {
        setModel(result.models[0].name)
      }
      if (!result.reachable) {
        setMessage(`Could not reach Ollama: ${result.error}`)
      }
    } catch (err) {
      if (request === modelsRequest.current) setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === modelsRequest.current) setLoadingModels(false)
    }
  }

  useEffect(() => {
    ++modelsRequest.current
    if (providerId === 'ollama' && endpointUrl) {
      loadOllamaModels(endpointUrl)
    }
  }, [providerId, endpointUrl])

  async function saveProvider() {
    if (!model.trim()) { setMessage('Enter a model ID.'); return }
    if (providerId === 'ollama' && !/^https?:\/\//i.test(endpointUrl)) { setMessage('Enter an HTTP or HTTPS endpoint URL.'); return }
    if (operation.current || disabled) return
    operation.current = true
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
      dirtyRef.current = false
      onDirtyChange?.(false)
      await onRefresh()
      setApiKey('')
      setReplacingKey(false)
      setMessage(`${selectedTemplate.label} is now the active assistant provider.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      operation.current = false
      setSaving(false)
    }
  }

  async function clearProvider() {
    if (operation.current || disabled) return
    operation.current = true
    setSaving(true)
    setMessage(null)
    try {
      await clearAssistantProviderConfig(providerId)
      await onRefresh()
      setMessage(`${selectedTemplate.label} setup was cleared.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      operation.current = false
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
      <fieldset disabled={disabled || saving || testingModel} className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-950">Assistant provider setup</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            Choose a provider and model for new conversations.
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
              disabled={disabled || saving || testingModel}
              onClick={() => { if (dirtyRef.current && provider.id !== providerId) setNextProvider(provider.id); else setProviderId(provider.id) }}
              className={`rounded-lg border p-4 text-left transition ${
                isSelected ? 'border-brand-400 bg-brand-50 shadow-sm' : 'border-gray-200 bg-white hover:border-brand-200'
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
                  aria-label={selectedTemplate.secretLabel}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste API key"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
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
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
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
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
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
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
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
              aria-label="Default model" aria-invalid={!model.trim()}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
            >
              {(selectedConfig?.models ?? []).map((item) => (
                <option key={item.model_id} value={item.model_id}>{item.model_id}</option>
              ))}
            </select>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                aria-label="New model identifier"
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder="Add another model identifier"
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
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
          className="rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-gray-300"
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
        {message && <span role="status" className="text-sm text-gray-600">{message}</span>}
      </div>
      </fieldset>
      <ConfirmDialog open={Boolean(nextProvider)} title="Discard provider edits?" message="Save your changes before choosing another provider, or discard these edits." confirmLabel="Discard edits" onCancel={() => setNextProvider(null)} onConfirm={() => { dirtyRef.current = false; setProviderId(nextProvider!); setNextProvider(null) }} />
    </section>
  )
}
