import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

async function mockPlatform(page: import('@playwright/test').Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/genes')
      return route.fulfill({ json: { genes: [], total: 0, page: 1, page_size: 100 } })
    if (path === '/api/genes/search')
      return route.fulfill({
        json: [
          {
            id: 1,
            symbol: 'dnaA',
            ecoli_id: 'EG10235',
            category: 'replication',
            is_mechanistic: true,
          },
        ],
      })
    if (path === '/api/genes/dnaA') return route.fulfill({ json: null })
    return route.fulfill({ json: [] })
  })
  await mockAssistantApi(page, {})
}

test.beforeEach(async ({ page }) => {
  await mockPlatform(page)
})

test('introduction links lead to working tools and the existing shell', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Explore, simulate, and understand E. coli.',
  )
  await expect(page.locator('aside')).toHaveCount(0)
  await expect(page.getByTestId('assistant-dock-toggle')).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(
    main.getByRole('link', { name: 'Design an experiment', exact: true }),
  ).toHaveAttribute('href', '/experiments/new')
  await expect(main.getByRole('link', { name: 'Browse results', exact: true })).toHaveAttribute(
    'href',
    '/results',
  )
  await expect(main.getByRole('link', { name: 'Read the guide', exact: true })).toHaveAttribute(
    'href',
    '/guide',
  )
  await main.getByRole('link', { name: 'Open workspace', exact: true }).first().click()
  await expect(page).toHaveURL(/\/explore$/)
  await expect(page.getByRole('heading', { name: 'Gene workspace', exact: true })).toBeVisible()
  await expect(page.locator('aside')).toBeVisible()
  await expect(page.getByTestId('assistant-dock-toggle')).toBeVisible()
  await page.locator('aside').getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
})

for (const query of [
  'gene=dnaA',
  'q=dnaA',
  'category=replication',
  'condition=basal',
  'view=genes',
]) {
  test(`preserves the legacy workspace link ${query}`, async ({ page }) => {
    await page.goto(`/?${query}&source=bookmark#selected`)
    await expect(page).toHaveURL(`/explore?${query}&source=bookmark#selected`)
    await expect(page.getByRole('heading', { name: 'Gene workspace', exact: true })).toBeVisible()
  })
}

test('ordinary introduction query parameters do not redirect', async ({ page }) => {
  await page.goto('/?utm_source=course#how-it-works')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveURL(/\/?\?utm_source=course#how-it-works$/)
})

test('FAQ supports disclosure, arrow navigation, and collapsed focus isolation', async ({
  page,
}) => {
  await page.goto('/')
  const question = page.getByRole('button', { name: 'What does wcEcoli model?', exact: true })
  await question.focus()
  await page.keyboard.press('Enter')
  await expect(question).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('region', { name: 'What does wcEcoli model?' })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('button', { name: 'How do I start my first experiment?' }),
  ).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('button', { name: 'Where can I find help?' })).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(question).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#faq-answer-0')).toHaveAttribute('inert', '')
})

test('mobile navigation opens, closes on Escape, and follows destinations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true })
  await expect(page.locator('#home-mobile-menu')).toHaveAttribute('inert', '')
  await toggle.click()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Open workspace' })
    .click()
  await expect(page).toHaveURL(/\/explore$/)
})

for (const mode of ['light', 'dark'] as const) {
  test(`introduction is accessible and previews load in ${mode} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('wcecoli.theme', value), mode)
    await page.goto('/')
    await expect
      .poll(() =>
        page
          .locator('main img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true)
    await expect(page.locator('main img').first()).toHaveAttribute(
      'src',
      `/previews/workspace${mode === 'dark' ? '-dark' : ''}.webp`,
    )
    // Each crop has its own aspect ratio; reserve the right space before it loads
    // and offer a sharp source for high-density screens.
    const previews = page.locator('main img')
    for (const [index, height] of [960, 730, 1005].entries()) {
      const preview = previews.nth(index)
      await expect(preview).toHaveAttribute('width', '1200')
      await expect(preview).toHaveAttribute('height', String(height))
      await expect(preview).toHaveAttribute('srcset', /-2400\.webp 2400w/)
      const proportions = await preview.evaluate((element) => {
        const image = element as HTMLImageElement
        return { source: image.naturalWidth / image.naturalHeight, layout: image.clientWidth / image.clientHeight }
      })
      expect(proportions.source).toBeCloseTo(1200 / height, 2)
      expect(proportions.layout).toBeCloseTo(proportions.source, 2)
    }
    await page.locator('.home-hero-copy').evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)) })
    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([])
    await page.getByRole('button', { name: 'What does wcEcoli model?' }).click()
    const expanded = await new AxeBuilder({ page }).analyze()
    expect(
      expanded.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([])
  })
}

for (const width of [390, 768, 1440]) {
  test(`introduction fits the ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })
}

test('reduced motion disables entrance, disclosure movement, and smooth scrolling', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const motion = await page.locator('.home-hero-copy').evaluate((element) => ({
    animation: getComputedStyle(element).animationName,
    transform: getComputedStyle(element).transform,
    scroll: getComputedStyle(document.documentElement).scrollBehavior,
  }))
  expect(motion).toEqual({ animation: 'none', transform: 'none', scroll: 'auto' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('header remains usable at 200% zoom', async ({ page }) => {
  // Browser zoom at 200% halves the CSS viewport of a 1440x960 window.
  // CSS zoom does not change media-query breakpoints, so use the effective viewport.
  await page.setViewportSize({ width: 720, height: 480 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
  const header = await page.locator('.home-header-row').boundingBox()
  expect(header?.width).toBeLessThanOrEqual(720)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('command search keeps gene selection on the working workspace route', async ({ page }) => {
  await page.goto('/explore')
  await expect(page.getByRole('heading', { name: 'Gene workspace', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Search genes, proteins, or IDs...').fill('dnaA')
  await page.getByRole('button', { name: /dnaA.*enter/ }).click()
  await expect(page).toHaveURL(/\/explore\?gene=dnaA$/)
  await expect(page.getByRole('heading', { name: 'Gene workspace', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('Search genes, proteins, or IDs...')).toHaveCount(0)
})
