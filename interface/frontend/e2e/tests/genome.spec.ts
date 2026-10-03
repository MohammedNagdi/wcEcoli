import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'
const genes = [
  {
    id: 1,
    symbol: 'dnaA',
    ecoli_id: 'EG10235',
    synonyms: 'replication initiator',
    category: 'dna_replication',
    left_end_pos: 500000,
    right_end_pos: 501400,
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
    left_end_pos: 505000,
    right_end_pos: 505600,
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
    left_end_pos: null,
    right_end_pos: null,
    direction: null,
    ko_index: -1,
    is_mechanistic: false,
  },
]
const details = genes.map((gene) => ({
  ...gene,
  monomer_name: `${gene.symbol} protein`,
  monomer_id: `${gene.symbol}[c]`,
  rna_ids: '[]',
  complex_ids: '[]',
  regulated_by: [],
  regulates: [],
}))
async function mockGenome(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/genes')
      return route.fulfill({ json: { genes, total: 3, page: 1, page_size: 500 } })
    if (path.endsWith('/neighbors')) return route.fulfill({ json: genes.slice(0, 2) })
    const detail = details.find((gene) => path === `/api/genes/${gene.symbol}`)
    if (detail) return route.fulfill({ json: detail })
    if (path.startsWith('/api/genes/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
  await mockAssistantApi(page, {})
}
const camera = (page: Page) => page.getByTestId('genome-camera')
const search = (page: Page) => page.getByRole('textbox', { name: 'Search genome genes' })
const cameraState = (page: Page) =>
  camera(page).evaluate((element) =>
    [
      element.getAttribute('data-zoom'),
      element.getAttribute('data-pan-x'),
      element.getAttribute('data-pan-y'),
    ].join(','),
  )
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await mockGenome(page)
})

test('gene and neighbor selection stay on the map and preserve camera and URL context', async ({
  page,
}) => {
  await page.goto('/genome?gene=dnaA&source=reference&genomeHighlight=regulation')
  await expect(
    page.locator('.genome-load-status').getByText('2 mapped genes', { exact: false }),
  ).toBeVisible()
  await expect(camera(page)).toHaveAttribute('data-zoom', '8')
  const original = await cameraState(page)
  await page.locator('path[data-gene="crp"]').click()
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
  expect(await cameraState(page)).toBe(original)
  await expect(page).toHaveURL(/source=reference/)
  await expect(page).toHaveURL(/genomeHighlight=regulation/)
  await expect(page).toHaveURL(/\/genome\?.*gene=crp/)
  await page
    .getByRole('group', { name: 'Genomic context around crp' })
    .getByRole('button', { name: 'Select dnaA', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
  expect(await cameraState(page)).toBe(original)
  await expect(page.getByRole('link', { name: 'Design knockout' })).toHaveAttribute(
    'href',
    '/experiments/new?variant=gene_knockout&gene=dnaA',
  )
  await page.getByRole('link', { name: 'Open in workspace' }).click()
  await expect(page).toHaveURL('/explore?gene=dnaA')
})

test('search uses symbols, identifiers and synonyms while selection remains independent', async ({
  page,
}) => {
  await page.goto('/genome')
  for (const term of ['crp', 'EG10164', 'cap']) {
    await search(page).fill(term)
    await expect(page.getByRole('button', { name: 'Inspect crp on map' })).toBeVisible()
    await expect(page.locator('path[data-gene="crp"]')).toHaveAttribute('opacity', '0.9')
  }
  const original = await cameraState(page)
  await page.getByRole('button', { name: 'Inspect crp on map' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toBeVisible()
  expect(await cameraState(page)).toBe(original)
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(search(page)).toHaveValue('')
  await expect(page).toHaveURL(/gene=crp/)
  await search(page).fill('missing')
  await expect(page.getByText('No matching genes.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Clear selection' }).click()
  await expect(search(page)).toHaveValue('missing')
})

test('deep links, explicit focus, fit, keyboard controls and zoom limits', async ({ page }) => {
  await page.goto('/genome?gene=dnaA')
  await expect(camera(page)).toHaveAttribute('data-zoom', '8')
  await page.getByRole('button', { name: 'Fit genome' }).click()
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
  await expect(page).toHaveURL(/gene=dnaA/)
  await page.getByRole('button', { name: 'Focus gene', exact: true }).click()
  await expect(camera(page)).toHaveAttribute('data-zoom', '8')
  const map = page.getByRole('group', { name: 'Interactive chromosome map', exact: true })
  await map.focus()
  const original = await cameraState(page)
  await page.keyboard.press('ArrowRight')
  expect(await cameraState(page)).not.toBe(original)
  for (let i = 0; i < 8; i++) await page.keyboard.press('+')
  await expect(camera(page)).toHaveAttribute('data-zoom', '16')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
  for (let i = 0; i < 15; i++) await page.keyboard.press('-')
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
})

test('dragging over a gene scales correctly and suppresses selection; ordinary and Shift-wheel never zoom the map', async ({
  page,
}) => {
  await page.goto('/genome?gene=dnaA')
  await expect(camera(page)).toHaveAttribute('data-zoom', '8')
  const rect = await page.locator('path[data-gene="dnaA"]').boundingBox()
  const map = page.getByRole('group', { name: 'Interactive chromosome map', exact: true })
  const mapRect = await page.locator('.genome-map-frame').boundingBox()
  const before = Number(await camera(page).getAttribute('data-pan-x'))
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect!.x + rect!.width / 2 + 40, rect!.y + rect!.height / 2, { steps: 4 })
  await page.mouse.up()
  const after = Number(await camera(page).getAttribute('data-pan-x'))
  expect(after - before).toBeCloseTo((40 * 800) / mapRect!.width, 0)
  await expect(page).toHaveURL('/genome?gene=dnaA')
  await page.getByRole('button', { name: 'Fit genome' }).click()
  await map.dispatchEvent('wheel', {
    deltaY: -300,
    clientX: 700,
    clientY: 500,
    bubbles: true,
    cancelable: true,
  })
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
  for (const modifier of ['shiftKey', 'metaKey']) {
    const prevented = await map.evaluate((element, modifier) => {
      const wheel = new WheelEvent('wheel', {
        deltaY: -300,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      })
      element.dispatchEvent(wheel)
      return wheel.defaultPrevented
    }, modifier)
    expect(prevented).toBe(false)
    await expect(camera(page)).toHaveAttribute('data-zoom', '1')
  }
})

test('category emphasis retains genes; legend and tabs explain scientific units', async ({
  page,
}) => {
  await page.goto('/genome')
  await page.getByRole('button', { name: 'Highlight categories', exact: true }).click()
  await page
    .getByRole('group', { name: 'Category highlights' })
    .getByRole('button', { name: /Transcriptional regulation/ })
    .click()
  await expect(page.locator('path[data-gene]')).toHaveCount(2)
  await expect(page).toHaveURL(/genomeHighlight=regulation/)
  await page.getByRole('button', { name: 'Clear highlights' }).click()
  await expect(page).not.toHaveURL(/genomeHighlight/)
  await page.getByRole('tab', { name: 'Legend & statistics' }).click()
  const legend = page.getByRole('tabpanel', { name: 'Legend & statistics' })
  await expect(legend).toContainText('Outer track: forward')
  await expect(legend).toContainText('4,641,652 bp')
  await expect(legend).toContainText('Reference GC content')
  await page.getByRole('tab', { name: 'Legend & statistics' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Gene details' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('missing, unmapped, failed and stale gene requests have safe recovery', async ({ page }) => {
  await page.goto('/genome?gene=missing')
  await expect(page.getByRole('heading', { name: 'Gene unavailable' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear selection' }).click()
  await search(page).fill('aaaD')
  await page.getByRole('button', { name: 'Inspect aaaD on map' }).click()
  await expect(page.getByRole('heading', { name: 'aaaD', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Focus gene', exact: true })).toBeDisabled()
  await expect(
    page.getByText('This gene has no mapped coordinates.', { exact: false }),
  ).toBeVisible()
  await page.route('**/api/genes/dnaA', (route) => route.fulfill({ status: 503, json: {} }))
  await search(page).fill('dnaA')
  await page.getByRole('button', { name: 'Inspect dnaA on map' }).click()
  await expect(page.getByRole('heading', { name: 'Unable to load dnaA' })).toBeVisible()
  await page.unroute('**/api/genes/dnaA')
  await page.getByRole('button', { name: 'Retry gene details' }).click()
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
  let release: () => void = () => {}
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/genes/crp', async (route) => {
    await delayed
    await route.fulfill({ json: details[1] })
  })
  await search(page).fill('crp')
  await page.getByRole('button', { name: 'Inspect crp on map' }).click()
  await search(page).fill('dnaA')
  await page.getByRole('button', { name: 'Inspect dnaA on map' }).click()
  release()
  await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'crp', exact: true })).toHaveCount(0)
})

test('initial and partial loading failures retry without duplicate batches', async ({ page }) => {
  await page.route('**/api/genes?*', (route) => route.fulfill({ status: 503, json: {} }))
  await page.goto('/genome')
  await expect(page.getByRole('alert')).toContainText('Unable to load genome data')
  await page.unroute('**/api/genes?*')
  await page.getByRole('button', { name: 'Retry genome data' }).click()
  await expect(
    page.locator('.genome-load-status').getByText('2 mapped genes', { exact: false }),
  ).toBeVisible()
  const batch = Array.from({ length: 500 }, (_, id) => ({ ...genes[0], id, symbol: `gene${id}` }))
  let release: () => void = () => {}
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/genes?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('page') === '1')
      return route.fulfill({ json: { genes: batch, total: 503, page: 1, page_size: 500 } })
    await delayed
    return route.fulfill({ status: 503, json: {} })
  })
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'counts are provisional' })).toBeVisible()
  release()
  await expect(page.getByRole('alert')).toContainText('Only part of the genome loaded')
  await expect(page.locator('path[data-gene]')).toHaveCount(500)
  await page.unroute('**/api/genes?*')
  await page.getByRole('button', { name: 'Retry genome data' }).click()
  await expect(page.locator('path[data-gene]')).toHaveCount(2)
})

for (const mode of ['light', 'dark', 'system']) {
  test(`responsive navigation, zoom and accessibility in ${mode}`, async ({ page }) => {
    await page.emulateMedia({
      colorScheme: mode === 'light' ? 'light' : 'dark',
      reducedMotion: 'reduce',
    })
    await page.addInitScript((theme) => localStorage.setItem('wcecoli.theme', theme), mode)
    await page.goto('/genome?gene=dnaA')
    await expect(page.getByRole('heading', { name: 'dnaA', exact: true })).toBeVisible()
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await expect(page.getByRole('complementary', { name: 'Genome inspector' })).toBeVisible()
      expect(
        (await page.getByRole('complementary', { name: 'Genome inspector' }).boundingBox())!.width,
      ).toBeGreaterThanOrEqual(300)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    }
    const navigation = page.getByRole('button', { name: 'Open genome map navigation' })
    await navigation.click()
    await expect(page.getByRole('dialog', { name: 'Genome Map navigation' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(navigation).toBeFocused()
    await page.setViewportSize({ width: 720, height: 480 })
    await page.getByRole('button', { name: 'Fit genome' }).click()
    await expect(camera(page)).toHaveAttribute('data-zoom', '1')
    expect(
      await page
        .locator('.genome-gene-details')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none')
  })
}

test('neighbor request failure stays distinct from an empty region and can retry', async ({
  page,
}) => {
  await page.route('**/api/genes?page_size=5000', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.goto('/genome?gene=dnaA')
  await expect(page.getByRole('alert')).toContainText('Unable to load neighboring genes.')
  await expect(page.getByText('No neighboring genes with genomic coordinates found.')).toHaveCount(
    0,
  )
  await page.unroute('**/api/genes?page_size=5000')
  await page.getByRole('button', { name: 'Retry neighboring genes' }).click()
  await expect(page.getByRole('group', { name: 'Genomic context around dnaA' })).toBeVisible()
  await expect(page).toHaveURL('/genome?gene=dnaA')
})

test('button zoom changes only the map and all enlarged edges remain scrollable', async ({
  page,
}) => {
  await page.goto('/genome')
  await expect(page.locator('path[data-gene]')).toHaveCount(2)
  const frame = page.locator('.genome-map-frame')
  const before = await frame.boundingBox()
  const header = await page.locator('.workspace-page-header').boundingBox()
  const width = await page.evaluate(() => innerWidth)
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, -400)
  await page.keyboard.up('Shift')
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
  await expect(page.locator('#genome-map-instructions')).toHaveCount(0)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect
    .poll(async () => Number(await camera(page).getAttribute('data-zoom')))
    .toBeGreaterThan(1)
  expect(await page.evaluate(() => innerWidth)).toBe(width)
  expect((await page.locator('.workspace-page-header').boundingBox())!.width).toBe(header!.width)
  expect((await frame.boundingBox())!.width).toBe(before!.width)
  const dimensions = await frame.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.width)
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height)
  await frame.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() =>
      frame.evaluate((element) =>
        Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft),
      ),
    )
    .toBeLessThan(2)
  await frame.evaluate((element) => {
    element.scrollLeft = 0
    element.scrollTop = 0
  })
  await expect
    .poll(() => frame.evaluate((element) => element.scrollLeft + element.scrollTop))
    .toBe(0)
  await page.getByRole('button', { name: 'Fit genome' }).click()
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
})

test('trackpad pinch zooms only the map and respects zoom limits', async ({ page }) => {
  await page.goto('/genome?gene=dnaA')
  await page.getByRole('button', { name: 'Fit genome' }).click()
  const map = page.locator('.genome-map-frame')
  const rect = await map.boundingBox()
  const width = await page.evaluate(() => innerWidth)
  await map.dispatchEvent('wheel', {
    ctrlKey: true,
    deltaY: -50,
    clientX: rect!.x + rect!.width / 2,
    clientY: rect!.y + rect!.height / 2,
    cancelable: true,
    bubbles: true,
  })
  await expect
    .poll(async () => Number(await camera(page).getAttribute('data-zoom')))
    .toBeGreaterThan(1)
  expect(await page.evaluate(() => innerWidth)).toBe(width)
  await expect(page).toHaveURL('/genome?gene=dnaA')
  await map.dispatchEvent('wheel', { ctrlKey: true, deltaY: -1000, cancelable: true })
  await expect(camera(page)).toHaveAttribute('data-zoom', '16')
  await map.dispatchEvent('wheel', { ctrlKey: true, deltaY: 1000, cancelable: true })
  await expect(camera(page)).toHaveAttribute('data-zoom', '1')
})

test('Safari gesture pinch zooms locally without changing selection', async ({ page }) => {
  await page.goto('/genome?gene=dnaA')
  await page.getByRole('button', { name: 'Fit genome' }).click()
  const map = page.locator('.genome-map-frame')
  await map.evaluate((el) => {
    for (const [type, scale] of [
      ['gesturestart', 1],
      ['gesturechange', 2],
      ['gestureend', 2],
    ] as const) {
      const event = new Event(type, { cancelable: true, bubbles: true })
      Object.assign(event, { scale })
      el.dispatchEvent(event)
      if (!event.defaultPrevented) throw new Error('Browser pinch was not intercepted')
    }
  })
  await expect(camera(page)).toHaveAttribute('data-zoom', '2')
  await expect(page).toHaveURL('/genome?gene=dnaA')
})

test('two-finger touch pinch zooms around its midpoint', async ({ page, browserName }) => {
  await page.goto('/genome')
  const map = page.locator('.genome-map-frame')
  const rect = await map.boundingBox()
  const x = rect!.x + rect!.width / 2,
    y = rect!.y + rect!.height / 2
  if (browserName === 'chromium') {
    const client = await page.context().newCDPSession(page)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: x - 40, y, id: 0 },
        { x: x + 40, y, id: 1 },
      ],
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 80, y, id: 0 },
        { x: x + 80, y, id: 1 },
      ],
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await map.evaluate(
      (el, { x, y }) => {
        for (const [type, distance] of [
          ['touchstart', 40],
          ['touchmove', 80],
          ['touchend', 0],
        ] as const) {
          const event = new Event(type, { cancelable: true, bubbles: true })
          Object.assign(event, {
            touches: distance
              ? [
                  { clientX: x - distance, clientY: y },
                  { clientX: x + distance, clientY: y },
                ]
              : [],
          })
          el.dispatchEvent(event)
        }
      },
      { x, y },
    )
  }
  await expect
    .poll(async () => Number(await camera(page).getAttribute('data-zoom')))
    .toBeCloseTo(2, 1)
  await expect(page).toHaveURL('/genome')
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1)
})
