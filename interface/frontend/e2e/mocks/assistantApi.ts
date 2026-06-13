import type { Page } from '@playwright/test'

/**
 * Mock the assistant + platform API at the browser boundary so the Assistant UI can be tested
 * deterministically against the Vite dev server alone — no backend, Docker, or LLM.
 */

const CTX = {
  route: '/assistant',
  selected_gene: null,
  selected_experiment: null,
  selected_job: null,
  selected_result: null,
  selected_condition: null,
  selected_variant_type: null,
  selected_builder_section: null,
  assistant_surface: 'central',
}

const STATUS = {
  distribution: { mode: 'local_first', runtime: 'Docker Compose', requires_hosted_backend: false, notes: [] },
  providers: {
    mode: 'bring_your_own_key_or_local_endpoint',
    configured_provider_count: 1,
    selected_provider_id: 'openai',
    active_runtime_provider_id: 'openai',
    active_runtime_model: 'gpt-4.1-mini',
    runtime_ready: true,
    runtime_issue: '',
    providers: [],
    notes: [],
  },
  assistant: {
    state: 'read_only_tools_enabled',
    provider_required: true,
    provider_configured: true,
    tool_execution_enabled: true,
    tool_preview_enabled: true,
    execution_enabled_tools: [],
    side_effect_execution_enabled: true,
    db_persistence_enabled: true,
    confirmation_required_for: [],
    context_contract: ['route', 'selected_gene'],
    visible_artifacts: [],
    tool_registry: [],
    notes: [],
  },
}

const CONVERSATION = {
  id: 1, title: 'e2e chat', assistant_surface: 'central', status: 'open',
  provider_id: 'openai', model: 'gpt-4.1-mini', created_at: '', updated_at: '',
}
const MEMORY = { conversation_id: 1, summary: '', covered_up_to_message_id: 0, remembered_genes: [], pending_confirmations: [], recent_unresolved_questions: [] }

export const CREATE_EXPERIMENT_PROPOSAL = {
  id: 10,
  conversation_id: 1,
  message_id: 2,
  tool_name: 'create_experiment',
  status: 'proposed',
  arguments: { gene_symbol: 'dnaA', variant_type: 'gene_knockout', variant_index: 42, condition: 'basal', name: 'dnaA knockout' },
  result: {
    title: 'Create experiment draft',
    description: 'Prepare a dnaA knockout draft under basal.',
    side_effect: true,
    requires_confirmation: true,
    source: 'model_tool_call',
    execution_state: 'not_executed',
    proposal_kind: 'side_effect_preview',
  },
  created_at: '',
  updated_at: '',
}

export const SAVE_CONDITION_PROPOSAL = {
  id: 20,
  conversation_id: 1,
  message_id: 2,
  tool_name: 'save_condition',
  status: 'proposed',
  arguments: {
    name: 'high_glucose', nutrients: 'minimal_glucose', doubling_time: 30,
    active_tfs: ['CRP'], inactive_tfs: [], base_condition: 'basal',
  },
  result: {
    title: 'Save condition draft',
    description: "Save 'high_glucose' as a Conditions Builder draft on media 'minimal_glucose'.",
    side_effect: true,
    requires_confirmation: true,
    source: 'model_tool_call',
    execution_state: 'not_executed',
    proposal_kind: 'side_effect_preview',
  },
  created_at: '',
  updated_at: '',
}

const PREVIEW = {
  tool_name: 'create_experiment',
  valid: true,
  requires_confirmation: true,
  side_effect: true,
  execution_enabled: true,
  normalized_arguments: { ...CREATE_EXPERIMENT_PROPOSAL.arguments, sim_params: '{}' },
  preview: {
    action: 'would_create_experiment_draft',
    summary: "Create 'dnaA knockout' as a gene_knockout draft under condition basal.",
    variant_type: 'gene_knockout',
    gene_symbol: 'dnaA',
    condition: 'basal',
    timeline: 'No time-varying protocol',
    include_wildtype: false,
  },
  warnings: [],
  errors: [],
}

const CONFIRMATION = { id: 1, conversation_id: 1, tool_call_id: 10, action: 'create_experiment', status: 'pending', payload: PREVIEW.normalized_arguments, note: '', created_at: '', resolved_at: '' }

const EXECUTION = {
  tool_name: 'create_experiment',
  executed: true,
  status: 'executed',
  requires_confirmation: true,
  confirmation_id: 1,
  tool_call_id: 11,
  provenance_id: 1,
  normalized_arguments: PREVIEW.normalized_arguments,
  result: { action: 'created_experiment_draft', experiment: { id: 5, name: 'dnaA knockout', variant_type: 'gene_knockout', status: 'draft' }, links: [] },
  warnings: [],
  errors: [],
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

interface MockOptions {
  /** assistant reply text streamed back */
  reply?: string
  /** proposals returned on the terminal `done` event */
  proposals?: unknown[]
  /** status to stamp on the assistant message (e.g. 'provider_call_failed') */
  assistantStatus?: string
  /** if set, stream this as reasoning before a tool call, then the reply as the final answer */
  thinking?: string
  /** authoritative read-only tool outputs to attach to the `done` event (grounded data cards) */
  toolResults?: { tool_name: string; result: Record<string, unknown> }[]
}

export async function mockAssistantApi(page: Page, opts: MockOptions = {}): Promise<void> {
  const reply = opts.reply ?? 'Hello there.'
  const proposals = opts.proposals ?? []
  const userMsg = { id: 1, conversation_id: 1, role: 'user', content: 'hi', context: CTX, status: 'stored', provider_id: '', model: '', created_at: '' }
  const asstMsg = { id: 2, conversation_id: 1, role: 'assistant', content: reply, context: CTX, status: opts.assistantStatus ?? 'completed', provider_id: 'openai', model: 'gpt-4.1-mini', created_at: '' }

  const streamEvents: unknown[] = [
    { type: 'meta', provider_id: 'openai', model: 'gpt-4.1-mini' },
    { type: 'user', message: userMsg },
  ]
  if (opts.thinking) {
    // Reasoning, then a tool runs (folds the reasoning into the thinking trail), then the answer.
    streamEvents.push({ type: 'delta', text: opts.thinking })
    streamEvents.push({ type: 'status', status: 'running_tool', tool: 'list_conditions' })
    streamEvents.push({ type: 'delta', text: reply })
  } else {
    streamEvents.push({ type: 'delta', text: reply.slice(0, Math.ceil(reply.length / 2)) })
    streamEvents.push({ type: 'delta', text: reply.slice(Math.ceil(reply.length / 2)) })
  }
  streamEvents.push({ type: 'done', conversation: CONVERSATION, user_message: userMsg, assistant_message: asstMsg, proposals, tool_results: opts.toolResults ?? [] })
  const streamBody = sse(streamEvents)

  // Catch-all FIRST so the specific handlers below (registered later) take precedence — Playwright
  // invokes the most recently registered matching handler first.
  await page.route('**/api/assistant/**', (r) => r.fulfill({ json: {} }))

  // Platform / provider status
  await page.route('**/api/platform/status', (r) => r.fulfill({ json: STATUS }))
  await page.route('**/api/assistant/status', (r) => r.fulfill({ json: STATUS.assistant }))
  await page.route('**/api/assistant/providers', (r) => r.fulfill({ json: STATUS.providers }))
  await page.route('**/api/assistant/provider-configs', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/assistant/provider-model-options', (r) =>
    r.fulfill({ json: [{ provider_id: 'openai', label: 'OpenAI', models: ['gpt-4.1-mini'] }] }),
  )
  await page.route('**/api/assistant/tools', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/assistant/runtime-settings', (r) =>
    r.fulfill({
      json: {
        request_timeout_sec: 30, local_timeout_sec: 300, ollama_keep_alive: '30m', max_agent_turns: 6,
        keep_recent_turns: 12, compact_threshold: 6, context_token_budget: 3500, confirmation_ttl_sec: 900,
        summary_model: '', updated_at: '',
      },
    }),
  )

  // Conversations + memory + messages
  await page.route('**/api/assistant/conversations', (r) =>
    r.request().method() === 'POST' ? r.fulfill({ json: CONVERSATION }) : r.fulfill({ json: [] }),
  )
  // Rename (PATCH) / get / delete a single conversation. `*` does not cross `/`, so this does not
  // shadow the `conversations/*/memory|messages` routes.
  await page.route('**/api/assistant/conversations/*', (r) => {
    if (r.request().method() === 'PATCH') {
      const body = (r.request().postDataJSON() ?? {}) as { title?: string }
      return r.fulfill({ json: { ...CONVERSATION, title: body.title ?? CONVERSATION.title } })
    }
    if (r.request().method() === 'DELETE') return r.fulfill({ json: { deleted: true } })
    return r.fulfill({ json: CONVERSATION })
  })
  await page.route('**/api/assistant/conversations/*/memory', (r) => r.fulfill({ json: MEMORY }))
  await page.route('**/api/assistant/conversations/*/messages/stream', (r) =>
    r.fulfill({ contentType: 'text/event-stream', body: streamBody }),
  )
  await page.route('**/api/assistant/conversations/*/messages', (r) => r.fulfill({ json: [] }))

  // Audit trail (AssistantAuditPanel mounts even while collapsed and expects arrays)
  await page.route('**/api/assistant/provenance*', (r) => r.fulfill({ json: [] }))

  // Proposals + tool calls + confirmations.
  // After a proposal is dismissed, the refetched "proposed" list must no longer include it.
  let dismissed = false
  await page.route('**/api/assistant/tool-calls/*/dismiss', (r) => {
    dismissed = true
    return r.fulfill({ json: { ...CREATE_EXPERIMENT_PROPOSAL, status: 'executed' } })
  })
  await page.route('**/api/assistant/tool-calls*', (r) => r.fulfill({ json: dismissed ? [] : proposals }))
  await page.route('**/api/assistant/tools/*/preview', (r) => r.fulfill({ json: PREVIEW }))
  await page.route('**/api/assistant/tools/*/execute', (r) => r.fulfill({ json: EXECUTION }))
  await page.route('**/api/assistant/confirmations/*/resolve', (r) => r.fulfill({ json: { ...CONFIRMATION, status: 'approved' } }))
  await page.route('**/api/assistant/confirmations', (r) =>
    r.request().method() === 'POST' ? r.fulfill({ json: CONFIRMATION }) : r.fulfill({ json: [] }),
  )
}
