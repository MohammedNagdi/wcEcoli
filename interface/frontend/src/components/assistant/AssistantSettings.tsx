import { useEffect, useState } from 'react'
import {
  getAssistantRuntimeSettings,
  updateAssistantRuntimeSettings,
  warmAssistantProvider,
} from '../../api/client'
import type { AssistantRuntimeSettings } from '../../api/client'

const NUMBER_FIELDS: { key: keyof AssistantRuntimeSettings; label: string; hint: string }[] = [
  { key: 'max_agent_turns', label: 'Max agent turns', hint: 'Cap on tool-use loop iterations per message.' },
  { key: 'context_token_budget', label: 'Context token budget', hint: 'Recent history kept verbatim (≈ tokens).' },
  { key: 'keep_recent_turns', label: 'Keep recent turns', hint: 'Turns kept before older ones are compacted.' },
  { key: 'compact_threshold', label: 'Compact threshold', hint: 'Old turns to accumulate before summarizing.' },
  { key: 'request_timeout_sec', label: 'Request timeout (s)', hint: 'Per-call ceiling for hosted providers.' },
  { key: 'local_timeout_sec', label: 'Local timeout (s)', hint: 'Per-call ceiling for Ollama/LM Studio/vLLM.' },
  { key: 'confirmation_ttl_sec', label: 'Confirmation TTL (s)', hint: 'How long an approved action stays valid.' },
]

export function RuntimeSettingsCard() {
  const [draft, setDraft] = useState<AssistantRuntimeSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAssistantRuntimeSettings().then(setDraft).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  function set<K extends keyof AssistantRuntimeSettings>(key: K, value: AssistantRuntimeSettings[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const saved = await updateAssistantRuntimeSettings(draft)
      setDraft(saved)
      setMessage('Saved. Applied to the running assistant.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (error && !draft) {
    return <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
  }
  if (!draft) return <div className="text-xs text-gray-400">Loading runtime settings…</div>

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Runtime settings</h3>
      <p className="mt-1 text-xs leading-5 text-gray-500">
        Tune the agent loop, context window, timeouts, and compaction. Saved values override the environment and
        apply immediately.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="text-xs font-medium text-gray-700">{f.label}</span>
            <input
              type="number"
              value={String(draft[f.key])}
              onChange={(e) => set(f.key, Number(e.target.value) as never)}
              className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
            />
            <span className="mt-0.5 block text-[11px] leading-4 text-gray-400">{f.hint}</span>
          </label>
        ))}
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Ollama keep-alive</span>
          <input
            type="text"
            value={draft.ollama_keep_alive}
            onChange={(e) => set('ollama_keep_alive', e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
          />
          <span className="mt-0.5 block text-[11px] leading-4 text-gray-400">Keep a local model resident, e.g. 30m.</span>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Summary model (override)</span>
          <input
            type="text"
            value={draft.summary_model}
            onChange={(e) => set('summary_model', e.target.value)}
            placeholder="default per provider"
            className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
          />
          <span className="mt-0.5 block text-[11px] leading-4 text-gray-400">Cheap model for compaction; blank = per-provider default.</span>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {message && <span className="text-xs text-emerald-700">{message}</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  )
}

export function ConnectionTestCard() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function test() {
    setBusy(true)
    setResult(null)
    try {
      const r = await warmAssistantProvider()
      if (r.warmed) setResult(`✓ Reached ${r.provider_id}${r.model ? ` (${r.model})` : ''}.`)
      else if (r.reason === 'provider_not_local') setResult(`Active provider ${r.provider_id ?? ''} is hosted — no warm-up needed.`)
      else if (r.reason === 'no_configured_provider') setResult('No provider is configured yet.')
      else setResult(r.error ? `Failed: ${r.error}` : 'Could not reach the provider.')
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Connection</h3>
      <p className="mt-1 text-xs leading-5 text-gray-500">
        Test reachability and pre-warm the active local model so the first message isn't slow.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={test}
          disabled={busy}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? 'Testing…' : 'Test connection'}
        </button>
        {result && <span className="text-xs text-gray-600">{result}</span>}
      </div>
      <p className="mt-3 text-[11px] leading-4 text-gray-400">
        Provider API keys are encrypted at rest and never returned by the API.
      </p>
    </div>
  )
}
