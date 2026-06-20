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
    const featureRows = Array.from({ length: 12 }, (_, index) => ({
      experiment_id: 100 + index,
      experiment_name: `dnaA seed ${index}`,
      job_id: 500 + index,
      gene_symbol: index % 2 === 0 ? 'dnaA' : 'crp',
      ko_index: index % 2 === 0 ? 42 : 77,
      category: index % 2 === 0 ? 'dna_replication' : 'regulation',
      is_mechanistic: true,
      variant_type: 'gene_knockout',
      variant_index: index % 2 === 0 ? 42 : 77,
      condition: 'basal',
      seed: index,
      divided: index % 3 !== 0,
      division_time_sec: index % 3 !== 0 ? 3600 + index : null,
      final_mass_fg: 1000 + index,
      growth_rate: 0.001 + index * 0.00001,
      doubling_time_min: 45 + index,
    }))
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/ml/data-summary', (r) => r.fulfill({
      json: {
        total_experiments: 12, total_completed_jobs: 12, total_genes: 10, mechanistic_genes: 8,
        divided_count: 8, not_divided_count: 4, conditions: ['basal'], variant_types: ['gene_knockout'],
      },
    }))
    await page.route('**/api/features*', (r) => r.fulfill({
      json: {
        total_rows: featureRows.length,
        total_experiments: featureRows.length,
        total_genes: 2,
        columns: ['gene_symbol', 'condition', 'divided', 'growth_rate', 'doubling_time_min'],
        rows: featureRows,
      },
    }))
    await page.route('**/api/ml/train', (r) => r.fulfill({
      json: {
        model_id: 'model-1',
        algorithm: 'random_forest',
        target: 'divided',
        task_type: 'classification',
        n_samples: 12,
        n_train: 10,
        n_test: 2,
        n_features: 5,
        training_time_sec: 0.42,
        classification: {
          accuracy: 0.75,
          precision: 0.8,
          recall: 0.67,
          f1: 0.73,
          auc_roc: 0.82,
          confusion: { tp: 2, fp: 1, tn: 1, fn: 0 },
        },
        regression: null,
        feature_importances: [
          { feature: 'ko_index', importance: 0.4, gene_symbol: 'dnaA', category: 'dna_replication' },
          { feature: 'growth_rate', importance: 0.25, gene_symbol: '', category: '' },
        ],
        cross_val_scores: [0.7, 0.8, 0.75, 0.78, 0.72],
        cross_val_mean: 0.75,
        cross_val_std: 0.04,
      },
    }))
    await mockAssistantApi(page, { reply: 'ML context received.' })
    await page.goto('/ml')

    await expect(page.getByText('Ask Assistant', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('assistant-dock-toggle')).toBeVisible()

    const conditionSelect = page.locator('label', { hasText: 'Condition' }).locator('..').locator('select')
    await conditionSelect.selectOption('basal')
    const variantSelect = page.locator('label', { hasText: 'Variant type' }).locator('..').locator('select')
    await variantSelect.selectOption('gene_knockout')
    await expect(page.getByText(/12 samples from 12 experiments/)).toBeVisible()
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
        selected_variant_type: 'gene_knockout',
        page_state: {
          kind: 'ml_modeling_workspace',
          dirty: false,
          filters: { condition: 'basal', variant_type: 'gene_knockout', mechanistic_only: true },
          data_summary: { total_completed_jobs: 12, divided_count: 8 },
          feature_matrix: { total_rows: 12, total_genes: 2 },
          train_readiness: { can_train: true, blocking_reason: null },
        },
      },
    })
    const mlBody = request.postDataJSON()
    expect(mlBody.context.page_state.feature_matrix.visible_row_sample).toHaveLength(12)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Train model' }).click()
    await expect(page.getByText('model-1')).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    const trainedRequestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review trained model')
    await page.getByTestId('assistant-send').click()
    const trainedBody = (await trainedRequestPromise).postDataJSON()
    expect(trainedBody.context.page_state).toMatchObject({
      kind: 'ml_modeling_workspace',
      dirty: true,
      training_state: {
        latest_result: {
          model_id: 'model-1',
          task_type: 'classification',
          classification: { accuracy: 0.75 },
          cross_validation: { mean: 0.75 },
        },
        history_sample: [{ model_id: 'model-1' }],
      },
    })
    expect(trainedBody.context.page_state.training_state.latest_result.feature_importances).toEqual(
      expect.arrayContaining([expect.objectContaining({ feature: 'ko_index', importance: 0.4 })])
    )
  })

  test('experiments overview sends active subview page_state to Assistant', async ({ page }) => {
    const experiments = [
      {
        id: 101, name: 'dnaA knockout', description: 'single', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', timeline: '', sim_params: '{"seeds":[0],"generations":1,"length_sec":10800}',
        status: 'draft', created_at: '2026-01-01T00:00:00Z', updated_at: '', gene_symbol: 'dnaA', batch_id: '',
      },
      {
        id: 201, name: 'batch dnaA', description: 'batch', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', timeline: '', sim_params: '{"seed":0,"generations":1,"length_sec":10800}',
        status: 'queued', created_at: '2026-01-02T00:00:00Z', updated_at: '', gene_symbol: 'dnaA', batch_id: 'batch-1',
      },
    ]
    const batch = {
      batch_id: 'batch-1', name: 'dnaA batch', created_at: '2026-01-02T00:00:00Z',
      total: 1, targets: ['dnaA'], variant_types: ['gene_knockout'], conditions: ['basal'], timelines: [],
      draft: 0, queued: 1, running: 0, done: 0, failed: 0, cancelled: 0,
    }
    const failedJob = {
      id: 91, experiment_id: 301, experiment_name: 'failed growth', gene_symbol: 'crp',
      variant_type: 'gene_knockout', variant_index: 77, condition: 'basal', seed: 0,
      phase: 'Failed', error_message: 'x'.repeat(700), started_at: '', finished_at: '2026-01-03T00:00:00Z', created_at: '',
    }

    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/experiments/batches/batch-1', (r) => r.fulfill({ json: { ...batch, experiments: [experiments[1]] } }))
    await page.route('**/api/experiments/batches', (r) => r.fulfill({ json: [batch] }))
    await page.route('**/api/experiments', (r) => r.fulfill({ json: experiments }))
    await page.route('**/api/jobs?experiment_id=101', (r) => r.fulfill({
      json: [{
        id: 501, experiment_id: 101, status: 'pending', phase: '', sim_dir: '', log_tail: 'full log',
        started_at: '', finished_at: '', error_message: '', created_at: '', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', seed: 0, generations: 1, timeline: '',
      }],
    }))
    await page.route('**/api/jobs/failed', (r) => r.fulfill({ json: [failedJob] }))
    await mockAssistantApi(page, { reply: 'Experiments context received.' })

    await page.goto('/experiments')
    await expect(page.getByText('dnaA knockout')).toBeVisible()
    await page.getByText('dnaA knockout').click()
    await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()

    let requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    let body = (await requestPromise).postDataJSON()
    expect(body).toMatchObject({
      context: {
        assistant_surface: 'experiments',
        selected_experiment: 101,
        selected_condition: 'basal',
        selected_variant_type: 'gene_knockout',
        page_state: {
          kind: 'experiments_overview',
          view: 'all',
          selected_experiment: { id: 101, name: 'dnaA knockout' },
          standalone: { selected_id: 101 },
          batch_dashboard: null,
          failed_jobs: null,
          experiment_detail: { kind: 'experiment_detail' },
        },
      },
    })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Batches' }).click()
    await expect(page.getByText('dnaA batch')).toBeVisible()
    const batchDetailResponse = page.waitForResponse('**/api/experiments/batches/batch-1')
    await page.getByText('dnaA batch').click()
    await batchDetailResponse
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review batch')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'experiments_overview',
      view: 'batches',
      standalone: null,
      failed_jobs: null,
      batch_dashboard: {
        kind: 'batch_dashboard',
        total_batches: 1,
        visible_batches: 1,
        expanded_batch_id: 'batch-1',
        expanded_batch: { batch_id: 'batch-1', name: 'dnaA batch', expanded_experiment_count: 1 },
      },
    })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Failed jobs' }).click()
    await expect(page.getByText('#91')).toBeVisible()
    await page.getByText('#91').click()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review failed jobs')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'experiments_overview',
      view: 'failed',
      standalone: null,
      batch_dashboard: null,
      failed_jobs: {
        kind: 'failed_jobs',
        failed_job_count: 1,
        expanded_job_id: 91,
        jobs_sample: [{ id: 91, error_truncated: true }],
      },
    })
    expect(body.context.page_state.failed_jobs.jobs_sample[0].error_message.length).toBeLessThanOrEqual(500)
  })

  test('Explore and knowledge pages send rich page_state to Assistant', async ({ page }) => {
    const genes = [
      {
        id: 1, ecoli_id: 'b3702', symbol: 'dnaA', synonyms: 'thrA', left_end_pos: 100,
        right_end_pos: 1500, direction: '+', category: 'dna_replication', ko_index: 42, is_mechanistic: true,
      },
      {
        id: 2, ecoli_id: 'b3357', symbol: 'crp', synonyms: 'cap', left_end_pos: 3000,
        right_end_pos: 3600, direction: '-', category: 'regulation', ko_index: 77, is_mechanistic: true,
      },
      {
        id: 3, ecoli_id: 'b0074', symbol: 'leuA', synonyms: '', left_end_pos: 5200,
        right_end_pos: 5900, direction: '+', category: 'amino_acid_biosynthesis', ko_index: 88, is_mechanistic: true,
      },
    ]
    const geneDetails = {
      dnaA: {
        ...genes[0], rna_ids: '["RNA_dnaA"]', monomer_id: 'DnaA[c]', monomer_name: 'chromosomal replication initiator',
        complex_ids: '["CPLX_dnaA"]',
        regulated_by: [{ tf: 'crp', log2fc: -1.2, type: 'repression' }],
        regulates: [{ target: 'leuA', log2fc: 0.7, type: 'activation' }],
      },
      crp: {
        ...genes[1], rna_ids: '["RNA_crp"]', monomer_id: 'Crp[c]', monomer_name: 'catabolite activator protein',
        complex_ids: '[]',
        regulated_by: [],
        regulates: [{ target: 'dnaA', log2fc: -1.2, type: 'repression' }],
      },
      leuA: {
        ...genes[2], rna_ids: '["RNA_leuA"]', monomer_id: 'LeuA[c]', monomer_name: '2-isopropylmalate synthase',
        complex_ids: '[]',
        regulated_by: [{ tf: 'crp', log2fc: 0.7, type: 'activation' }],
        regulates: [],
      },
    }
    const designGenes = [
      {
        gene_symbol: 'dnaA', ko_index: 42, category: 'dna_replication', is_mechanistic: true,
        experiment_id: 101, n_seeds: 2, n_completed: 2, divided: false, division_rate: '0/2 divided',
        mean_division_time_min: null, mean_growth_rate: 0.0001, mean_doubling_time_min: 120,
        mean_final_mass_fg: 800, phenotype: 'essential',
      },
      {
        gene_symbol: 'crp', ko_index: 77, category: 'regulation', is_mechanistic: true,
        experiment_id: 102, n_seeds: 2, n_completed: 2, divided: true, division_rate: '2/2 divided',
        mean_division_time_min: 55, mean_growth_rate: 0.001, mean_doubling_time_min: 45,
        mean_final_mass_fg: 1200, phenotype: 'neutral',
      },
      {
        gene_symbol: 'leuA', ko_index: 88, category: 'amino_acid_biosynthesis', is_mechanistic: true,
        experiment_id: 103, n_seeds: 2, n_completed: 2, divided: true, division_rate: '1/2 divided',
        mean_division_time_min: 80, mean_growth_rate: 0.0005, mean_doubling_time_min: 70,
        mean_final_mass_fg: 900, phenotype: 'growth_defect',
      },
    ]
    const pathways = [{
      amino_acid: 'leucine', enzymes: 'leuA', reverse_enzymes: '', kcat: 12,
      ki_lower: 0.1, ki_upper: 0.5, upstream_aas: '{"pyruvate":1}', downstream_aas: '{"valine":1}',
      notes: 'Leucine branch pathway (leuA).',
    }]

    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/genes?*', (r) => r.fulfill({ json: { genes, total: genes.length, page: 1, page_size: 100 } }))
    await page.route('**/api/genes/categories', (r) => r.fulfill({
      json: [
        { category: 'dna_replication', count: 1 },
        { category: 'regulation', count: 1 },
        { category: 'amino_acid_biosynthesis', count: 1 },
      ],
    }))
    await page.route('**/api/genes/dnaA', (r) => r.fulfill({ json: geneDetails.dnaA }))
    await page.route('**/api/genes/crp', (r) => r.fulfill({ json: geneDetails.crp }))
    await page.route('**/api/genes/leuA', (r) => r.fulfill({ json: geneDetails.leuA }))
    await page.route('**/api/design/overview*', (r) => r.fulfill({
      json: {
        total_genes: 3, mechanistic_genes: 3, simulated_genes: 3,
        essential_genes: 1, growth_defect_genes: 1, neutral_genes: 1, unknown_genes: 0,
        genes: designGenes,
      },
    }))
    await page.route('**/api/design/essentiality*', (r) => r.fulfill({
      json: [
        { category: 'dna_replication', total: 1, essential: 1, growth_defect: 0, neutral: 0, unknown: 0, essential_pct: 100 },
        { category: 'regulation', total: 1, essential: 0, growth_defect: 0, neutral: 1, unknown: 0, essential_pct: 0 },
      ],
    }))
    await page.route('**/api/pathways/amino-acids', (r) => r.fulfill({ json: pathways }))
    await page.route('**/api/tf-network', (r) => r.fulfill({
      json: {
        total_edges: 2,
        tfs: [{
          symbol: 'crp',
          target_count: 2,
          targets: [
            { target: 'dnaA', log2fc: -1.2, log2fc_std: 0.2, type: 'repression' },
            { target: 'leuA', log2fc: 0.7, log2fc_std: 0.1, type: 'activation' },
          ],
        }],
      },
    }))
    await mockAssistantApi(page, { reply: 'Explore context received.' })

    await page.goto('/genes?gene=dnaA')
    await expect(page.getByRole('heading', { name: 'dnaA' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    let requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    let body = (await requestPromise).postDataJSON()
    expect(body.context).toMatchObject({
      assistant_surface: 'genes',
      selected_gene: 'dnaA',
      page_state: {
        kind: 'gene_catalog',
        selected_gene: { symbol: 'dnaA', model_state_ids: { monomer_id: 'DnaA[c]' } },
      },
    })
    expect(body.context.page_state.visible_gene_sample).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: 'dnaA' })])
    )
    await page.keyboard.press('Escape')

    await page.goto('/?gene=dnaA')
    await expect(page.getByRole('heading', { name: 'dnaA' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review workspace')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'workspace_gene_explorer',
      selected_gene: 'dnaA',
      selected_gene_detail: { symbol: 'dnaA' },
      embedded_gene_catalog: { kind: 'gene_catalog' },
    })
    await page.keyboard.press('Escape')

    await page.goto('/genome?gene=dnaA')
    await expect(page.getByRole('heading', { name: 'Genome Map' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review genome')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'genome_map',
      selected_gene: 'dnaA',
      counts: { mapped: 3, forward_strand: 2, reverse_strand: 1 },
      selected_gene_summary: { symbol: 'dnaA' },
    })
    await page.keyboard.press('Escape')

    await page.goto('/network?gene=crp&mode=regulon')
    await expect(page.getByText('Static reconstruction network.')).toBeVisible()
    await page.getByRole('button', { name: 'Regulon' }).click()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review network')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'tf_network',
      selected_gene: 'crp',
      controls: { network_mode: 'regulon' },
      selected_inspector: { symbol: 'crp', target_count: 2 },
    })
    await page.keyboard.press('Escape')

    await page.goto('/pathways')
    await expect(page.getByRole('heading', { name: 'Pathways' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review pathways')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'pathways_explorer',
      view: 'heatmap',
      heatmap: { kind: 'essentiality_heatmap' },
      pathway_diagram: null,
    })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Pathway diagram' }).click()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review pathway diagram')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'pathways_explorer',
      view: 'pathway',
      heatmap: null,
      pathway_diagram: { kind: 'aa_pathway_diagram', totals: { pathways: 1 } },
    })
  })

  test('Genome Design sends table and essentiality page_state to Assistant', async ({ page }) => {
    const designGenes = [
      {
        gene_symbol: 'dnaA', ko_index: 42, category: 'dna_replication', is_mechanistic: true,
        experiment_id: 101, n_seeds: 2, n_completed: 2, divided: false, division_rate: '0/2 divided',
        mean_division_time_min: null, mean_growth_rate: 0.0001, mean_doubling_time_min: 120,
        mean_final_mass_fg: 800, phenotype: 'essential',
      },
      {
        gene_symbol: 'crp', ko_index: 77, category: 'regulation', is_mechanistic: true,
        experiment_id: 102, n_seeds: 2, n_completed: 2, divided: true, division_rate: '2/2 divided',
        mean_division_time_min: 55, mean_growth_rate: 0.001, mean_doubling_time_min: 45,
        mean_final_mass_fg: 1200, phenotype: 'neutral',
      },
      {
        gene_symbol: 'leuA', ko_index: 88, category: 'amino_acid_biosynthesis', is_mechanistic: true,
        experiment_id: 103, n_seeds: 2, n_completed: 2, divided: true, division_rate: '1/2 divided',
        mean_division_time_min: 80, mean_growth_rate: 0.0005, mean_doubling_time_min: 70,
        mean_final_mass_fg: 900, phenotype: 'growth_defect',
      },
    ]
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/design/overview*', (r) => r.fulfill({
      json: {
        total_genes: 3, mechanistic_genes: 3, simulated_genes: 3,
        essential_genes: 1, growth_defect_genes: 1, neutral_genes: 1, unknown_genes: 0,
        genes: designGenes,
      },
    }))
    await page.route('**/api/design/essentiality*', (r) => r.fulfill({
      json: [
        { category: 'dna_replication', total: 1, essential: 1, growth_defect: 0, neutral: 0, unknown: 0, essential_pct: 100 },
        { category: 'regulation', total: 1, essential: 0, growth_defect: 0, neutral: 1, unknown: 0, essential_pct: 0 },
      ],
    }))
    await mockAssistantApi(page, { reply: 'Design context received.' })

    await page.goto('/design')
    await expect(page.getByRole('heading', { name: 'Genome Design' })).toBeVisible()
    await page.getByPlaceholder(/Search gene/).fill('dn')
    await page.getByTestId('assistant-dock-toggle').click()
    let requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    let body = (await requestPromise).postDataJSON()
    expect(body.context).toMatchObject({
      assistant_surface: 'design',
      selected_gene: null,
      page_state: {
        kind: 'genome_design_summary',
        view: 'table',
        overview: { total_genes: 3, simulated_genes: 3, simulated_percent: 100 },
        filters: { search: 'dn', exact_selected_gene: null },
        table: {
          visible_gene_count: 1,
          sample: [{ gene_symbol: 'dnaA', phenotype: 'essential' }],
        },
        essentiality_view: null,
      },
    })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Essentiality by category' }).click()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review essentiality')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'genome_design_summary',
      view: 'essentiality',
      table: null,
      essentiality_view: {
        category_count: 2,
      },
    })
    expect(body.context.page_state.essentiality_view.category_sample).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'dna_replication', essential: 1, essential_pct: 100 })])
    )
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

  test('results browser sends active view page_state to Assistant', async ({ page }) => {
    const experiments = [
      {
        id: 101, name: 'dnaA knockout', description: 'batch A', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', timeline: 'shift_glucose', sim_params: '{}',
        status: 'done', created_at: '2026-01-01T00:00:00Z', updated_at: '', gene_symbol: 'dnaA', batch_id: 'batch-1',
      },
    ]
    const jobs = [
      {
        id: 501, experiment_id: 101, status: 'done', phase: 'Complete', sim_dir: '/tmp/sim',
        log_tail: '', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T01:00:00Z',
        error_message: '', created_at: '2026-01-01T00:00:00Z', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', seed: 0, generations: 1, timeline: 'shift_glucose',
      },
      {
        id: 502, experiment_id: 101, status: 'failed', phase: 'Simulation failed', sim_dir: '',
        log_tail: '', started_at: '2026-01-01T02:00:00Z', finished_at: '2026-01-01T02:30:00Z',
        error_message: 'x'.repeat(700), created_at: '2026-01-01T02:00:00Z', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', seed: 1, generations: 1, timeline: 'shift_glucose',
      },
    ]

    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/experiments/101/results', (r) => r.fulfill({
      json: {
        experiment_id: 101, experiment_name: 'dnaA knockout', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', gene_symbol: 'dnaA', total_seeds: 2,
        completed_seeds: 1, failed_seeds: 1, division_rate: '1/2 divided',
        division_time: { mean: 3600, std: null, ci_lower: null, ci_upper: null, n: 1, values: [3600] },
        final_mass: { mean: 1200, std: null, ci_lower: null, ci_upper: null, n: 1, values: [1200] },
        growth_rate: { mean: 0.001, std: null, ci_lower: null, ci_upper: null, n: 1, values: [0.001] },
        doubling_time: { mean: 45, std: null, ci_lower: null, ci_upper: null, n: 1, values: [45] },
        seeds: [
          { job_id: 501, seed: 0, status: 'done', division_time_sec: 3600, final_mass_fg: 1200, growth_rate: 0.001, doubling_time_min: 45 },
          { job_id: 502, seed: 1, status: 'failed', division_time_sec: null, final_mass_fg: null, growth_rate: null, doubling_time_min: null },
        ],
      },
    }))
    await page.route('**/api/experiments/compare?*', (r) => r.fulfill({
      json: {
        experiments: [], wildtype: null, wildtype_suggestion: null,
        deltas: [{ experiment_id: 101, gene_symbol: 'dnaA', division_time_pct: 10, final_mass_pct: -5, growth_rate_pct: -12, doubling_time_pct: 8 }],
      },
    }))
    await page.route('**/api/experiments', (r) => r.fulfill({ json: experiments }))
    await page.route('**/api/jobs', (r) => r.fulfill({ json: jobs }))
    await mockAssistantApi(page, { reply: 'Results context received.' })

    await page.goto('/results')
    await expect(page.getByRole('heading', { name: 'dnaA' })).toBeVisible()
    await page.getByRole('button', { name: /Show seeds/ }).click()
    await expect(page.getByText('1/2 divided')).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()

    let requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    let body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'results_browser',
      view: 'experiments',
      totals: { jobs: 2, done_jobs: 1, failed_jobs: 1 },
      experiments_view: {
        expanded_cards: [{
          kind: 'result_experiment_card',
          experiment: { id: 101, gene_symbol: 'dnaA' },
          aggregation: { division_rate: '1/2 divided' },
        }],
      },
      jobs_view: null,
    })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Job diagnostics' }).click()
    await page.getByTestId('assistant-dock-toggle').click()
    requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-input').fill('review jobs')
    await page.getByTestId('assistant-send').click()
    body = (await requestPromise).postDataJSON()
    expect(body.context.page_state).toMatchObject({
      kind: 'results_browser',
      view: 'jobs',
      experiments_view: null,
      jobs_view: {
        sample: [
          { id: 501, error_truncated: false },
          { id: 502, error_truncated: true },
        ],
      },
    })
    expect(body.context.page_state.jobs_view.sample[1].error_message.length).toBeLessThanOrEqual(500)
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
    await page.route('**/api/experiments/101', (r) => r.fulfill({
      json: {
        id: 101, name: 'dnaA knockout', description: '', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', timeline: 'shift_glucose', sim_params: '{}',
        status: 'done', created_at: '', updated_at: '', gene_symbol: 'dnaA', batch_id: '',
      },
    }))
    await page.route('**/api/genes/by-ko-index/42', (r) => r.fulfill({ json: { symbol: 'dnaA' } }))
    await page.route('**/api/experiments/wt-delta/101', (r) => r.fulfill({
      json: {
        has_wildtype: true, wt_experiment_id: 100, wt_status: 'done',
        division_time_pct: 12, final_mass_pct: -4, growth_rate_pct: -15, doubling_time_pct: 7,
        wt_division_time_min: 50, wt_final_mass_fg: 1100, wt_growth_rate: 0.0012, wt_doubling_time_min: 40,
      },
    }))
    await page.route('**/api/jobs/12/state-explorer?*', (r) => r.fulfill({
      json: { focus_gene: 'dnaA', wt_job_id: 100, variables: [], edges: [] },
    }))
    await page.route('**/api/jobs/12/stoichiometry-neighborhood?*', (r) => r.fulfill({
      json: { focus_gene: 'dnaA', reactions: [] },
    }))
    await page.route('**/api/jobs/12/molecules', (r) => r.fulfill({ json: { available_types: [] } }))
    await page.route('**/api/jobs/12', (r) => r.fulfill({
      json: {
        id: 12, experiment_id: 101, status: 'done', phase: 'Complete', sim_dir: '/tmp/sim', log_tail: '',
        started_at: '', finished_at: '', error_message: '', created_at: '', variant_type: 'wildtype',
        variant_index: 42, condition: 'basal', seed: 0, generations: 1, timeline: 'shift_glucose',
      },
    }))
    await mockAssistantApi(page, {})
    await page.goto('/results/12')

    await expect(page.getByRole('heading', { name: 'dnaA knockout' })).toBeVisible()
    await expect(page).toHaveURL(/gene=dnaA/)
    await expect(page.getByRole('heading', { name: 'dnaA knockout' })).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    await expect(page.getByTestId('assistant-input')).toHaveValue(/Help me interpret this simulation result/)
    const requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    const body = (await requestPromise).postDataJSON()
    expect(body.context).toMatchObject({
      assistant_surface: 'results',
      selected_job: 12,
      selected_experiment: 101,
      selected_gene: 'dnaA',
      selected_condition: 'basal',
      selected_variant_type: 'gene_knockout',
      page_state: {
        kind: 'result_detail',
        selected: { job_id: 12, experiment_id: 101, gene_symbol: 'dnaA' },
        results: { primary_summary: { job_id: 12 } },
        timeseries: { chart_preset: 'overview', active_channels: [] },
        wt_delta: { has_wildtype: true, strongest_delta: { label: 'Growth rate', value: -15 } },
      },
    })
  })

  test('results compare sends comparison page_state to Assistant', async ({ page }) => {
    const experiments = [
      {
        id: 101, name: 'dnaA knockout', description: '', variant_type: 'gene_knockout',
        variant_index: 42, condition: 'basal', timeline: '', sim_params: '{}',
        status: 'done', created_at: '', updated_at: '', gene_symbol: 'dnaA', batch_id: '',
      },
      {
        id: 102, name: 'crp knockout', description: '', variant_type: 'gene_knockout',
        variant_index: 77, condition: 'basal', timeline: '', sim_params: '{}',
        status: 'done', created_at: '', updated_at: '', gene_symbol: 'crp', batch_id: '',
      },
    ]
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await page.route('**/api/experiments/compare?*', (r) => r.fulfill({
      json: {
        experiments: [
          {
            experiment_id: 101, experiment_name: 'dnaA knockout', gene_symbol: 'dnaA',
            variant_type: 'gene_knockout', variant_index: 42, condition: 'basal',
            is_wildtype: false, total_seeds: 2, completed_seeds: 2, divided_seeds: 1,
            division_time_min: { mean: 60, std: 1, n: 2 },
            final_mass_fg: { mean: 1200, std: 10, n: 2 },
            growth_rate: { mean: 0.001, std: 0.0001, n: 2 },
            doubling_time_min: { mean: 45, std: 2, n: 2 },
          },
          {
            experiment_id: 102, experiment_name: 'crp knockout', gene_symbol: 'crp',
            variant_type: 'gene_knockout', variant_index: 77, condition: 'basal',
            is_wildtype: false, total_seeds: 2, completed_seeds: 2, divided_seeds: 2,
            division_time_min: { mean: 50, std: 1, n: 2 },
            final_mass_fg: { mean: 1000, std: 10, n: 2 },
            growth_rate: { mean: 0.0012, std: 0.0001, n: 2 },
            doubling_time_min: { mean: 38, std: 2, n: 2 },
          },
        ],
        wildtype: null,
        wildtype_suggestion: { condition: 'basal', variant_type: 'wildtype', variant_index: 0, message: 'Create WT', recommended_seeds: 2 },
        deltas: [{ experiment_id: 101, gene_symbol: 'dnaA', division_time_pct: 10, final_mass_pct: -5, growth_rate_pct: -12, doubling_time_pct: 8 }],
      },
    }))
    await page.route('**/api/experiments/batches', (r) => r.fulfill({
      json: [{ batch_id: 'batch-1', name: 'dnaA batch', created_at: '', total: 2, targets: ['dnaA'], variant_types: ['gene_knockout'], conditions: ['basal'], timelines: [], draft: 0, queued: 0, running: 0, done: 2, failed: 0, cancelled: 0 }],
    }))
    await page.route('**/api/experiments', (r) => r.fulfill({ json: experiments }))
    await mockAssistantApi(page, { reply: 'Compare context received.' })

    await page.goto('/results/compare?ids=101,102')
    await expect(page.getByText('dnaA knockout')).toBeVisible()
    await page.getByTestId('assistant-dock-toggle').click()
    const requestPromise = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
    await page.getByTestId('assistant-send').click()
    const body = (await requestPromise).postDataJSON()
    expect(body.context).toMatchObject({
      assistant_surface: 'results',
      selected_experiment: null,
      page_state: {
        kind: 'results_compare',
        source_mode: 'ids',
        selected: { count: 2, ids: [101, 102] },
        comparison: {
          experiment_count: 2,
          wildtype_present: false,
          wildtype_suggestion: { condition: 'basal' },
          strongest_deltas: [{ experiment_id: 101, strongest_delta: { label: 'growth_rate_pct', value: -12 } }],
        },
      },
    })
  })

  test('full Assistant deep links still prefill URL prompts and context', async ({ page }) => {
    await mockAssistantApi(page, {})
    await page.goto('/assistant?gene=dnaA&prompt=Explain%20dnaA')

    await expect(page.getByTestId('assistant-input')).toHaveValue('Explain dnaA')
    await expect(page.getByText('You are focused on gene dnaA.')).toBeVisible()
  })
})
