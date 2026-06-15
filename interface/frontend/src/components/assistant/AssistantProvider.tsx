import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useLocation } from 'react-router-dom'
import {
  getPlatformStatus,
  getAssistantProviderConfigs,
  getAssistantProviderModelOptions,
  warmAssistantProvider,
  getAssistantMemory,
  clearAssistantMemory,
  getAssistantConversations,
  getAssistantMessages,
  getAssistantToolCalls,
  createAssistantConversation,
  deleteAssistantConversation,
  renameAssistantConversation,
  updateAssistantConversation,
  createAssistantMessage,
  streamAssistantMessage,
  previewAssistantTool,
  executeAssistantTool,
  dismissAssistantToolCall,
} from '../../api/client'
import type { AssistantMemory } from '../../api/client'
import type {
  AssistantConversation,
  AssistantContext,
  AssistantExchange,
  AssistantMessage,
  AssistantToolCall,
  AssistantToolPreview,
  AssistantToolExecution,
  AssistantProviderConfig,
  AssistantProviderModelOption,
  PlatformStatus,
} from '../../types'

export interface ToolResultEntry {
  tool_name: string
  result: Record<string, unknown>
}

export interface PageAssistantRegistration {
  context: Partial<AssistantContext>
  suggestedPrompt?: string
}

function parseOptionalNumber(value: string | null): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export interface AssistantContextValue {
  // Panel visibility (used by the docked panel from Phase 2 on; harmless now)
  isOpen: boolean
  openAssistant: (opts?: { prompt?: string }) => void
  closeAssistant: () => void

  // Platform / provider status
  status: PlatformStatus | null
  providerConfigs: AssistantProviderConfig[]
  providerModelOptions: AssistantProviderModelOption[]
  statusLoading: boolean
  statusError: string | null
  refreshAssistantStatus: () => Promise<void>
  runtimeReady: boolean
  runtimeLabel: string
  providerConfigured: boolean
  selectedProviderId: string
  selectedModel: string
  selectionAvailable: boolean

  // Page context (reactive to the route; pages can register richer context)
  context: AssistantContext
  registerContext: (registration: PageAssistantRegistration) => void
  clearContext: () => void
  suggestedPrompt: string

  // Chat state
  conversations: AssistantConversation[]
  activeConversation: AssistantConversation | null
  messages: AssistantMessage[]
  proposals: AssistantToolCall[]
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  inspectPreview: AssistantToolPreview | null
  inspectExecution: AssistantToolExecution | null
  loading: boolean
  sending: boolean
  inspecting: boolean
  error: string | null
  streamingText: string | null
  streamingTool: string | null
  resolvedNote: string | null
  memory: AssistantMemory | null
  /** Set briefly when a turn folded earlier history into the rolling summary (in-chat marker). */
  compactionNotice: boolean
  /** Live reasoning segments emitted before tool calls during the current stream. */
  thinkingSegments: string[]
  /** Reasoning trail attached to a completed assistant message id (session-only). */
  messageThinking: Record<number, string[]>
  /** Authoritative read-only tool outputs per assistant message id (grounded data cards). */
  messageToolResults: Record<number, ToolResultEntry[]>
  bottomRef: RefObject<HTMLDivElement>
  /** The scrollable message list element — auto-scroll targets this, not the window. */
  scrollRef: RefObject<HTMLDivElement>

  // Actions
  clearMemory: () => Promise<void>
  stopStreaming: () => void
  loadConversationMessages: (conversation: AssistantConversation) => Promise<void>
  startNewChat: () => Promise<void>
  removeConversation: (conversationId: number) => Promise<void>
  renameConversation: (conversationId: number, title: string) => Promise<void>
  selectConversationRuntime: (providerId: string, model: string) => Promise<void>
  sendMessage: (presetContent?: string) => Promise<void>
  inspectCurrentResult: () => Promise<void>
  runReadOnlyProposal: (proposal: AssistantToolCall) => Promise<void>
  handleProposalResolved: (proposalId: number, outcome: 'executed' | 'rejected') => void
}

const AssistantCtx = createContext<AssistantContextValue | null>(null)

export function useAssistant(): AssistantContextValue {
  const value = useContext(AssistantCtx)
  if (!value) throw new Error('useAssistant must be used within <AssistantProvider>')
  return value
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const location = useLocation()

  // ── visibility ──
  const [isOpen, setIsOpen] = useState(false)

  // ── status ──
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [providerConfigs, setProviderConfigs] = useState<AssistantProviderConfig[]>([])
  const [providerModelOptions, setProviderModelOptions] = useState<AssistantProviderModelOption[]>([])
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  async function refreshAssistantStatus() {
    setStatusLoading(true)
    try {
      const [platformStatus, configs, options] = await Promise.all([
        getPlatformStatus(), getAssistantProviderConfigs(), getAssistantProviderModelOptions(),
      ])
      setStatus(platformStatus)
      setProviderConfigs(configs)
      setProviderModelOptions(options)
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setStatusLoading(true)
    Promise.all([getPlatformStatus(), getAssistantProviderConfigs(), getAssistantProviderModelOptions()])
      .then(([data, configs, options]) => {
        if (!cancelled) {
          setStatus(data)
          setProviderConfigs(configs)
          setProviderModelOptions(options)
          setStatusError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runtimeReady = Boolean(status?.providers.runtime_ready)
  const runtimeLabel = status?.providers.active_runtime_provider_id
    ? `${status.providers.active_runtime_provider_id}${status.providers.active_runtime_model ? ` (${status.providers.active_runtime_model})` : ''}`
    : ''
  const activeRuntime = status?.providers.active_runtime_provider_id

  useEffect(() => {
    if (!runtimeReady) return
    if (!['ollama', 'lm_studio', 'vllm'].includes(activeRuntime ?? '')) return
    warmAssistantProvider().catch(() => {})
  }, [runtimeReady, activeRuntime])

  // ── page context (reactive) ──
  // Base context derived from the URL (used on /assistant deep links). Pages can register richer
  // context (their selected gene/job/etc.) via useRegisterAssistantContext, which overrides this.
  const urlContext = useMemo<AssistantContext>(() => {
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

  const [pageRegistration, setPageRegistration] = useState<PageAssistantRegistration | null>(null)
  const registerContext = (registration: PageAssistantRegistration) => setPageRegistration(registration)
  const clearContext = () => setPageRegistration(null)
  const context = useMemo<AssistantContext>(
    () => (pageRegistration ? { ...urlContext, ...pageRegistration.context } : urlContext),
    [urlContext, pageRegistration],
  )

  const urlSuggestedPrompt = useMemo(() => new URLSearchParams(location.search).get('prompt') || '', [location.search])
  const suggestedPrompt = pageRegistration?.suggestedPrompt || urlSuggestedPrompt

  // ── chat state ──
  const [conversations, setConversations] = useState<AssistantConversation[]>([])
  const [activeConversation, setActiveConversation] = useState<AssistantConversation | null>(null)
  const [draftProviderId, setDraftProviderId] = useState('')
  const [draftModel, setDraftModel] = useState('')
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [proposals, setProposals] = useState<AssistantToolCall[]>([])
  const [input, setInput] = useState('')
  const [inspectPreview, setInspectPreview] = useState<AssistantToolPreview | null>(null)
  const [inspectExecution, setInspectExecution] = useState<AssistantToolExecution | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamingTool, setStreamingTool] = useState<string | null>(null)
  const [resolvedNote, setResolvedNote] = useState<string | null>(null)
  const [memory, setMemory] = useState<AssistantMemory | null>(null)
  const [compactionNotice, setCompactionNotice] = useState(false)
  // The model's intermediate reasoning (text emitted before each tool call) — shown live as a
  // collapsible "thinking" block, then attached per-message once the final answer lands.
  const [thinkingSegments, setThinkingSegments] = useState<string[]>([])
  const [messageThinking, setMessageThinking] = useState<Record<number, string[]>>({})
  // Authoritative read-only tool outputs per assistant message id — rendered as grounded data cards
  // straight from the adapter JSON (so the data is correct even if the model paraphrases it wrong).
  const [messageToolResults, setMessageToolResults] = useState<Record<number, ToolResultEntry[]>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef('')
  const thinkingRef = useRef<string[]>([])
  const selectedProviderId = activeConversation?.provider_id || draftProviderId
  const selectedModel = activeConversation?.model || draftModel
  const selectedOption = providerModelOptions.find((option) => option.provider_id === selectedProviderId)
  const selectionAvailable = Boolean(selectedOption?.models.includes(selectedModel))
  const inspectionContextKey = [
    context.route,
    context.selected_gene,
    context.selected_job,
    context.selected_result,
    context.selected_experiment,
    context.selected_condition,
    context.selected_variant_type,
    context.selected_builder_section,
  ].join('|')

  function clearInspection() {
    setInspectPreview(null)
    setInspectExecution(null)
  }

  useEffect(() => {
    if (activeConversation?.provider_id || draftProviderId || providerModelOptions.length === 0) return
    const defaultProvider = status?.providers.active_runtime_provider_id
    const option = providerModelOptions.find((item) => item.provider_id === defaultProvider) ?? providerModelOptions[0]
    setDraftProviderId(option.provider_id)
    setDraftModel(
      option.models.includes(status?.providers.active_runtime_model ?? '')
        ? status?.providers.active_runtime_model ?? ''
        : option.models[0] ?? '',
    )
  }, [activeConversation?.provider_id, draftProviderId, providerModelOptions, status])

  const previousInspectionContextKey = useRef(inspectionContextKey)
  useEffect(() => {
    if (previousInspectionContextKey.current !== inspectionContextKey) {
      clearInspection()
      previousInspectionContextKey.current = inspectionContextKey
    }
  }, [inspectionContextKey])

  useEffect(() => {
    const id = activeConversation?.id
    if (id == null) {
      setMemory(null)
      return
    }
    let cancelled = false
    getAssistantMemory(id)
      .then((data) => {
        if (!cancelled) setMemory(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeConversation?.id, messages.length])

  async function clearMemory() {
    const id = activeConversation?.id
    if (id == null) return
    try {
      await clearAssistantMemory(id)
      setMemory(await getAssistantMemory(id))
    } catch {
      /* best-effort */
    }
  }

  function stopStreaming() {
    abortRef.current?.abort()
  }

  // Keep the message list pinned to the bottom *only* by scrolling the list element itself, and
  // only when the user is already near the bottom. Using scrollIntoView here scrolled every
  // scrollable ancestor (including the window), which yanked the whole page on each streamed token
  // and fought the user's own scrolling. Setting scrollTop on the container avoids both.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 120) el.scrollTop = el.scrollHeight
  }, [messages.length, sending, streamingText])

  // Jump straight to the latest message when switching/opening a conversation (ignore the
  // near-bottom gate above, which is only for keeping pace during a live stream).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeConversation?.id])

  // The user just sent a message — always jump to the bottom so the new turn is visible, even if
  // they had scrolled up to read an earlier answer (the near-bottom gate would otherwise block it).
  const prevSendingRef = useRef(false)
  useEffect(() => {
    if (sending && !prevSendingRef.current) {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    }
    prevSendingRef.current = sending
  }, [sending])

  async function loadConversationMessages(conversation: AssistantConversation) {
    setError(null)
    setCompactionNotice(false)
    setThinkingSegments([])
    if (activeConversation?.id !== conversation.id) clearInspection()
    setActiveConversation(conversation)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (urlSuggestedPrompt && !input.trim() && messages.length === 0) {
      setInput(urlSuggestedPrompt)
    }
  }, [urlSuggestedPrompt, input, messages.length])

  useEffect(() => {
    if (!activeConversation) {
      setProposals([])
      return
    }
    let cancelled = false
    getAssistantToolCalls({ conversation_id: activeConversation.id, status: 'proposed' })
      .then((proposalRows) => {
        if (!cancelled) setProposals(proposalRows)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [activeConversation?.id, messages.length])

  async function startNewChat() {
    setError(null)
    setCompactionNotice(false)
    setThinkingSegments([])
    clearInspection()
    setActiveConversation(null)
    setMessages([])
    setProposals([])
    setInput('')
    const defaultProvider = status?.providers.active_runtime_provider_id
    const option = providerModelOptions.find((item) => item.provider_id === defaultProvider) ?? providerModelOptions[0]
    setDraftProviderId(option?.provider_id ?? '')
    setDraftModel(
      option?.models.includes(status?.providers.active_runtime_model ?? '')
        ? status?.providers.active_runtime_model ?? ''
        : option?.models[0] ?? '',
    )
  }

  async function removeConversation(conversationId: number) {
    if (sending) {
      setError('Wait for the current assistant response before deleting this chat.')
      return
    }
    setError(null)
    try {
      await deleteAssistantConversation(conversationId)
      setConversations((current) => current.filter((conversation) => conversation.id !== conversationId))
      if (activeConversation?.id === conversationId) {
        setActiveConversation(null)
        setMessages([])
        setProposals([])
        clearInspection()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function renameConversation(conversationId: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    setError(null)
    try {
      const updated = await renameAssistantConversation(conversationId, trimmed)
      setConversations((current) => current.map((c) => (c.id === conversationId ? updated : c)))
      if (activeConversation?.id === conversationId) setActiveConversation(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function selectConversationRuntime(providerId: string, model: string) {
    if (sending) return
    setError(null)
    if (!activeConversation) {
      setDraftProviderId(providerId)
      setDraftModel(model)
      return
    }
    try {
      const updated = await updateAssistantConversation(activeConversation.id, { provider_id: providerId, model })
      setActiveConversation(updated)
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function ensureConversation(content: string): Promise<AssistantConversation> {
    if (activeConversation) return activeConversation
    const title = content.trim().slice(0, 64) || 'Assistant chat'
    const conversation = await createAssistantConversation({
      title,
      assistant_surface: 'central',
      context,
      provider_id: draftProviderId,
      model: draftModel,
    })
    setActiveConversation(conversation)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    return conversation
  }

  async function sendMessage(presetContent?: string) {
    const content = (presetContent ?? input).trim()
    if (!content || sending || !selectionAvailable) return
    setSending(true)
    setError(null)
    setCompactionNotice(false)
    streamingRef.current = ''
    thinkingRef.current = []
    setThinkingSegments([])
    setInput('')
    const tempId = -Date.now()
    const optimisticUser: AssistantMessage = {
      id: tempId,
      conversation_id: activeConversation?.id ?? 0,
      role: 'user',
      content,
      context,
      status: 'sending',
      created_at: new Date().toISOString(),
      provider_id: '',
      model: '',
    }
    setMessages((current) => [...current, optimisticUser])

    function applyExchange(exchange: AssistantExchange) {
      setMessages((current) => [
        ...current.filter((message) => message.id !== tempId && message.id !== exchange.user_message.id),
        exchange.user_message,
        exchange.assistant_message,
      ])
      setProposals(exchange.proposals ?? [])
      setActiveConversation(exchange.conversation)
      setConversations((current) => [exchange.conversation, ...current.filter((item) => item.id !== exchange.conversation.id)])
    }

    try {
      const conversation = await ensureConversation(content)
      const controller = new AbortController()
      abortRef.current = controller
      let streamed = false
      try {
        setStreamingText('')
        await streamAssistantMessage(
          conversation.id,
          { content, context },
          {
            onUser: (message) => {
              streamed = true
              setMessages((current) => current.map((item) => (item.id === tempId ? message : item)))
            },
            onDelta: (text) => {
              streamed = true
              streamingRef.current += text
              setStreamingText(streamingRef.current)
            },
            onStatus: (tool) => {
              setStreamingTool(tool)
              // A tool is about to run: whatever the model said up to here was reasoning, not the
              // final answer — fold it into the thinking trail and reset the live answer buffer.
              if (streamingRef.current.trim()) {
                thinkingRef.current = [...thinkingRef.current, streamingRef.current.trim()]
                setThinkingSegments(thinkingRef.current)
                streamingRef.current = ''
                setStreamingText('')
              }
            },
            onDone: (payload) => {
              streamed = true
              const exchange = payload as unknown as AssistantExchange
              applyExchange(exchange)
              setCompactionNotice(Boolean((payload as { compacted?: boolean }).compacted))
              // Attach the reasoning trail to the final assistant message (ephemeral, session-only).
              const asstId = exchange.assistant_message?.id
              if (asstId != null && thinkingRef.current.length > 0) {
                setMessageThinking((current) => ({ ...current, [asstId]: thinkingRef.current }))
              }
              // Attach authoritative read-only tool outputs for grounded data cards.
              const toolResults = (payload as { tool_results?: ToolResultEntry[] }).tool_results
              if (asstId != null && Array.isArray(toolResults) && toolResults.length > 0) {
                setMessageToolResults((current) => ({ ...current, [asstId]: toolResults }))
              }
            },
            onError: (message) => setError(message),
          },
          controller.signal,
        )
      } catch (streamErr) {
        if (controller.signal.aborted) {
          setMessages((current) =>
            current.map((message) => (message.id === tempId ? { ...message, status: 'stored' } : message)),
          )
          return
        }
        if (streamed) throw streamErr
        const exchange = await createAssistantMessage(conversation.id, { content, context })
        applyExchange(exchange)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMessages((current) => current.map((message) => (message.id === tempId ? { ...message, status: 'failed' } : message)))
    } finally {
      abortRef.current = null
      setStreamingText(null)
      setStreamingTool(null)
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
      setInspectExecution(await executeAssistantTool('inspect_result', { arguments: args, context }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspecting(false)
    }
  }

  async function runReadOnlyProposal(proposal: AssistantToolCall) {
    if (proposal.result.side_effect || inspecting) return
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
      setProposals((current) => current.filter((item) => item.id !== proposal.id))
      if (proposal.id > 0) dismissAssistantToolCall(proposal.id, 'executed').catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspecting(false)
    }
  }

  function handleProposalResolved(proposalId: number, outcome: 'executed' | 'rejected') {
    setProposals((current) => current.filter((item) => item.id !== proposalId))
    setResolvedNote(outcome === 'executed' ? 'Action confirmed and executed.' : 'Proposal dismissed.')
    window.setTimeout(() => setResolvedNote(null), 3500)
    if (proposalId > 0) {
      dismissAssistantToolCall(proposalId, outcome).catch(() => {})
    }
  }

  function openAssistant(opts?: { prompt?: string }) {
    setIsOpen(true)
    const prompt = opts?.prompt || pageRegistration?.suggestedPrompt || ''
    if (prompt) setInput((current) => (current.trim() ? current : prompt))
  }
  function closeAssistant() {
    setIsOpen(false)
  }

  const value: AssistantContextValue = {
    isOpen,
    openAssistant,
    closeAssistant,
    status,
    providerConfigs,
    providerModelOptions,
    statusLoading,
    statusError,
    refreshAssistantStatus,
    runtimeReady,
    runtimeLabel: selectedProviderId
      ? `${selectedProviderId}${selectedModel ? ` (${selectedModel})` : ''}`
      : runtimeLabel,
    providerConfigured: selectionAvailable,
    selectedProviderId,
    selectedModel,
    selectionAvailable,
    context,
    registerContext,
    clearContext,
    suggestedPrompt,
    conversations,
    activeConversation,
    messages,
    proposals,
    input,
    setInput,
    inspectPreview,
    inspectExecution,
    loading,
    sending,
    inspecting,
    error,
    streamingText,
    streamingTool,
    resolvedNote,
    memory,
    compactionNotice,
    thinkingSegments,
    messageThinking,
    messageToolResults,
    bottomRef,
    scrollRef,
    clearMemory,
    stopStreaming,
    loadConversationMessages,
    startNewChat,
    removeConversation,
    renameConversation,
    selectConversationRuntime,
    sendMessage,
    inspectCurrentResult,
    runReadOnlyProposal,
    handleProposalResolved,
  }

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>
}

/**
 * Register the current page's context with the Assistant (selected gene/job/experiment/etc.), so the
 * docked panel is page-aware without navigating. Clears on unmount. Pass a stable/memoized object or
 * primitive fields — re-registers whenever they change.
 */
export function useRegisterAssistantContext(registration: PageAssistantRegistration) {
  const { registerContext, clearContext } = useAssistant()
  const key = JSON.stringify(registration)
  useEffect(() => {
    registerContext(registration)
    return () => clearContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
