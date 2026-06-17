import { test, expect } from '@playwright/test'
import { mockAssistantApi, CREATE_EXPERIMENT_PROPOSAL, SAVE_CONDITION_PROPOSAL } from '../mocks/assistantApi'

/**
 * Phase 0 regression baseline for the Assistant UI (current page layout).
 * Runs against the Vite dev server with a fully mocked API — deterministic, no backend/LLM.
 */

test.describe('Assistant smoke', () => {
  test('sends a message and renders the streamed reply', async ({ page }) => {
    await mockAssistantApi(page, { reply: 'The platform supports 4,749 genes.' })
    await page.goto('/assistant')

    const input = page.getByTestId('assistant-input')
    await expect(input).toBeVisible()
    await input.fill('How many genes are supported?')
    await page.getByTestId('assistant-send').click()

    // Optimistic user message appears, then the streamed assistant reply.
    await expect(page.getByTestId('message-user')).toContainText('How many genes are supported?')
    await expect(page.getByTestId('message-assistant')).toContainText('The platform supports 4,749 genes.')
  })

  test('proposes an action, then preview → confirm clears the card', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: "I've prepared a dnaA knockout draft for your review.",
      proposals: [CREATE_EXPERIMENT_PROPOSAL],
    })
    await page.goto('/assistant')

    await page.getByTestId('assistant-input').fill('Draft a dnaA knockout under basal.')
    await page.getByTestId('assistant-send').click()

    // A confirmation-gated create_experiment card appears (nothing executed yet).
    const card = page.locator('[data-testid="proposal-card"][data-tool="create_experiment"]')
    await expect(card).toBeVisible()

    // Preview → Confirm.
    await card.getByTestId('proposal-preview').click()
    await expect(card.getByTestId('proposal-confirm')).toBeEnabled()
    await card.getByTestId('proposal-confirm').click()

    // After execution the card is removed from the awaiting-review rail.
    await expect(card).toHaveCount(0)
  })

  test('proposes a save_condition draft, preview → confirm clears it', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: "I've prepared a high_glucose condition draft for your review.",
      proposals: [SAVE_CONDITION_PROPOSAL],
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('Save a high-glucose version of basal.')
    await page.getByTestId('assistant-send').click()

    const card = page.locator('[data-testid="proposal-card"][data-tool="save_condition"]')
    await expect(card).toBeVisible()

    await card.getByTestId('proposal-preview').click()
    // The confirm button is labelled for this tool (not "Create draft experiment").
    await expect(card.getByTestId('proposal-confirm')).toHaveText('Save condition draft')
    await expect(card.getByTestId('proposal-confirm')).toBeEnabled()
    await card.getByTestId('proposal-confirm').click()
    await expect(card).toHaveCount(0)
  })

  test('clears temporary inspection results when starting a new chat', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Inspect aaaD.',
      proposals: [{
        id: 30,
        conversation_id: 1,
        message_id: 2,
        tool_name: 'inspect_gene',
        status: 'proposed',
        arguments: { gene: 'aaaD' },
        result: {
          title: 'Inspect aaaD',
          description: 'Read Genes Table metadata for aaaD.',
          side_effect: false,
          requires_confirmation: false,
          source: 'model_tool_call',
        },
        created_at: '',
        updated_at: '',
      }],
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('inspect aaaD')
    await page.getByTestId('assistant-send').click()
    await page.getByRole('button', { name: 'Run read-only inspection' }).click()
    await expect(page.getByText('Read-only result inspection')).toBeVisible()

    await page.getByRole('button', { name: '+ New chat' }).click()
    await expect(page.getByText('Read-only result inspection')).toHaveCount(0)
  })

  test('renders markdown (bold/headers/lists), not raw characters', async ({ page }) => {
    await mockAssistantApi(page, { reply: '### Genes\n\n- **dnaA** is replication initiator\n- crp is a regulator' })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('Tell me about dnaA')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg).toBeVisible()
    // Bold is a real <strong>, list is a real <li>; the raw markdown chars are gone.
    await expect(msg.locator('strong', { hasText: 'dnaA' })).toBeVisible()
    await expect(msg.locator('li')).toHaveCount(2)
    await expect(msg).not.toContainText('**dnaA**')
    await expect(msg).not.toContainText('### Genes')
  })

  test('does not mangle snake_case identifiers as italics', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Call create_experiment with variant_index and include_wildtype set correctly.',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('how do I make a knockout')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg).toBeVisible()
    // Underscores must survive (GFM treats intraword `_` as literal), so the identifiers read intact
    // and nothing between them gets italicized away.
    await expect(msg).toContainText('create_experiment')
    await expect(msg).toContainText('variant_index')
    await expect(msg).toContainText('include_wildtype')
    await expect(msg.locator('em')).toHaveCount(0)
  })

  test('renders grounded tool data verbatim, independent of the model prose', async ({ page }) => {
    // Model prose is deliberately WRONG (fabricated job id); the grounded card must show the real data.
    await mockAssistantApi(page, {
      reply: 'You have results. Job ID 999, experiment fictional.',
      toolResults: [{
        tool_name: 'list_results',
        result: {
          results: [
            { job_id: 12, experiment_name: 'manY knockout follow-up', condition: 'basal', gene_symbol: 'manY',
              metrics: { growth_rate: { mean: 0.00024 }, doubling_time_min: { mean: 47.96 } } },
          ],
        },
      }],
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('list my results')
    await page.getByTestId('assistant-send').click()

    const grounded = page.getByTestId('grounded-results')
    await expect(grounded).toBeVisible()
    // The authoritative table shows the REAL job id + experiment, not the model's fabricated one.
    await expect(grounded.locator('table')).toContainText('manY knockout follow-up')
    await expect(grounded.locator('table tbody tr td').first()).toHaveText('12')
    await expect(grounded).toContainText('from platform data')
    await expect(grounded).not.toContainText('999')
  })

  test('shows the reasoning trail separately from the final answer', async ({ page }) => {
    await mockAssistantApi(page, {
      thinking: 'I need a job id to read channels; let me check conditions first.',
      reply: 'Here are the available output channels.',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('what channels are available')
    await page.getByTestId('assistant-send').click()

    // Final answer lands in the assistant bubble; reasoning is NOT in it.
    const msg = page.getByTestId('message-assistant')
    await expect(msg).toContainText('Here are the available output channels.')
    await expect(msg).not.toContainText('I need a job id')

    // The reasoning is preserved in a collapsible "Thought process" block.
    const thought = page.getByText(/Thought process/)
    await expect(thought).toBeVisible()
    await thought.click()
    await expect(page.getByText('I need a job id to read channels; let me check conditions first.')).toBeVisible()
  })

  test('renames a conversation inline', async ({ page }) => {
    await mockAssistantApi(page, { reply: 'ok' })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('hello')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('message-assistant')).toBeVisible()

    // The conversation now shows in the left panel — rename it inline.
    await page.getByRole('button', { name: /^Rename / }).first().click()
    const editor = page.getByLabel('Conversation name')
    await editor.fill('My renamed chat')
    await editor.press('Enter')
    await expect(page.getByText('My renamed chat').first()).toBeVisible()
  })

  test('renders a GFM table', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Comparison:\n\n| Gene | KO index |\n|------|----------|\n| dnaA | 42 |\n| crp | 84 |',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('compare')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg.locator('table')).toBeVisible()
    await expect(msg.locator('th')).toHaveCount(2)
    await expect(msg.locator('tbody tr')).toHaveCount(2)
    await expect(msg).not.toContainText('|------|') // separator row is not shown literally
  })

  test('surfaces a provider error clearly', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Ollama call failed. Check the endpoint is reachable. No side effects were executed.',
      assistantStatus: 'provider_call_failed',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('hi')
    await page.getByTestId('assistant-send').click()

    await expect(page.getByTestId('message-assistant')).toContainText('Ollama call failed')
    await expect(page.getByText('provider error')).toBeVisible() // friendly status badge
  })

  test('keeps the model selector popover visible and local-provider specific', async ({ page }) => {
    await mockAssistantApi(page, {
      providerModelOptions: [
        { provider_id: 'openai', label: 'OpenAI', models: ['gpt-4.1-mini'] },
        { provider_id: 'ollama', label: 'Ollama', models: ['llama3.1'] },
      ],
    })
    await page.goto('/assistant')

    await page.getByTestId('model-pill').click()
    const popover = page.getByTestId('model-popover')
    await expect(popover).toBeVisible()

    const box = await popover.boundingBox()
    expect(box).not.toBeNull()
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)

    const topElementIsPopover = await page.evaluate(() => {
      const popover = document.querySelector('[data-testid="model-popover"]')
      if (!popover) return false
      const rect = popover.getBoundingClientRect()
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 8)
      return Boolean(element?.closest('[data-testid="model-popover"]'))
    })
    expect(topElementIsPopover).toBe(true)
    await expect(popover).not.toContainText('Local models need free RAM')

    await popover.locator('select').first().selectOption('ollama')
    await expect(popover).toContainText('Local models need free RAM')
  })

  test('docked panel: summon from another page, chat, Esc to close', async ({ page }) => {
    // Quiet other pages' own data calls. Anchor to the API origin so we don't intercept the app's
    // own /src/api/* module scripts.
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await mockAssistantApi(page, { reply: 'There are 4,749 genes.' })
    await page.goto('/guide') // a non-assistant page

    // Summon the dock (it's not the /assistant route).
    await page.getByTestId('assistant-dock-toggle').click()
    const input = page.getByTestId('assistant-input')
    await expect(input).toBeVisible()
    await input.fill('How many genes?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('message-assistant')).toContainText('There are 4,749 genes.')

    // Esc closes the dock and restores the floating toggle.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('assistant-input')).toHaveCount(0)
    await expect(page.getByTestId('assistant-dock-toggle')).toBeVisible()
  })

  test('floating Assistant preserves page prompt and reactive context without a page-level trigger', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/ml/data-summary', (r) => r.fulfill({
      json: {
        total_experiments: 2, total_completed_jobs: 2, total_genes: 10, mechanistic_genes: 8,
        divided_count: 1, not_divided_count: 1, conditions: ['basal'], variant_types: ['gene_knockout'],
      },
    }))
    await page.route('**/api/features*', (r) => r.fulfill({
      json: { total_rows: 0, total_experiments: 0, total_genes: 0, columns: [], rows: [] },
    }))
    await mockAssistantApi(page, { reply: 'ML context received.' })
    await page.goto('/ml')

    await expect(page.getByText('Ask Assistant', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('assistant-dock-toggle')).toBeVisible()

    const conditionSelect = page.locator('label', { hasText: 'Condition' }).locator('..').locator('select')
    await conditionSelect.selectOption('basal')
    await page.getByTestId('assistant-dock-toggle').click()

    const input = page.getByTestId('assistant-input')
    await expect(input).toHaveValue(/Help me assess this ML setup/)
    await expect(page.getByText(/reviewing simulation-derived ML readiness for basal/)).toBeVisible()

    const requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    const request = await requestPromise
    expect(request.postDataJSON()).toMatchObject({
      context: {
        assistant_surface: 'ml',
        selected_condition: 'basal',
      },
    })
  })

  test('floating Assistant preserves drafts and clears stale registered page context', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await mockAssistantApi(page, {})
    await page.goto('/results')

    await page.getByTestId('assistant-dock-toggle').click()
    const input = page.getByTestId('assistant-input')
    await expect(input).toHaveValue(/Help me triage the Results browser/)
    await input.fill('Keep this draft')
    await page.keyboard.press('Escape')

    await page.getByRole('link', { name: 'Guide' }).click()
    await page.getByTestId('assistant-dock-toggle').click()
    await expect(page.getByTestId('assistant-input')).toHaveValue('Keep this draft')
    await expect(page.getByText('You are in the central Assistant workspace.')).toBeVisible()
  })

  test('result details register the current job for assistant inspection', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/jobs/12/timeseries', (r) => r.fulfill({
      json: {
        summary: [{
          job_id: 12, seed: 0, generation: 0, division_time_sec: null,
          final_mass_fg: null, growth_rate: null, doubling_time_min: null,
        }],
        timeseries: {},
      },
    }))
    await page.route('**/api/jobs/12', (r) => r.fulfill({
      json: {
        id: 12, experiment_id: 0, status: 'failed', phase: '', sim_dir: '', log_tail: '',
        started_at: '', finished_at: '', error_message: '', created_at: '', variant_type: 'wildtype',
        variant_index: 0, condition: 'basal', seed: 0, generations: 1, timeline: '',
      },
    }))
    await mockAssistantApi(page, {})
    await page.goto('/results/12')

    await page.getByTestId('assistant-dock-toggle').click()
    await expect(page.getByRole('button', { name: 'Inspect current result (Job #12)' })).toBeVisible()
    await expect(page.getByTestId('assistant-input')).toHaveValue(/Help me interpret this simulation result/)
  })

  test('full Assistant deep links still prefill URL prompts and context', async ({ page }) => {
    await mockAssistantApi(page, {})
    await page.goto('/assistant?gene=dnaA&prompt=Explain%20dnaA')

    await expect(page.getByTestId('assistant-input')).toHaveValue('Explain dnaA')
    await expect(page.getByText('You are focused on gene dnaA.')).toBeVisible()
  })
})
