import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useLocation } from 'react-router-dom'
import {
  getPlatformStatus,
  getAssistantProviderConfigs,
  warmAssistantProvider,
  getAssistantMemory,
  clearAssistantMemory,
  getAssistantConversations,
  getAssistantMessages,
  getAssistantToolCalls,
  createAssistantConversation,
  deleteAssistantConversation,
  renameAssistantConversation,
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
  PlatformStatus,
} from '../../types'

function parseOptionalNumber(value: string | null): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export interface AssistantContextValue {
  // Panel visibility (used by the docked panel from Phase 2 on; harmless now)
  isOpen: boolean
  openAssistant: (opts?: { prompt?: string }) => void
  openAssistantWithHref: (href: string) => void
  closeAssistant: () => void

  // Platform / provider status
  status: PlatformStatus | null
  providerConfigs: AssistantProviderConfig[]
  statusLoading: boolean
  statusError: string | null
  refreshAssistantStatus: () => Promise<void>
  runtimeReady: boolean
  runtimeLabel: string
  providerConfigured: boolean

  // Page context (reactive to the route; pages can register richer context)
  context: AssistantContext
  registerContext: (ctx: Partial<AssistantContext>) => void
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
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  async function refreshAssistantStatus() {
    setStatusLoading(true)
    try {
      const [platformStatus, configs] = await Promise.all([getPlatformStatus(), getAssistantProviderConfigs()])
      setStatus(platformStatus)
      setProviderConfigs(configs)
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
    Promise.all([getPlatformStatus(), getAssistantProviderConfigs()])
      .then(([data, configs]) => {
        if (!cancelled) {
          setStatus(data)
          setProviderConfigs(configs)
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

  const [registeredContext, setRegisteredContext] = useState<Partial<AssistantContext> | null>(null)
  const registerContext = (ctx: Partial<AssistantContext>) => setRegisteredContext(ctx)
  const clearContext = () => setRegisteredContext(null)
  // Drop stale page context when the route changes (so the dock isn't tied to a page you left).
  useEffect(() => {
    setRegisteredContext(null)
  }, [location.pathname])
  const context = useMemo<AssistantContext>(
    () => (registeredContext ? { ...urlContext, ...registeredContext } : urlContext),
    [urlContext, registeredContext],
  )

  const suggestedPrompt = useMemo(() => new URLSearchParams(location.search).get('prompt') || '', [location.search])

  // ── chat state ──
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
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamingTool, setStreamingTool] = useState<string | null>(null)
  const [resolvedNote, setResolvedNote] = useState<string | null>(null)
  const [memory, setMemory] = useState<AssistantMemory | null>(null)
  const [compactionNotice, setCompactionNotice] = useState(false)
  // The model's intermediate reasoning (text emitted before each tool call) — shown live as a
  // collapsible "thinking" block, then attached per-message once the final answer lands.
  const [thinkingSegments, setThinkingSegments] = useState<string[]>([])
  const [messageThinking, setMessageThinking] = useState<Record<number, string[]>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef('')
  const thinkingRef = useRef<string[]>([])

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

  async function loadConversationMessages(conversation: AssistantConversation) {
    setError(null)
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
    if (suggestedPrompt && !input.trim() && messages.length === 0) {
      setInput(suggestedPrompt)
    }
  }, [suggestedPrompt, input, messages.length])

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
    setActiveConversation(null)
    setMessages([])
    setProposals([])
    setInput('')
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
        setInspectPreview(null)
        setInspectExecution(null)
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

  async function ensureConversation(content: string): Promise<AssistantConversation> {
    if (activeConversation) return activeConversation
    const title = content.trim().slice(0, 64) || 'Assistant chat'
    const conversation = await createAssistantConversation({ title, assistant_surface: 'central', context })
    setActiveConversation(conversation)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    return conversation
  }

  async function sendMessage(presetContent?: string) {
    const content = (presetContent ?? input).trim()
    if (!content || sending) return
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
    if (opts?.prompt) setInput((current) => (current.trim() ? current : opts.prompt!))
  }
  function closeAssistant() {
    setIsOpen(false)
  }

  // Open the dock with the context+prompt encoded in a legacy assistantHref (/assistant?gene=...&prompt=...).
  // Replaces the old "navigate to /assistant" links so the page stays visible beside the chat.
  function openAssistantWithHref(href: string) {
    const q = href.indexOf('?')
    const params = new URLSearchParams(q >= 0 ? href.slice(q + 1) : '')
    setRegisteredContext({
      route: params.get('route') || `${location.pathname}${location.search}`,
      assistant_surface: params.get('surface') || 'central',
      selected_gene: params.get('gene') || null,
      selected_experiment: parseOptionalNumber(params.get('experiment')),
      selected_job: parseOptionalNumber(params.get('job')),
      selected_result: parseOptionalNumber(params.get('result')),
      selected_condition: params.get('condition') || null,
      selected_variant_type: params.get('variant_type') || null,
      selected_builder_section: params.get('builder_section') || null,
    })
    const prompt = params.get('prompt') || ''
    if (prompt) setInput((current) => (current.trim() ? current : prompt))
    setIsOpen(true)
  }

  const value: AssistantContextValue = {
    isOpen,
    openAssistant,
    openAssistantWithHref,
    closeAssistant,
    status,
    providerConfigs,
    statusLoading,
    statusError,
    refreshAssistantStatus,
    runtimeReady,
    runtimeLabel,
    providerConfigured: runtimeReady,
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
    bottomRef,
    scrollRef,
    clearMemory,
    stopStreaming,
    loadConversationMessages,
    startNewChat,
    removeConversation,
    renameConversation,
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
export function useRegisterAssistantContext(ctx: Partial<AssistantContext>) {
  const { registerContext, clearContext } = useAssistant()
  const key = JSON.stringify(ctx)
  useEffect(() => {
    registerContext(ctx)
    return () => clearContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
