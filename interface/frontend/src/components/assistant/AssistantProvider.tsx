import { useCallback, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
  enabled?: boolean
  contextKey?: string
}

function assistantRegistrationFallbackKey(registration: PageAssistantRegistration): string {
  const pageState = registration.context.page_state && typeof registration.context.page_state === 'object'
    ? registration.context.page_state
    : null
  return JSON.stringify({
    enabled: registration.enabled !== false,
    suggestedPrompt: registration.suggestedPrompt || '',
    context: {
      route: registration.context.route || '',
      selected_gene: registration.context.selected_gene ?? null,
      selected_experiment: registration.context.selected_experiment ?? null,
      selected_job: registration.context.selected_job ?? null,
      selected_result: registration.context.selected_result ?? null,
      selected_condition: registration.context.selected_condition ?? null,
      selected_variant_type: registration.context.selected_variant_type ?? null,
      selected_builder_section: registration.context.selected_builder_section ?? null,
      assistant_surface: registration.context.assistant_surface || '',
      page_state: pageState
        ? {
          kind: pageState.kind,
          surface: pageState.surface,
          summary: pageState.summary,
          dirty: pageState.dirty,
          captured_at: pageState.captured_at,
        }
        : null,
    },
  })
}

function parseOptionalNumber(value: string | null): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export type AssistantView = 'chat' | 'settings' | 'activity'
export type AssistantTurnState = 'idle' | 'waiting' | 'streaming' | 'tool' | 'stopped' | 'interrupted'
export interface InterruptedTurn {
  conversationId: number | null
  text: string
  acceptedMessageId?: number
  status: 'stopped' | 'interrupted'
  reconciled: boolean
}

export interface ProposalReviewState {
  preview: AssistantToolPreview | null
  context: AssistantContext | null
  confirmation: import('../../types').AssistantConfirmation | null
  execution: AssistantToolExecution | null
  uncertain: boolean
  busy: string | null
  conversationId?: number | null
  messageId?: number | null
  error: string | null
}
export interface AssistantContextValue {
  proposalReviews: Record<number, ProposalReviewState>
  setProposalReview: (id: number, patch: Partial<ProposalReviewState>) => void
  proposalLocks: React.MutableRefObject<Set<number>>

  registerLeaveGuard: (guard: ((leave: () => void) => void) | null) => void
  dockView: AssistantView
  setDockView: (view: AssistantView) => void
  turnState: AssistantTurnState
  interruptedTurn: InterruptedTurn | null
  historyError: string | null
  messageError: string | null
  runtimeChanging: boolean
  messageLoading: boolean
  reloadConversations: () => Promise<void>
  reloadMessages: () => Promise<void>
  scrollPositions: React.MutableRefObject<Record<string, number>>
  followLatestRef: React.MutableRefObject<boolean>

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
  memoryError: string | null
  memoryLoading: boolean
  refreshMemory: () => Promise<void>
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
  removeConversation: (conversationId: number) => Promise<boolean>
  renameConversation: (conversationId: number, title: string) => Promise<boolean>
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
  const [proposalReviews, setProposalReviews] = useState<Record<number, ProposalReviewState>>({})
  const proposalLocks = useRef(new Set<number>())
  const setProposalReview = useCallback((id: number, patch: Partial<ProposalReviewState>) => setProposalReviews(current => ({ ...current, [id]: { ...(current[id] ?? { preview: null, context: null, confirmation: null, execution: null, uncertain: false, busy: null, error: null }), ...patch } })), [])
  const [dockView, setDockView] = useState<AssistantView>('chat')
  const leaveGuard = useRef<((leave: () => void) => void) | null>(null)
  const registerLeaveGuard = useCallback((guard: ((leave: () => void) => void) | null) => { leaveGuard.current = guard }, [])
  const mounted = useRef(true)
  const runtimeRequest = useRef(0)
  const statusRequest = useRef(0)
  const messageRequest = useRef(0)
  const historyRequest = useRef(0)
  const activeIdRef = useRef<number | null>(null)
  const sendingRef = useRef(false)
  const scrollPositions = useRef<Record<string, number>>({})
  const followLatestRef = useRef(true)
  const drafts = useRef<Record<string, string>>({})
  const [turnState, setTurnState] = useState<AssistantTurnState>('idle')
  const [interruptedTurn, setInterruptedTurn] = useState<InterruptedTurn | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [messageError, setMessageError] = useState<string | null>(null)
  const runtimeChangingRef = useRef(false)
  const [runtimeChanging, setRuntimeChanging] = useState(false)
  const manuallySelected = useRef(false)
  const [messageLoading, setMessageLoading] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++statusRequest.current; ++messageRequest.current; ++historyRequest.current
      abortRef.current?.abort()
    }
  }, [])

  // ── status ──
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [providerConfigs, setProviderConfigs] = useState<AssistantProviderConfig[]>([])
  const [providerModelOptions, setProviderModelOptions] = useState<AssistantProviderModelOption[]>([])
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  async function refreshAssistantStatus() {
    const request = ++statusRequest.current
    setStatusLoading(true)
    try {
      const [platformStatus, configs, options] = await Promise.all([
        getPlatformStatus(), getAssistantProviderConfigs(), getAssistantProviderModelOptions(),
      ])
      if (!mounted.current || request !== statusRequest.current) return
      if (!platformStatus?.providers || !Array.isArray(configs) || !Array.isArray(options)) throw new Error('Assistant configuration could not be read.')
      setStatus(platformStatus)
      setProviderConfigs(configs)
      setProviderModelOptions(options)
      setStatusError(null)
    } catch (err) {
      if (mounted.current && request === statusRequest.current) setStatusError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current && request === statusRequest.current) setStatusLoading(false)
    }
  }
  useEffect(() => { void refreshAssistantStatus() }, [])

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
      page_state: null,
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
  const inputRef = useRef(input)
  inputRef.current = input
  const [inspectPreview, setInspectPreview] = useState<AssistantToolPreview | null>(null)
  const [inspectExecution, setInspectExecution] = useState<AssistantToolExecution | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamingTool, setStreamingTool] = useState<string | null>(null)
  const [resolvedNote, setResolvedNote] = useState<string | null>(null)
  const memoryRequest = useRef(0)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
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
  const selectionAvailable = !statusError && Boolean(selectedOption?.models.includes(selectedModel))
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

  async function refreshMemory() {
    const id = activeIdRef.current
    const request = ++memoryRequest.current
    setMemoryError(null)
    if (id == null) { setMemory(null); setMemoryLoading(false); return }
    setMemoryLoading(true)
    try {
      const data = await getAssistantMemory(id)
      if (!mounted.current || request !== memoryRequest.current) return
      if (!Array.isArray(data.remembered_genes)) throw new Error('Conversation memory could not be read.')
      setMemory(data)
    } catch (err) { if (mounted.current && request === memoryRequest.current) setMemoryError(err instanceof Error ? err.message : String(err)) }
    finally { if (mounted.current && request === memoryRequest.current) setMemoryLoading(false) }
  }
  const memoryConversation = useRef<number | null>(null)
  useEffect(() => {
    if (memoryConversation.current !== activeIdRef.current) { setMemory(null); memoryConversation.current = activeIdRef.current }
    void refreshMemory()
    return () => { ++memoryRequest.current }
  }, [activeConversation?.id, messages.length])

  async function clearMemory() {
    const id = activeConversation?.id
    if (id == null) return
    try {
      await clearAssistantMemory(id)
      setMemory(await getAssistantMemory(id))
    } catch (err) {
      setError(`Memory could not be cleared: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  function stopStreaming() {
    abortRef.current?.abort()
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && followLatestRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, sending, streamingText, thinkingSegments.length, proposals.length])

  function rememberDraft() {
    drafts.current[String(activeIdRef.current ?? 'new')] = input
    const el = scrollRef.current
    if (el) scrollPositions.current[String(activeIdRef.current ?? 'new')] = el.scrollTop
  }

  async function loadConversationMessages(conversation: AssistantConversation) {
    if (sendingRef.current) return
    manuallySelected.current = true
    rememberDraft()
    const request = ++messageRequest.current
    ++runtimeRequest.current
    runtimeChangingRef.current = false
    setRuntimeChanging(false)
    activeIdRef.current = conversation.id
    setActiveConversation(conversation)
    setInput(drafts.current[String(conversation.id)] ?? '')
    setMessageLoading(true)
    setMessageError(null)
    setError(null)
    setCompactionNotice(false)
    setThinkingSegments([])
    setInterruptedTurn(null)
    setMessages([])
    setProposals([])
    clearInspection()
    try {
      const [rows, proposalRows] = await Promise.all([
        getAssistantMessages(conversation.id),
        getAssistantToolCalls({ conversation_id: conversation.id, status: 'proposed' }),
      ])
      if (!mounted.current || request !== messageRequest.current) return
      if (!Array.isArray(rows) || !Array.isArray(proposalRows)) throw new Error('Conversation data could not be read.')
      setMessages(rows)
      setProposals(proposalRows.filter(row => !proposalReviews[row.id]?.execution?.executed && proposalReviews[row.id]?.confirmation?.status !== 'rejected'))
    } catch (err) {
      if (mounted.current && request === messageRequest.current) setMessageError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current && request === messageRequest.current) setMessageLoading(false)
    }
  }

  async function reloadMessages() {
    const id = activeIdRef.current
    if (id == null || sendingRef.current) return
    const request = ++messageRequest.current
    setMessageLoading(true)
    setMessageError(null)
    try {
      const [rows, calls] = await Promise.all([getAssistantMessages(id), getAssistantToolCalls({ conversation_id: id, status: 'proposed' })])
      if (!mounted.current || request !== messageRequest.current || activeIdRef.current !== id) return
      if (!Array.isArray(rows) || !Array.isArray(calls)) throw new Error('Conversation data could not be read.')
      setMessages(rows)
      setProposals(calls)
      setInterruptedTurn(current => {
        if (!current || current.conversationId !== id) return current
        return current.acceptedMessageId != null && rows.some(row => row.role === 'assistant' && row.id > current.acceptedMessageId!) ? null : { ...current, reconciled: true }
      })
    } catch (err) {
      if (mounted.current && request === messageRequest.current) setMessageError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current && request === messageRequest.current) setMessageLoading(false)
    }
  }

  async function loadConversations() {
    if (sendingRef.current) return
    const request = ++historyRequest.current
    setLoading(true)
    setHistoryError(null)
    try {
      const rows = await getAssistantConversations()
      if (!mounted.current || request !== historyRequest.current) return
      if (!Array.isArray(rows)) throw new Error('Conversation history could not be read.')
      setConversations(rows)
      if (!manuallySelected.current && !sendingRef.current && activeIdRef.current == null && rows[0] && !inputRef.current.trim()) await loadConversationMessages(rows[0])
    } catch (err) {
      if (mounted.current && request === historyRequest.current) setHistoryError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current && request === historyRequest.current) setLoading(false)
    }
  }

  useEffect(() => { void loadConversations() }, [])

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
    if (sending) return
    let cancelled = false
    getAssistantToolCalls({ conversation_id: activeConversation.id, status: 'proposed' })
      .then((proposalRows) => {
        if (!cancelled) setProposals(proposalRows.filter(row => !proposalReviews[row.id]?.execution?.executed && proposalReviews[row.id]?.confirmation?.status !== 'rejected'))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [activeConversation?.id, messages.length, sending])

  async function startNewChat() {
    if (sendingRef.current) return
    manuallySelected.current = true
    ++runtimeRequest.current
    runtimeChangingRef.current = false
    setRuntimeChanging(false)
    rememberDraft()
    ++messageRequest.current
    activeIdRef.current = null
    setMessageError(null)
    setMessageLoading(false)
    setInterruptedTurn(null)
    setTurnState('idle')
    setError(null)
    setCompactionNotice(false)
    setThinkingSegments([])
    clearInspection()
    setActiveConversation(null)
    setMessages([])
    setProposals([])
    setInput(drafts.current.new ?? '')
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
      return false
    }
    setError(null)
    try {
      await deleteAssistantConversation(conversationId)
      setConversations((current) => current.filter((conversation) => conversation.id !== conversationId))
      if (activeIdRef.current === conversationId) {
        ++messageRequest.current
        activeIdRef.current = null
        setInput(drafts.current.new ?? '')
        setInterruptedTurn(null)
        setMessageLoading(false)
        setMessageError(null)
        setActiveConversation(null)
        setMessages([])
        setProposals([])
        clearInspection()
      }
      delete drafts.current[String(conversationId)]
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async function renameConversation(conversationId: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed || sendingRef.current) return false
    setError(null)
    try {
      const updated = await renameAssistantConversation(conversationId, trimmed)
      setConversations((current) => current.map((c) => (c.id === conversationId ? updated : c)))
      if (activeIdRef.current === conversationId) setActiveConversation(updated)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async function selectConversationRuntime(providerId: string, model: string) {
    if (sendingRef.current) return
    const id = activeIdRef.current
    const request = ++runtimeRequest.current
    setError(null)
    if (!activeConversation) {
      setDraftProviderId(providerId)
      setDraftModel(model)
      return
    }
    runtimeChangingRef.current = true
    setRuntimeChanging(true)
    try {
      const updated = await updateAssistantConversation(activeConversation.id, { provider_id: providerId, model })
      if (request !== runtimeRequest.current || id !== activeIdRef.current) return
      setActiveConversation(updated)
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      if (request === runtimeRequest.current && id === activeIdRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === runtimeRequest.current) { runtimeChangingRef.current = false; setRuntimeChanging(false) }
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
    activeIdRef.current = conversation.id
    delete drafts.current.new
    setActiveConversation(conversation)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    return conversation
  }

  async function sendMessage(presetContent?: string) {
    const content = (presetContent ?? input).trim()
    if (!content || sendingRef.current || runtimeChangingRef.current || !selectionAvailable || messageLoading || messageError || (interruptedTurn && !interruptedTurn.reconciled)) return
    sendingRef.current = true
    setSending(true)
    setTurnState('waiting')
    setInterruptedTurn(null)
    setError(null)
    setCompactionNotice(false)
    streamingRef.current = ''
    thinkingRef.current = []
    setThinkingSegments([])
    setInput('')
    drafts.current[String(activeIdRef.current ?? 'new')] = ''
    followLatestRef.current = true
    const lastKnownMessageId = Math.max(0, ...messages.map(message => message.id))
    const tempId = -Date.now()
    let conversationId = activeIdRef.current
    let userMessageId = tempId
    let receivedEvent = false
    let completed = false
    let displayFrame: number | null = null
    function cancelDisplayFrame() {
      if (displayFrame !== null) cancelAnimationFrame(displayFrame)
      displayFrame = null
    }
    const controller = new AbortController()
    abortRef.current = controller
    setMessages(current => [...current, {
      id: tempId, conversation_id: activeConversation?.id ?? 0, role: 'user', content, context,
      status: 'sending', created_at: new Date().toISOString(), provider_id: '', model: '',
    }])
    function applyExchange(exchange: AssistantExchange) {
      if (!mounted.current) return
      completed = true
      cancelDisplayFrame()
      setStreamingText(null)
      setMessages(current => [...current.filter(message => message.id !== tempId && message.id !== exchange.user_message.id), exchange.user_message, exchange.assistant_message])
      setProposals(exchange.proposals ?? [])
      activeIdRef.current = exchange.conversation.id
      setActiveConversation(exchange.conversation)
      setConversations(current => [exchange.conversation, ...current.filter(item => item.id !== exchange.conversation.id)])
    }
    try {
      const conversation = await ensureConversation(content)
      conversationId = conversation.id
      if (controller.signal.aborted) throw new DOMException('Response stopped', 'AbortError')
      try {
        setStreamingText('')
        await streamAssistantMessage(conversation.id, { content, context }, {
          onEvent: () => { receivedEvent = true },
          onUser: message => {
            userMessageId = message.id
            setMessages(current => current.map(item => item.id === tempId ? message : item))
          },
          onDelta: text => {
            streamingRef.current += text
            if (displayFrame === null) displayFrame = requestAnimationFrame(() => {
              displayFrame = null
              if (mounted.current) setStreamingText(streamingRef.current)
            })
            setTurnState('streaming')
          },
          onStatus: tool => {
            cancelDisplayFrame()
            setStreamingTool(tool)
            setTurnState('tool')
            if (streamingRef.current.trim()) {
              thinkingRef.current = [...thinkingRef.current, streamingRef.current.trim()]
              setThinkingSegments(thinkingRef.current)
              streamingRef.current = ''
              setStreamingText('')
            }
          },
          onDone: exchange => {
            applyExchange(exchange)
            setCompactionNotice(Boolean(exchange.compacted))
            const id = exchange.assistant_message.id
            if (thinkingRef.current.length) setMessageThinking(current => ({ ...current, [id]: thinkingRef.current }))
            if (exchange.tool_results?.length) setMessageToolResults(current => ({ ...current, [id]: exchange.tool_results! }))
          },
          onError: message => { throw new Error(message) },
        }, controller.signal)
        if (!completed) throw new Error('The response ended before completion.')
      } catch (err) {
        if (completed) return
        if (controller.signal.aborted || receivedEvent) throw err
        applyExchange(await createAssistantMessage(conversation.id, { content, context }))
      }
      setTurnState('idle')
    } catch (err) {
      if (!mounted.current) return
      const stopped = controller.signal.aborted
      setTurnState(stopped ? 'stopped' : 'interrupted')
      setInterruptedTurn({ conversationId, acceptedMessageId: receivedEvent ? userMessageId === tempId ? lastKnownMessageId : userMessageId : undefined, text: streamingRef.current || thinkingRef.current.join('\n\n'), status: stopped ? 'stopped' : 'interrupted', reconciled: !receivedEvent })
      if (!stopped) setError(err instanceof Error ? err.message : String(err))
      setMessages(current => current.map(message => message.id === userMessageId ? { ...message, status: receivedEvent ? 'stored' : 'failed' } : message))
      if (!receivedEvent) {
        setInput(content)
        drafts.current[String(conversationId ?? 'new')] = content
      } else if (conversationId != null) {
        // Reconcile accepted turns; never send them through the fallback transport again.
        try {
          const rows = await getAssistantMessages(conversationId)
          if (mounted.current && activeIdRef.current === conversationId && Array.isArray(rows)) {
            setMessages(rows)
            setInterruptedTurn(current => rows.some(row => row.role === 'assistant' && row.id > (userMessageId === tempId ? lastKnownMessageId : userMessageId)) ? null : current ? { ...current, reconciled: true } : null)
          }
        } catch (reloadError) {
          setMessageError(`Stored messages could not be reloaded: ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`)
        }
      }
    } finally {
      cancelDisplayFrame()
      sendingRef.current = false
      abortRef.current = null
      if (mounted.current) {
        setStreamingText(null)
        setStreamingTool(null)
        setSending(false)
      }
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
    if (leaveGuard.current) leaveGuard.current(() => setIsOpen(false))
    else setIsOpen(false)
  }

  const value: AssistantContextValue = {
    proposalReviews, setProposalReview, proposalLocks,
    registerLeaveGuard, dockView, setDockView, turnState, interruptedTurn,
    historyError, messageError, messageLoading, runtimeChanging,
    reloadConversations: loadConversations, reloadMessages,
    scrollPositions, followLatestRef,
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
    memory, memoryError, memoryLoading, refreshMemory,
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
  const key = registration.contextKey || assistantRegistrationFallbackKey(registration)
  useEffect(() => {
    if (registration.enabled === false) return
    registerContext(registration)
    return () => clearContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
