import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

const genes = [
  {
    id: 1,
    symbol: 'dnaA',
    ecoli_id: 'EG10235',
    synonyms: 'replication',
    category: 'dna_replication',
    left_end_pos: 100,
    right_end_pos: 1500,
    direction: '+',
    ko_index: 42,
    is_mechanistic: true,
  },
  {
    id: 2,
    symbol: 'crp',
    ecoli_id: 'EG10164',
    synonyms: 'cap',
    category: 'regulation',
    left_end_pos: 3000,
    right_end_pos: 3600,
    direction: '-',
    ko_index: 77,
    is_mechanistic: true,
  },
  {
    id: 3,
    symbol: 'aaaD',
    ecoli_id: 'EG00001',
    synonyms: '',
    category: 'other',
    left_end_pos: 4000,
    right_end_pos: 4500,
    direction: '+',
    ko_index: -1,
    is_mechanistic: false,
  },
]
const details = genes.map((gene) => ({
  ...gene,
  rna_ids: `["${gene.symbol}_RNA"]`,
  monomer_id: `${gene.symbol}[c]`,
  monomer_name: `${gene.symbol} protein`,
  complex_ids: '[]',
  regulated_by: [],
  regulates: [],
}))
async function mockWorkspace(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/genes') {
      let rows = genes.filter(
        (gene) =>
          !url.searchParams.get('q') ||
          `${gene.symbol} ${gene.synonyms}`
            .toLowerCase()
            .includes(url.searchParams.get('q')!.toLowerCase()),
      )
      if (url.searchParams.has('category'))
        rows = rows.filter((gene) => gene.category === url.searchParams.get('category'))
      if (url.searchParams.has('mechanistic'))
        rows = rows.filter(
          (gene) => gene.is_mechanistic === (url.searchParams.get('mechanistic') === 'true'),
        )
      return route.fulfill({ json: { genes: rows, total: rows.length, page: 1, page_size: 100 } })
    }
    if (path === '/api/genes/categories')
      return route.fulfill({ json: genes.map((gene) => ({ category: gene.category, count: 1 })) })
    if (path === '/api/design/overview') return route.fulfill({ json: { genes: [] } })
    if (/\/genes\/[^/]+\/neighbors$/.test(path)) return route.fulfill({ json: genes })
    const gene = details.find((gene) => path === `/api/genes/${gene.symbol}`)
    if (gene) return route.fulfill({ json: gene })
    if (path.startsWith('/api/genes/'))
      return route.fulfill({ status: 404, json: { detail: 'Gene not found' } })
    return route.fulfill({ json: [] })
  })
  await mockAssistantApi(page, {})
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await mockWorkspace(page)
})

test('keyboard selection, loaded-row sorting, and inspector destinations', async ({ page }) => {
  await page.goto('/explore?condition=basal')
  await expect(page.getByRole('heading', { name: 'Gene workspace' })).toBeVisible()
  await expect(page.getByLabel('Workspace context')).toContainText('Experiment context:basal')
  await expect(page.getByLabel('Workspace context')).not.toContainText('none')
  await page.getByRole('button', { name: 'Inspect dnaA', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Design knockout', exact: true })).toHaveAttribute(
    'href',
    '/experiments/new?variant=gene_knockout&gene=dnaA',
  )
  await expect(page.getByRole('link', { name: 'Genome Map', exact: true }).last()).toHaveAttribute(
    'href',
    '/genome?gene=dnaA',
  )
  await expect(page.getByRole('button', { name: 'Inspect dnaA', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByText('Sort applies to loaded rows')).toBeVisible()
  await page.getByRole('button', { name: 'Gene', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('columnheader', { name: 'Gene', exact: true })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: 'Search genes', exact: true })).toBeFocused()
})

test('independent disclosures retain choices across genes and isolate collapsed content', async ({
  page,
}) => {
  await page.goto('/explore?gene=dnaA')
  const model = page.getByRole('button', { name: /^Model state IDs/ })
  const genome = page.getByRole('button', { name: /^Genomic context/ })
  await expect(model).toHaveAttribute('aria-expanded', 'false')
  await expect(genome).toHaveAttribute('aria-expanded', 'true')
  await model.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: /^Model state IDs/ })).toContainText('dnaA_RNA')
  await genome.click()
  await expect(genome).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Inspect crp', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
  await expect(model).toHaveAttribute('aria-expanded', 'true')
  await expect(genome).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: /^Model state IDs/ })).toContainText('crp_RNA')
  const target = await genome.getAttribute('aria-controls')
  await expect(page.locator(`[id="${target}"]`).locator('..').locator('..')).toHaveAttribute(
    'inert',
    '',
  )
})

test('help supports keyboard, touch-style clicks, hover, and Escape', async ({ page }) => {
  await page.goto('/explore')
  const help = page.getByRole('button', { name: 'Help: Mechanistic', exact: true })
  await help.focus()
  await page.keyboard.press('Enter')
  await expect(help).toHaveAttribute('aria-expanded', 'true')
  const content = page.getByRole('region', { name: 'Mechanistic help', exact: true })
  await expect(content).toContainText('model coverage, not experimental essentiality')
  await expect(content.getByRole('link', { name: 'Read the guide' })).toHaveAttribute(
    'href',
    '/guide',
  )
  await page.keyboard.press('Tab')
  await expect(content.getByRole('link', { name: 'Read the guide' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(help).toHaveAttribute('aria-expanded', 'false')
  await expect(help).toBeFocused()
  await page.getByRole('heading', { name: 'Gene workspace' }).hover()
  await help.hover()
  await expect(content).toBeVisible()
  await page.getByRole('heading', { name: 'Gene workspace' }).click()
  await expect(help).toHaveAttribute('aria-expanded', 'false')
})

test('divider supports keyboard and pointer resizing within minimum widths', async ({ page }) => {
  await page.goto('/explore')
  const divider = page.getByRole('separator', { name: 'Resize gene catalog' })
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', '57')
  const rect = await divider.boundingBox()
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + 50)
  await page.mouse.down()
  await page.mouse.move(rect!.x - 150, rect!.y + 50)
  await page.mouse.up()
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBeLessThan(57)
  await divider.focus()
  await page.keyboard.press('Home')
  expect(
    (await page.getByRole('region', { name: 'Gene catalog', exact: true }).boundingBox())!.width,
  ).toBeGreaterThanOrEqual(439)
  await page.keyboard.press('End')
  expect(
    (await page.getByRole('region', { name: 'Selected gene inspector' }).boundingBox())!.width,
  ).toBeGreaterThanOrEqual(359)
})

for (const width of [390, 768]) {
  test(`single-pane workspace preserves search and selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/explore')
    const search = page.getByRole('textbox', { name: 'Search genes', exact: true })
    await search.fill('crp')
    await page.getByRole('button', { name: 'Inspect crp', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Selected gene inspector' })).toBeFocused()
    await expect(search).not.toBeVisible()
    await page.getByRole('button', { name: 'Browse genes', exact: true }).click()
    await expect(search).toHaveValue('crp')
    await expect(page.getByRole('button', { name: 'Inspect crp', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('mobile navigation traps focus, closes on Escape, and does not alter other page navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/explore')
  const toggle = page.getByRole('button', { name: 'Open workspace navigation' })
  await toggle.click()
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: 'Guide', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(drawer.getByRole('link', { name: 'wc wcEcoli' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await toggle.click()
  await drawer.getByRole('link', { name: 'Guide', exact: true }).click()
  await expect(page).toHaveURL(/\/guide$/)
  await expect(page.locator('aside')).toBeVisible()
  await expect(toggle).toHaveCount(0)
})

test('missing genes and request failures have distinct recovery actions', async ({ page }) => {
  await page.goto('/explore?gene=missing')
  await expect(page.getByRole('heading', { name: 'No gene found for missing' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear gene selection' }).click()
  await expect(page.getByRole('heading', { name: 'Every gene has a context.' })).toBeVisible()
  await page.route('**/api/genes/dnaA', (route) =>
    route.fulfill({ status: 503, json: { detail: 'Unavailable' } }),
  )
  await page.getByRole('button', { name: 'Inspect dnaA', exact: true }).last().click()
  await expect(page.getByRole('alert')).toContainText('Unable to load dnaA')
  await page.unroute('**/api/genes/dnaA')
  await page.getByRole('button', { name: 'Retry gene details' }).click()
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
})

test('catalog filters, empty results, and request retry', async ({ page }) => {
  await page.goto('/explore')
  await page.getByRole('button', { name: /^Expression-only/ }).click()
  await expect(page.getByRole('button', { name: 'Inspect aaaD', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Inspect crp', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('regulation')
  await expect(page.getByRole('button', { name: 'Inspect crp', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search genes', exact: true }).fill('no match')
  await expect(page.getByText('No genes match your search.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters', exact: true }).last().click()
  await expect(page.getByRole('textbox', { name: 'Search genes', exact: true })).toHaveValue('')
  await page.route('**/api/genes?*', (route) => route.fulfill({ status: 500, json: {} }))
  await page.getByRole('textbox', { name: 'Search genes', exact: true }).fill('crp')
  await expect(page.getByRole('button', { name: 'Retry catalog' })).toBeVisible()
  await page.unroute('**/api/genes?*')
  await page.getByRole('button', { name: 'Retry catalog' }).click()
  await expect(page.getByRole('button', { name: 'Inspect crp', exact: true })).toBeVisible()
})

test('rapid selection cannot display a late response for a previous gene', async ({ page }) => {
  let release!: () => void
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalRequest!: () => void
  const requested = new Promise<void>((resolve) => {
    signalRequest = resolve
  })
  await page.route('**/api/genes/dnaA', async (route) => {
    signalRequest()
    await delayed
    await route.fulfill({ json: details[0] }).catch(() => {})
  })
  await page.goto('/explore')
  await page.getByRole('button', { name: 'Inspect dnaA', exact: true }).first().click()
  await requested
  await page.getByRole('button', { name: 'Inspect crp', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
  release()
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toHaveCount(0)
})

for (const mode of ['light', 'dark', 'system'] as const) {
  test(`workspace accessibility and responsive fit in ${mode} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode === 'system' ? 'dark' : mode })
    await page.addInitScript((mode) => localStorage.setItem('wcecoli.theme', mode), mode)
    await page.goto('/explore?gene=dnaA')
    await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Model state IDs/ }).click()
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 960 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.locator('.gene-workspace').evaluate(async (el) => {
        await Promise.all(
          el
            .getAnimations({ subtree: true })
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished),
        )
      })
      const axe = await new AxeBuilder({ page }).analyze()
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      ).toEqual([])
    }
  })
}

test('reduced motion and 200% effective zoom keep controls usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 720, height: 480 })
  await page.goto('/explore?gene=dnaA')
  await expect(page.getByRole('link', { name: 'Design knockout' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Model state IDs/ })).toBeVisible()
  expect(
    await page
      .locator('.workspace-inspector-content')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none')
  expect(
    await page
      .locator('.workspace-chevron')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s')
  await page.getByRole('button', { name: 'Browse genes', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Search genes', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('loaded pages and catalog scroll survive inspection, with retry for additional pages', async ({
  page,
}) => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...genes[0],
    id: index + 10,
    symbol: `gene${String(index).padStart(3, '0')}`,
  }))
  let failMore = true
  await page.route('**/api/genes?*', (route) => {
    const params = new URL(route.request().url()).searchParams
    if (params.get('page') === '2' && failMore) return route.fulfill({ status: 503, json: {} })
    return route.fulfill({
      json: {
        genes: params.get('page') === '2' ? [genes[1]] : records,
        total: 101,
        page: Number(params.get('page')),
        page_size: 100,
      },
    })
  })
  await page.route('**/api/genes/gene095', (route) =>
    route.fulfill({ json: { ...details[0], ...records[95] } }),
  )
  await page.setViewportSize({ width: 768, height: 960 })
  await page.goto('/explore')
  await expect(page.getByRole('button', { name: 'Inspect gene000', exact: true })).toBeVisible()
  const scroll = page.locator('.workspace-catalog').locator('table').locator('..')
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.getByRole('button', { name: 'Retry loading more' })).toBeVisible()
  failMore = false
  await page.getByRole('button', { name: 'Retry loading more' }).click()
  await expect(page.getByRole('button', { name: 'Inspect crp', exact: true })).toBeVisible()
  const savedScroll = await scroll.evaluate((el) => el.scrollTop)
  await page.getByRole('button', { name: 'Inspect gene095', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'gene095', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Browse genes', exact: true }).click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(savedScroll)
  await expect(page.getByRole('button', { name: 'Inspect gene099', exact: true })).toHaveCount(1)
})

test('pathway loading, failure, and retry do not masquerade as zero matches', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  let retrying = false
  await page.route('**/api/pathways/amino-acids', async (route) => {
    attempts += 1
    if (!retrying) {
      await pending
      return route.fulfill({ status: 503, json: { detail: 'Unavailable' } })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto('/explore?gene=dnaA')
  const disclosure = page.getByRole('button', { name: /^Pathways/ })
  await expect(disclosure).toContainText('Loading pathways')
  await disclosure.click()
  const region = page.getByRole('region', { name: /^Pathways/ })
  await expect(region).not.toContainText('No matching')
  release()
  await expect(disclosure).toContainText('Pathways unavailable')
  await expect(region).toContainText('Unable to load pathway annotations.')
  await expect(disclosure).not.toContainText('0 matches')
  retrying = true
  const initialAttempts = attempts
  await page.getByRole('button', { name: 'Retry pathways', exact: true }).click()
  await expect(disclosure).toContainText('0 matches')
  await expect(region).toContainText('No matching amino acid pathways')
  expect(attempts).toBe(initialAttempts + 1)
})

for (const theme of ['light', 'dark']) {
  for (const width of [390, 768, 1440]) {
    test(`workspace polish keeps coordinates and controls readable at ${width}px in ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('wcecoli.theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize({ width, height: 960 })
      await page.route('**/api/genes?*', (route) => route.fulfill({ json: {
        genes: [{ ...genes[0], left_end_pos: 1234567, right_end_pos: 1239999 }],
        total: 1, page: 1, page_size: 100,
      } }))
      await page.goto('/explore')
      const table = page.getByRole('region', { name: 'Gene catalog table', exact: true })
      await expect(table).toHaveAttribute('tabindex', '0')
      const position = table.locator('tbody tr').first().locator('td').nth(2)
      await expect(position).toContainText('1,234,567-1,239,999')
      const geometry = await position.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        whitespace: getComputedStyle(el).whiteSpace,
        rowHeight: el.parentElement!.getBoundingClientRect().height,
      }))
      expect(geometry.width).toBeGreaterThanOrEqual(200)
      expect(geometry.whitespace).toBe('nowrap')
      expect(geometry.rowHeight).toBeLessThan(75)
      const overflow = await table.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
      await expect(page.getByText('Scroll horizontally for more gene information.')).toHaveCount(overflow ? 1 : 0)
      if (overflow) {
        await table.focus()
        await expect(table).toBeFocused()
        await page.keyboard.press('ArrowRight')
        await expect.poll(() => table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
      }
      await table.evaluate((el) => { el.scrollLeft = 0 })
      await expect(table).toHaveCSS('padding-bottom', '88px')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `/tmp/workspace-polish-${theme}-${width}-catalog.png` })
      await table.getByRole('button', { name: 'Inspect dnaA', exact: true }).click()
      await expect(page.locator('.workspace-gene-title h2')).toHaveCSS('font-size', '22px')
      await expect(page.locator('.workspace-product-description')).toHaveCSS('font-size', '14px')
      await expect(page.locator('.workspace-inspector-scroll')).toHaveCSS('padding-bottom', '88px')
      if (width < 1100) {
        const inspector = page.getByRole('region', { name: 'Selected gene inspector' })
        await expect(inspector).toBeFocused()
        expect(await inspector.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(
          await inspector.evaluate((el) => `rgb(${getComputedStyle(el).getPropertyValue('--color-focus').trim().split(/\s+/).join(', ')})`),
        )
      }
      await expect(page.locator('.workspace-genome-context > div')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await page.screenshot({ path: `/tmp/workspace-polish-${theme}-${width}-inspector.png` })
    })
  }
}
