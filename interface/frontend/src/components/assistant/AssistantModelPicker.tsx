import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'



import { useAssistantFocus } from './AssistantUI'

const MODEL_POPOVER_WIDTH = 256
const MODEL_POPOVER_MARGIN = 8
const LOCAL_MODEL_PROVIDER_IDS = ['ollama', 'lmstudio', 'lm_studio', 'vllm']

/** Compact provider+model selector for the chat header. A single pill (provider · model) that opens
 * a small popover — the per-chat override lives here without two dropdowns cluttering every chat.
 * The global default is set in Provider settings; new chats inherit it. */
export function ModelPill({
  options, providerId, model, available, disabled, onSelect,
}: {
  options: { provider_id: string; label: string; models: string[] }[]
  providerId: string
  model: string
  available: boolean
  disabled: boolean
  onSelect: (providerId: string, model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useAssistantFocus(popoverRef, open, () => setOpen(false))
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  function updatePopoverPosition() {
    const button = ref.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const popoverWidth = Math.min(MODEL_POPOVER_WIDTH, window.innerWidth - 16)
    const maxLeft = window.innerWidth - popoverWidth - MODEL_POPOVER_MARGIN
    setPopoverPosition({
      top: Math.max(MODEL_POPOVER_MARGIN, rect.top - Math.min(popoverRef.current?.getBoundingClientRect().height ?? 280, window.innerHeight - 16) - 8),
      left: Math.max(MODEL_POPOVER_MARGIN, Math.min(rect.right - popoverWidth, maxLeft)),
    })
  }

  useLayoutEffect(() => { if (open) updatePopoverPosition() }, [open, providerId, model])
  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    updatePopoverPosition()
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('resize', updatePopoverPosition)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('resize', updatePopoverPosition)
    }
  }, [open])

  const providerOption = options.find((option) => option.provider_id === providerId)
  const label = `${providerOption?.label ?? providerId ?? 'No provider'}${model ? ` · ${model}` : ''}`
  const showLocalModelWarning = LOCAL_MODEL_PROVIDER_IDS.includes(providerId.toLowerCase())
  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      data-testid="model-popover"
      data-assistant-overlay="model" role="dialog" aria-label="Conversation model"
      className="fixed z-[100] w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
      style={{ top: popoverPosition.top, left: popoverPosition.left, width: Math.min(256, window.innerWidth - 16), maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Provider</div>
      <select
        aria-label="Conversation provider"
        value={providerId}
        disabled={disabled}
        onChange={(event) => {
          const option = options.find((item) => item.provider_id === event.target.value)
          onSelect(event.target.value, option?.models[0] ?? '')
        }}
        className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 disabled:bg-gray-50"
      >
        {!available && providerId && <option value={providerId}>{providerId} (unavailable)</option>}
        {options.map((option) => <option key={option.provider_id} value={option.provider_id}>{option.label}</option>)}
      </select>
      <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Model</div>
      <select
        aria-label="Conversation model"
        value={model}
        disabled={disabled || !providerOption}
        onChange={(event) => onSelect(providerId, event.target.value)}
        className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 disabled:bg-gray-50"
      >
        {!available && model && <option value={model}>{model} (unavailable)</option>}
        {(providerOption?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <p className="mt-2 text-[10px] leading-4 text-gray-400">Per-chat. The default is set in Provider settings.</p>
      {showLocalModelWarning && (
        <p className="mt-1 text-[10px] leading-4 text-amber-600">
          Local models need free RAM ≈ their size (8B ≈ 6 GB, 14B ≈ 12 GB). Large models can crash on
          low-RAM machines — see Guide → Assistant.
        </p>
      )}
    </div>,
    document.body,
  ) : null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="model-pill"
        disabled={disabled} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => {
          if (!open) updatePopoverPosition()
          setOpen((value) => !value)
        }}
        title="Change provider / model for this chat"
        className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
          available
            ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${available ? 'bg-emerald-500' : 'bg-amber-500'}`} />
        <span className="truncate">{available ? label : `${label} · unavailable`}</span>
        <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 8l4 4 4-4" /></svg>
      </button>
      {popover}
    </div>
  )
}
