import { test, expect, type Page } from '@playwright/test'
import { mockAssistantApi } from '../mocks/assistantApi'
import AxeBuilder from '@axe-core/playwright'
import type { Experiment } from '../../src/types'

const first: Experiment = { id: 101, name: 'dnaA knockout', description: 'Replication test', variant_type: 'gene_knockout', variant_index: 42, condition: 'basal', timeline: '0 minimal', sim_params: JSON.stringify({ seeds: 2, generations: 3, length_sec: 7200, custom: { enabled: true } }), status: 'draft', created_at: '2026-01-01T00:00:00Z', updated_at: '', gene_symbol: 'dnaA', batch_id: '' }
const second: Experiment = { ...first, id: 102, name: 'crp test', gene_symbol: 'crp', condition: 'with_aa', created_at: '2026-01-02T00:00:00Z', variant_index: 77 }
const batchMember = { ...first, id: 201, batch_id: 'batch-1', status: 'running', name: 'Batch dnaA' }
const batch = { batch_id: 'batch-1', name: 'Regulation batch', created_at: '2026-01-03T00:00:00Z', total: 3, targets: ['dnaA'], variant_types: ['gene_knockout'], conditions: ['basal'], timelines: ['0 minimal'], draft: 0, queued: 0, running: 1, done: 1, failed: 1, cancelled: 0 }
const failed = { id: 91, experiment_id: 101, experiment_name: first.name, gene_symbol: first.gene_symbol, variant_type: first.variant_type, variant_index: 42, condition: 'basal', seed: 0, phase: 'Simulation failed', error_message: 'Insufficient memory', started_at: '', finished_at: '2026-01-03T00:00:00Z', created_at: '' }
const gene = (symbol: string) => ({ id: symbol === 'dnaA' ? 1 : 2, symbol, ecoli_id: 'EG1', synonyms: '', category: 'regulation', ko_index: symbol === 'dnaA' ? 42 : 77, direction: '+', left_end_pos: 1, right_end_pos: 100, is_mechanistic: true, tu_ids: [], rna_ids: [], protein_ids: [], pathway_ids: [], regulation: { incoming: [], outgoing: [] } })
const job = { id: 501, experiment_id: 101, status: 'running_parca', phase: 'Preparing parameters', sim_dir: '', log_tail: 'parameter log', started_at: '2026-01-01T00:00:00Z', finished_at: '', error_message: '', created_at: '', variant_type: 'gene_knockout', variant_index: 42, condition: 'basal', seed: 0, generations: 3, timeline: '' }

async function setup(page: Page, source = first) {
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
  await mockAssistantApi(page)
  await page.route('**/api/experiments', (route) => route.fulfill({ json: [first, second, batchMember] }))
  await page.route(/\/api\/experiments\/\d+$/, (route) => {
    const id = Number(route.request().url().split('/').pop())
    return route.fulfill({ json: id === source.id ? source : id === second.id ? second : batchMember })
  })
  await page.route('**/api/experiments/batches', (route) => route.fulfill({ json: [batch] }))
  await page.route('**/api/experiments/batches/batch-1', (route) => route.fulfill({ json: { ...batch, experiments: [batchMember] } }))
  await page.route('**/api/jobs/failed', (route) => route.fulfill({ json: [failed] }))
  await page.route('**/api/jobs?experiment_id=*', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/variants', (route) => route.fulfill({ json: ['gene_knockout', 'multi_gene_knockout', 'timelines', 'param_sensitivity', 'tf_activity'].map((name) => ({ name, description: name })) }))
  await page.route('**/api/experiments/variants/*', (route) => route.fulfill({ json: { name: source.variant_type, docstring: '', parameter_hints: { timeline_behavior: 'composer' } } }))
  await page.route('**/api/conditions', (route) => route.fulfill({ json: [{ id: 1, name: 'basal', media_id: 'minimal' }, { id: 2, name: 'with_aa', media_id: 'rich' }] }))
  await page.route(/\/api\/genes\/[^/?]+$/, (route) => route.fulfill({ json: gene(decodeURIComponent(route.request().url().split('/').pop()!)) }))
}

test('search, filters, sort, selection and independent clearing', async ({ page }) => {
  await setup(page)
  await page.goto('/experiments?keep=yes')
  const catalog = page.getByRole('tabpanel', { name: 'Single experiments' })
  await expect(catalog.getByRole('status').filter({ hasText: 'Showing' })).toHaveText('Showing 2 of 2')
  await expect(catalog.locator('tbody tr').first()).toContainText(second.name)
  await catalog.getByRole('button', { name: /Created/ }).click()
  await expect(catalog.locator('tbody tr').first()).toContainText(first.name)
  await page.getByLabel('Find an experiment', { exact: true }).fill('DNAA')
  await expect(catalog.getByRole('status').filter({ hasText: 'Showing' })).toHaveText('Showing 1 of 2')
  await page.getByRole('button', { name: 'Inspect dnaA knockout' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: first.name })).toBeVisible()
  await expect(page).toHaveURL(/keep=yes.*experiment=101/)
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(catalog.getByRole('status').filter({ hasText: 'Showing' })).toHaveText('Showing 2 of 2')
  await expect(page.getByRole('heading', { name: first.name })).toBeVisible()
  await page.getByRole('button', { name: 'Inspect dnaA knockout' }).click()
  await expect(page.getByRole('heading', { name: first.name })).toBeVisible()
  await catalog.getByLabel('Condition', { exact: true }).selectOption('with_aa')
  await expect(catalog.getByRole('status').filter({ hasText: 'Showing' })).toHaveText('Showing 1 of 2')
})

test('view history, batch selection, status counts and retained search', async ({ page }) => {
  await setup(page)
  await page.goto('/experiments?keep=yes')
  await page.getByLabel('Find an experiment', { exact: true }).fill('dnaA')
  await page.getByRole('tab', { name: 'Batches', exact: true }).click()
  await page.getByLabel('Find a batch', { exact: true }).fill('regulation')
  await page.getByRole('button', { name: batch.name, exact: true }).click()
  await expect(page.getByText('Finished 2 of 3')).toBeVisible()
  await page.getByRole('button', { name: batchMember.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: batchMember.name })).toBeVisible()
  await page.getByRole('button', { name: 'Close experiment details' }).click()
  await page.getByRole('tab', { name: 'Failed jobs' }).click()
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Batches' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Find a batch', { exact: true })).toHaveValue('regulation')
  await expect(page.getByRole('button', { name: batchMember.name, exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Single experiments' }).click()
  await expect(page.getByLabel('Find an experiment', { exact: true })).toHaveValue('dnaA')
})

test('initial failures cannot masquerade as empty catalogs and Retry recovers', async ({ page }) => {
  await setup(page)
  let failing = true
  await page.route('**/api/experiments', (route) => failing ? route.fulfill({ status: 503, json: { detail: 'Offline' } }) : route.fulfill({ json: [first] }))
  await page.route('**/api/jobs/failed', (route) => failing ? route.fulfill({ status: 503, json: { detail: 'Offline' } }) : route.fulfill({ json: [] }))
  await page.goto('/experiments')
  await expect(page.getByRole('tabpanel', { name: 'Single experiments' }).getByRole('alert')).toBeVisible()
  await expect(page.getByText('No experiments yet')).not.toBeVisible()
  failing = false
  await page.getByRole('tabpanel', { name: 'Single experiments' }).getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Inspect dnaA knockout' })).toBeVisible()
  await page.getByRole('tab', { name: 'Failed jobs' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Failed jobs' }).getByRole('alert')).toBeVisible()
  await expect(page.getByText('No failed jobs', { exact: true })).not.toBeVisible()
  await page.getByRole('tabpanel', { name: 'Failed jobs' }).getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('No failed jobs', { exact: true })).toBeVisible()
})

test('save failure retains edits and discard dialog contains and restores focus', async ({ page }) => {
  await setup(page)
  await page.route('**/api/experiments/101', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { detail: 'Save failed' } }) : route.fulfill({ json: first }))
  await page.goto('/experiments?experiment=101')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Experiment name', { exact: true }).fill('Changed name')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Save failed')
  await expect(page.getByLabel('Experiment name', { exact: true })).toHaveValue('Changed name')
  await page.getByRole('button', { name: 'Inspect crp test' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved edits?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Discard edits' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByLabel('Experiment name', { exact: true })).toHaveValue('Changed name')
  await page.getByRole('button', { name: 'Close experiment details' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard edits' }).click()
  await expect(page).not.toHaveURL(/experiment=/)
})

test('rapid selection ignores delayed jobs from the previous experiment', async ({ page }) => {
  await setup(page)
  let release: (() => void) | undefined
  await page.route('**/api/jobs?experiment_id=101', async (route) => { await new Promise<void>((resolve) => { release = resolve }); await route.fulfill({ json: [job] }).catch(() => {}) })
  await page.goto('/experiments')
  await page.getByRole('button', { name: 'Inspect dnaA knockout' }).click()
  await expect.poll(() => !!release).toBe(true)
  await page.getByRole('button', { name: 'Inspect crp test' }).click()
  release!()
  await page.getByRole('tab', { name: /Simulation jobs/ }).click()
  await expect(page.getByText('No simulation jobs yet.', { exact: false })).toBeVisible()
  await expect(page.getByText('Preparing parameters')).not.toBeVisible()
})

for (const status of ['waiting_parca', 'running_parca', 'running_sim', 'ingesting', 'cancelling', 'recovering']) {
  test(`jobs continue polling in ${status}, with logs and cancel confirmation`, async ({ page }) => {
    await setup(page, { ...first, status })
    let requests = 0
    await page.route('**/api/jobs?experiment_id=101', (route) => { requests++; return route.fulfill({ json: [{ ...job, status }] }) })
    await page.clock.install()
    await page.goto('/experiments?experiment=101')
    await page.getByRole('tab', { name: /Simulation jobs/ }).click()
    await expect(page.getByText('Preparing parameters')).toBeVisible()
    const before = requests
    await page.clock.fastForward(5100)
    await expect.poll(() => requests).toBeGreaterThan(before)
    await page.getByRole('button', { name: 'Logs', exact: true }).click()
    await expect(page.getByLabel('Logs for job 501')).toHaveText('parameter log')
    if (status !== 'cancelling') {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByRole('alertdialog', { name: 'Cancel simulation job' })).toBeVisible()
      await page.keyboard.press('Escape')
    }
  })
}

for (const variant of ['gene_knockout', 'multi_gene_knockout', 'timelines', 'param_sensitivity', 'tf_activity']) {
  test(`Duplicate ${variant} preserves the full configuration without submitting jobs`, async ({ page }) => {
    const params = { seed_values: [7, 19], generations: 3, length_sec: 7200, custom: { enabled: true }, ...(variant === 'multi_gene_knockout' ? { multi_gene_knockout: { gene_symbols: ['dnaA', 'crp'], ko_indices: [42, 77] } } : {}) }
    const source = { ...first, variant_type: variant, variant_index: variant === 'multi_gene_knockout' ? 0 : variant === 'gene_knockout' ? 42 : 2, gene_symbol: variant === 'multi_gene_knockout' ? 'dnaA,crp' : variant === 'gene_knockout' ? 'dnaA' : '', sim_params: JSON.stringify(params) }
    await setup(page, source)
    let submitted: Record<string, unknown> | null = null
    let runs = 0
    await page.route('**/api/experiments', (route) => {
      if (route.request().method() === 'POST') { submitted = route.request().postDataJSON(); return route.fulfill({ json: { ...source, id: 999, name: `${source.name} (copy)`, status: 'draft' } }) }
      return route.fulfill({ json: [source] })
    })
    await page.route('**/api/experiments/*/run', (route) => { runs++; return route.fulfill({ json: {} }) })
    await page.goto('/experiments/new?duplicate=101&gene=crp&condition=with_aa')
    await expect(page.getByRole('heading', { name: 'Design experiment' })).toBeVisible()
    await page.getByRole('button', { name: 'Save experiment', exact: true }).click()
    await expect.poll(() => submitted).not.toBeNull()
    expect(submitted).toMatchObject({ name: `${source.name} (copy)`, description: source.description, variant_type: variant, variant_index: source.variant_index, condition: source.condition, timeline: source.timeline })
    expect(JSON.parse(String(submitted!.sim_params))).toEqual(params)
    expect(submitted).not.toHaveProperty('batch_id')
    if (variant === 'multi_gene_knockout') expect(submitted!.gene_symbols).toEqual(['dnaA', 'crp'])
    expect(runs).toBe(0)
  })
}

for (const invalid of ['missing', 'malformed']) {
  test(`Duplicate reports ${invalid} source and retries`, async ({ page }) => {
    await setup(page)
    let broken = true
    await page.route('**/api/experiments/101', (route) => broken ? invalid === 'missing' ? route.fulfill({ status: 404, json: { detail: 'Experiment not found' } }) : route.fulfill({ json: { ...first, sim_params: '{broken' } }) : route.fulfill({ json: first }))
    await page.goto('/experiments/new?duplicate=101')
    await expect(page.getByRole('heading', { name: 'Could not duplicate experiment' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save experiment' })).not.toBeVisible()
    broken = false
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Design experiment' })).toBeVisible()
  })
}

for (const width of [390, 768, 1440]) {
  test(`responsive inspection, themes and accessibility at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await setup(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/experiments')
    await page.getByRole('button', { name: 'Inspect dnaA knockout' }).click()
    await expect(page.getByRole('heading', { name: first.name })).toBeVisible()
    if (width < 1100) {
      await expect(page.getByRole('button', { name: 'Inspect dnaA knockout' })).not.toBeVisible()
      await page.getByRole('button', { name: 'Back to experiments' }).click()
      await expect(page.getByRole('button', { name: 'Inspect dnaA knockout' })).toBeVisible()
    }
    if (width < 640) {
      await page.getByRole('button', { name: 'Open experiments navigation', exact: true }).click()
      await expect(page.getByRole('dialog', { name: /navigation/i })).toBeVisible()
      await page.keyboard.press('Escape')
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => { localStorage.setItem('wcecoli.theme', value) }, theme)
      await page.reload()
      await expect(page.getByRole('tab', { name: 'Single experiments' })).toBeVisible()
      const violations = (await new AxeBuilder({ page }).analyze()).violations
      expect(violations).toEqual([])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      expect(overflow).toBe(false)
    }
  })
}

test('polling shares initial work, retains rows after failure and stops after navigation', async ({ page }) => {
  await setup(page)
  let requests = 0
  let failing = false
  await page.route('**/api/experiments', async (route) => {
    requests++
    await route.fulfill(failing ? { status: 503, json: { detail: 'Refresh unavailable' } } : { json: [{ ...first, status: 'running_sim' }] })
  })
  await page.clock.install()
  await page.goto('/experiments')
  await expect(page.getByRole('button', { name: 'Inspect dnaA knockout' })).toBeVisible()
  expect(requests).toBe(1)
  failing = true
  await page.clock.fastForward(5100)
  const catalog = page.getByRole('tabpanel', { name: 'Single experiments' })
  await expect(catalog.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Inspect dnaA knockout' })).toBeVisible()
  failing = false
  await catalog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(catalog.getByRole('alert')).not.toBeVisible()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Explore, simulate, and understand E. coli.' })).toBeVisible()
  const before = requests
  await page.clock.fastForward(11000)
  expect(requests).toBe(before)
})

test('200% effective zoom keeps catalog and inspector actions usable', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 720, height: 500 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  await page.goto('/experiments')
  await page.getByRole('button', { name: 'Inspect dnaA knockout' }).click()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Duplicate', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to experiments' }).click()
  await expect(page.getByLabel('Find an experiment', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
})

for (const width of [768, 1440]) {
  test(`expanded experiment details can scroll to their final line at ${width}px`, async ({ page }) => {
    await setup(page)
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/experiments?experiment=101')
    const inspector = page.getByRole('complementary', { name: 'Experiment details' })
    await inspector.getByText('Media protocol', { exact: true }).click()
    await inspector.getByText('Technical details', { exact: true }).click()
    const parameters = inspector.locator('pre').last()
    await parameters.scrollIntoViewIfNeeded()
    await inspector.hover()
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => parameters.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.bottom <= innerHeight - 20 && bounds.top >= 0
    })).toBe(true)
    expect(await page.locator('main').evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
  })
}

test('assistant settings and experiment edits each guard navigation beside the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto('/experiments?experiment=101')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Experiment name', { exact: true }).fill('Unsaved experiment')
  await page.getByTestId('assistant-dock-toggle').click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Max agent turns', { exact: false }).fill('8')
  await page.getByRole('link', { name: 'Genome Map', exact: true }).click()
  const experimentDialog = page.getByRole('alertdialog', { name: 'Discard unsaved edits?' })
  await expect(experimentDialog).toBeVisible()
  await experimentDialog.getByRole('button', { name: 'Discard edits' }).click()
  const assistantDialog = page.getByRole('alertdialog', { name: 'Discard unsaved settings?' })
  await expect(assistantDialog).toBeVisible()
  await assistantDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/experiments/)
  await page.getByRole('link', { name: 'Genome Map', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click()
  await expect(page).toHaveURL(/genome/)
})
