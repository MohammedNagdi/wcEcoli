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

  // Page context (reactive to the route)
  context: AssistantContext
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
  bottomRef: RefObject<HTMLDivElement>

  // Actions
  clearMemory: () => Promise<void>
  stopStreaming: () => void
  loadConversationMessages: (conversation: AssistantConversation) => Promise<void>
  startNewChat: () => Promise<void>
  removeConversation: (conversationId: number) => Promise<void>
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
  const context = useMemo<AssistantContext>(() => {
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending, streamingText])

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
              setStreamingText((prev) => (prev ?? '') + text)
            },
            onStatus: (tool) => setStreamingTool(tool),
            onDone: (payload) => {
              streamed = true
              applyExchange(payload as unknown as AssistantExchange)
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

  const value: AssistantContextValue = {
    isOpen,
    openAssistant,
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
    bottomRef,
    clearMemory,
    stopStreaming,
    loadConversationMessages,
    startNewChat,
    removeConversation,
    sendMessage,
    inspectCurrentResult,
    runReadOnlyProposal,
    handleProposalResolved,
  }

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>
}
