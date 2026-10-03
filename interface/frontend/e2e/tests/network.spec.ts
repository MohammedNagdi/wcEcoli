import { test, expect, type Page } from '@playwright/test'
import type { Core } from 'cytoscape'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

const network = {
  total_edges: 5,
  tfs: [
    {
      symbol: 'crp',
      target_count: 3,
      targets: [
        { target: 'dnaA', log2fc: -1.2, log2fc_std: 0.2, type: 'repression' },
        { target: 'leuA', log2fc: 0.7, log2fc_std: 0.1, type: 'activation' },
        { target: 'crp', log2fc: 0.5, log2fc_std: 0.1, type: 'activation' },
      ],
    },
    {
      symbol: 'fur',
      target_count: 1,
      targets: [{ target: 'crp', log2fc: -1, type: 'repression' }],
    },
    {
      symbol: 'lexA',
      target_count: 1,
      targets: [{ target: 'recA', log2fc: -1, type: 'repression' }],
    },
  ],
}
async function ready(page: Page) {
  await expect(page.locator('.network-graph')).toHaveAttribute('data-phase', 'ready')
}
async function graph(page: Page) {
  return page.evaluate(() => {
    const cy = (document.querySelector('.network-graph') as HTMLElement & { _cyreg: { cy: Core } })
      ._cyreg.cy
    return {
      positions: cy.nodes().map((n) => [n.id(), n.position()]),
      pan: cy.pan(),
      zoom: cy.zoom(),
      nodes: cy.nodes().length,
      edges: cy.edges().length,
      hidden: cy.elements('.node-hidden, .edge-hidden').length,
    }
  })
}
async function select(page: Page, gene = 'crp') {
  await page.evaluate((gene) => {
    const cy = (document.querySelector('.network-graph') as HTMLElement & { _cyreg: { cy: Core } })
      ._cyreg.cy
    cy.getElementById(`gene_${gene}`).emit('tap')
  }, gene)
  await expect(page.getByRole('heading', { name: gene, exact: true })).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await mockAssistantApi(page)
  await page.route('**/api/tf-network', (r) => r.fulfill({ json: network }))
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    ;(window as any).__workerCount = 0
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        ;(window as any).__workerCount++
      }
    }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('shell remains usable while loading; concurrent mounts and warm return share work', async ({
  page,
}) => {
  let requests = 0
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/tf-network', async (route) => {
    requests++
    await pending
    await route.fulfill({ json: network })
  })
  await page.goto('/network')
  await expect(page.getByText('Loading network data', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeVisible()
  await page.getByRole('button', { name: 'Help: Network', exact: true }).click()
  await expect(
    page.getByText('This is a static regulatory catalog.', { exact: false }),
  ).toBeVisible()
  release()
  await ready(page)
  expect(requests).toBe(1)
  expect(await page.evaluate(() => (window as any).__workerCount)).toBe(1)
  const positions = (await graph(page)).positions
  await page.evaluate(() => {
    ;(window as any).__previousCore = (document.querySelector('.network-graph') as any)._cyreg.cy
  })
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__previousCore.destroyed())).toBe(true)
  await page.goBack()
  await ready(page)
  expect(requests).toBe(1)
  expect(await page.evaluate(() => (window as any).__workerCount)).toBe(1)
  expect((await graph(page)).positions).toEqual(positions)
})

test('reset clears query, inspector, filters and URL in one replacement; preserves positions', async ({
  page,
}) => {
  await page.goto('/network?keep=example')
  await ready(page)
  const original = await graph(page)
  await select(page)
  await page.getByPlaceholder('Highlight TF or gene...').fill('dna')
  await page.getByRole('button', { name: /^Repression/ }).click()
  await page.getByRole('slider').fill('2')
  await expect.poll(async () => (await graph(page)).hidden).toBeGreaterThan(0)
  await page.evaluate(() => {
    ;(window as any).__replacements = 0
    const replace = history.replaceState.bind(history)
    history.replaceState = (...args) => {
      ;(window as any).__replacements++
      replace(...args)
    }
  })
  await page.getByRole('button', { name: 'Reset network' }).click()
  await expect(page).toHaveURL(/\/network\?keep=example$/)
  await expect(page.getByPlaceholder('Highlight TF or gene...')).toHaveValue('')
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toHaveCount(0)
  await expect(page.getByRole('slider')).toHaveValue('1')
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
  expect(await page.evaluate(() => (window as any).__replacements)).toBe(1)
  const reset = await graph(page)
  expect(reset.positions).toEqual(original.positions)
  expect(reset.hidden).toBe(0)
  expect(reset.zoom).toBeCloseTo(original.zoom, 3)
  expect(await page.evaluate(() => (window as any).__workerCount)).toBe(1)
})

for (const mode of ['Neighborhood', 'Regulon', 'Regulators']) {
  test(`reset from ${mode} restores the cached full graph using the same renderer`, async ({
    page,
  }) => {
    await page.goto('/network?keep=example')
    await ready(page)
    const positions = (await graph(page)).positions
    await page.evaluate(() => {
      ;(window as any).__core = (document.querySelector('.network-graph') as any)._cyreg.cy
    })
    await select(page)
    await page.getByRole('button', { name: mode, exact: true }).click()
    await ready(page)
    await page.getByRole('button', { name: 'Reset network' }).click()
    await ready(page)
    await expect(page).toHaveURL(/\/network\?keep=example$/)
    await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
    expect((await graph(page)).positions).toEqual(positions)
    expect(
      await page.evaluate(
        () =>
          (window as any).__core === (document.querySelector('.network-graph') as any)._cyreg.cy,
      ),
    ).toBe(true)
    expect(await page.evaluate(() => (window as any).__workerCount)).toBe(1)
  })
}

test('reset responds to camera changes and cancels pending gene focus', async ({ page }) => {
  await page.goto('/network')
  await ready(page)
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
  await page.evaluate(() => {
    const cy = (document.querySelector('.network-graph') as HTMLElement & { _cyreg: { cy: Core } })
      ._cyreg.cy
    cy.panBy({ x: 40, y: 40 })
    cy.zoom(cy.zoom() * 1.5)
  })
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reset network' }).click()
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await select(page)
  await page.getByRole('button', { name: 'Reset network' }).click()
  await page.waitForTimeout(900) // Longer than the existing 700ms selection camera animation.
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
})

test('source notes appear only in keyboard-accessible help; links and handlers survive updates', async ({
  page,
}) => {
  await page.goto('/network?gene=crp')
  await ready(page)
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
  await expect(page.getByText('Simulation overlays are paused', { exact: false })).toHaveCount(0)
  await expect(page.getByText('/api/tf-network', { exact: false })).toHaveCount(0)
  const source = page.getByRole('region', { name: 'Network help', includeHidden: true })
  await expect(source).not.toBeVisible()
  const help = page.getByRole('button', { name: 'Help: Network', exact: true })
  await help.focus()
  await page.keyboard.press('Enter')
  await expect(source).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(source).not.toBeVisible()
  await expect(page.getByRole('link', { name: 'Open Workspace' })).toHaveAttribute(
    'href',
    '/explore?gene=crp',
  )
  await expect(page.getByRole('link', { name: 'Genome Map', exact: true }).last()).toHaveAttribute(
    'href',
    '/genome?gene=crp',
  )
  await page.getByPlaceholder('Highlight TF or gene...').fill('fur')
  await select(page, 'fur')
  const handlers = await page.evaluate(() => {
    const cy = (document.querySelector('.network-graph') as any)._cyreg.cy
    return cy._private.emitter.listeners.filter((listener: any) => listener.type === 'tap').length
  })
  expect(handlers).toBe(2)
})

test('request failure offers retry and failed requests are not cached', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/tf-network', (route) =>
    route.fulfill(
      ++attempts === 1 ? { status: 500, json: { detail: 'Unavailable' } } : { json: network },
    ),
  )
  await page.goto('/network')
  await expect(page.getByText('Failed to load network:', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await ready(page)
  expect(attempts).toBe(2)
})

test('worker failure offers retry', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    let attempts = 0
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (++attempts === 1) throw new Error('Worker unavailable')
        super(url, options)
      }
    }
  })
  await page.goto('/network')
  await expect(page.getByText('Failed to arrange network:', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await ready(page)
  expect((await graph(page)).nodes).toBe(6)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('leaving during layout ignores stale completion; return shares pending work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown) {
        setTimeout(() => super.postMessage(message), 700)
      }
    }
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/network')
  await expect(page.getByText('Arranging network', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.goBack()
  await ready(page)
  expect(await page.evaluate(() => (window as any).__workerCount)).toBe(1)
  expect(errors).toEqual([])
})

test('Assistant context reflects the default overview after reset', async ({ page }) => {
  await page.goto('/network?gene=crp&mode=regulon&keep=example')
  await ready(page)
  await page.getByRole('button', { name: 'Reset network' }).click()
  await expect(page.getByRole('button', { name: 'Reset network' })).toBeDisabled()
  await page.getByTestId('assistant-dock-toggle').click()
  const request = page.waitForRequest('**/api/assistant/conversations/*/messages/stream')
  await page.getByTestId('assistant-input').fill('Review this network')
  await page.getByTestId('assistant-send').click()
  const body = (await request).postDataJSON()
  expect(body.context.page_state).toMatchObject({
    kind: 'tf_network',
    selected_gene: null,
    controls: { network_mode: 'full', edge_filter: 'all', min_targets: 1, search_query: '' },
    selected_inspector: null,
  })
  expect(body.context.route).toBe('/network?keep=example')
})

for (const theme of ['light', 'dark']) {
  test(`help and controls remain accessible in ${theme} and fit narrow screens`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('wcecoli.theme', theme), theme)
    await page.goto('/network')
    await ready(page)
    await page.getByRole('button', { name: 'Help: Network', exact: true }).click()
    const help = page.getByRole('region', { name: 'Network help' })
    await expect(help).toBeVisible()
    const results = await new AxeBuilder({ page })
      .include('.network-page')
      .include('[aria-label="Network help"]')
      .analyze()
    expect(results.violations).toEqual([])
    await page.setViewportSize({ width: 390, height: 960 })
    await page.getByRole('button', { name: 'Hide navigation labels' }).click()
    await page.getByRole('button', { name: 'Help: Network', exact: true }).click()
    await expect(help).toBeVisible()
    const bounds = await help.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  })
}
