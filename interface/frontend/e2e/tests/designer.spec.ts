import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

const genes = ['dnaA', 'crp', 'passenger'].map((symbol, i) => ({ id: i + 1, symbol, name: symbol, ecoli_id: `EG${i}`, ko_index: i === 2 ? -1 : 42 + i, is_mechanistic: true, category: 'replication', description: 'Test gene', tu_ids: [], rna_ids: [], protein_ids: [], pathway_ids: [], regulation: { incoming: [], outgoing: [] } }))
const variants = ['wildtype', 'gene_knockout', 'multi_gene_knockout', 'timelines', 'tf_activity', 'param_sensitivity']
const recipes = ['minimal', 'minimal_plus_amino_acids', 'minimal_acetate', 'minimal_no_glucose', 'minimal_minus_oxygen'].map((media_id, id) => ({ id, media_id, base_media: media_id, added_media: '', ingredients: '[]' }))
async function setup(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, r => r.fulfill({ json: [] }))
  await mockAssistantApi(page)
  await page.route('**/api/variants', r => r.fulfill({ json: variants.map(name => ({ name, description: name })) }))
  await page.route('**/api/experiments/variants/*', r => {
    const name = r.request().url().split('/').pop()
    return r.fulfill({ json: { name, docstring: 'Scientific model notes remain available.', parameter_hints: { timeline_behavior: name === 'tf_activity' ? 'internal_override' : 'composer', hide_index: ['wildtype', 'timelines', 'multi_gene_knockout'].includes(name || ''), tf_names: ['CRP'], timeline_notice: 'The selected variant manages the environment.', index_range: [0, 10] } } })
  })
  await page.route('**/api/conditions', r => r.fulfill({ json: [{ id: 1, name: 'basal', nutrients: 'minimal', media_id: 'minimal' }] }))
  await page.route('**/api/media-recipes', r => r.fulfill({ json: recipes }))
  await page.route('**/api/timelines', r => r.fulfill({ json: [{ name: 'shift', definition: '0 minimal, 1800 minimal_acetate' }] }))
  await page.route(/\/api\/genes\/search\?/, r => r.fulfill({ json: genes }))
  await page.route(/\/api\/genes\/[^/?]+$/, r => r.fulfill({ json: genes.find(g => g.symbol === r.request().url().split('/').pop()) || genes[0] }))
}

test('single gene suggestions support keyboard, Escape, focus, and unchanged save payload', async ({ page }) => {
  await setup(page)
  let body: any
  await page.route('**/api/experiments', r => { body = r.request().method() === 'POST' ? r.request().postDataJSON() : body; return r.fulfill({ json: r.request().method() === 'POST' ? { ...body, id: 999 } : [] }) })
  await page.goto('/experiments/new')
  await page.getByLabel('Experiment type', { exact: true }).selectOption('gene_knockout')
  const input = page.getByRole('combobox', { name: 'Search gene to knock out' })
  await input.fill('dna')
  await expect(page.getByRole('listbox')).toBeVisible()
  await input.press('ArrowDown'); await expect(input).toHaveAttribute('aria-activedescendant', 'designer-gene-0')
  await input.press('Escape'); await expect(page.getByRole('listbox')).toHaveCount(0); await expect(input).toBeFocused()
  await input.press('ArrowDown'); await input.press('Enter')
  await expect(input).toHaveValue('dnaA'); await expect(input).toBeFocused()
  await page.getByLabel('Seeds (replicates)', { exact: true }).fill('2')
  await page.getByLabel('Generations', { exact: true }).fill('3')
  await page.getByLabel('Max cell time (s)', { exact: true }).fill('7200')
  await page.getByRole('button', { name: 'Save experiment', exact: true }).click()
  await expect.poll(() => body).toBeTruthy()
  expect(body).toMatchObject({ name: 'dnaA knockout', variant_type: 'gene_knockout', variant_index: 42, gene_symbol: 'dnaA', condition: 'basal', timeline: '0 minimal' })
  expect(JSON.parse(body.sim_params)).toEqual({ seeds: 2, generations: 3, length_sec: 7200 })
})

test('multi gene keyboard skips unavailable targets and retains selection logic', async ({ page }) => {
  await setup(page); await page.goto('/experiments/new?variant=multi_gene_knockout')
  const input = page.getByRole('combobox', { name: 'Search genes to add' })
  await input.fill('gene'); await expect(page.getByRole('option', { name: /passenger/ })).toBeDisabled()
  await input.press('ArrowUp'); await expect(input).toHaveAttribute('aria-activedescendant', 'designer-gene-1'); await input.press('Enter')
  await input.fill('gene'); await expect(page.getByRole('listbox')).toBeVisible(); await input.press('ArrowDown'); await input.press('Enter')
  await expect(page.getByText('Selected genes (2)', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save experiment', exact: true })).toBeEnabled()
})

test('presets, numeric event editing and failed saves retain content and values', async ({ page }) => {
  await setup(page); await page.route('**/api/experiments', r => r.fulfill({ status: 503, json: { detail: 'Save unavailable' } }))
  await page.goto('/experiments/new?gene=dnaA&condition=basal')
  const toggle = page.getByRole('button', { name: 'Load preset timeline' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await toggle.click()
  await page.getByLabel('Media protocol preset').selectOption('shift'); await page.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(page.locator('.designer-event-row')).toHaveCount(2)
  const time = page.getByLabel('Shift time (min) for minimal_acetate, event 2')
  await time.fill('40'); await expect(page.locator('.designer-summary')).toContainText('2400 minimal_acetate')
  await page.getByRole('button', { name: 'Save experiment', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Save unavailable')
  await expect(time).toHaveValue('40'); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('dnaA knockout')
  await page.getByRole('button', { name: 'Browse all vials' }).click(); await expect(page.getByRole('button', { name: 'Browse all vials' })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'Browse all vials' }).click(); await expect(page.getByRole('button', { name: 'Browse all vials' })).toHaveAttribute('aria-expanded', 'false')
})

for (const variant of variants) {
  test(`section order and existing flow: ${variant}`, async ({ page }) => {
    await setup(page); await page.goto(`/experiments/new?variant=${variant}`)
    await expect(page.getByLabel('Experiment type', { exact: true })).toHaveValue(variant)
    await expect.poll(() => page.locator('.designer-layout > div > section > h2, .designer-layout > div > section > div > h2').allTextContents().then(values => values.map(value => value.replace(/\?/g, '').trim()))).toEqual([
      'Experiment type', ...(variant === 'gene_knockout' ? ['Target gene'] : variant === 'multi_gene_knockout' ? ['Target genes'] : variant === 'wildtype' || variant === 'timelines' ? [] : [variant === 'tf_activity' ? 'TF state' : 'Variant parameter']), 'Simulation parameters', 'Media protocol', 'Experiment details',
    ])
    await expect(page.getByRole('heading', { name: 'Run summary' })).toBeVisible()
    if (variant === 'tf_activity') await expect(page.getByText('Why media is locked', { exact: true })).toBeVisible()
  })
}

for (const width of [390, 768, 1440]) for (const theme of ['light', 'dark', 'system']) {
  test(`designer layout ${width} ${theme} including reduced motion and effective 200% zoom`, async ({ page }) => {
    await setup(page); await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: theme === 'light' ? 'light' : 'dark', reducedMotion: 'reduce' })
    await page.addInitScript(t => localStorage.setItem('wcecoli.theme', t), theme)
    await page.goto('/experiments/new?gene=dnaA&condition=basal'); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('dnaA knockout')
    await page.getByRole('button', { name: 'Load preset timeline' }).click();
    await expect(page.locator('.designer-reveal').first()).toHaveCSS('animation-name', 'none');
    await page.getByLabel('Media protocol preset').selectOption('shift'); await page.getByRole('button', { name: 'Load', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const failures = (await new AxeBuilder({ page }).include('.experiment-designer').analyze()).violations
    expect(failures).toEqual([])
    await page.getByRole('button', { name: 'Save experiment', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Save experiment', exact: true })).toBeInViewport()
    await page.locator('main').evaluate(e => { e.scrollTop = 0 });
    await page.screenshot({ path: `../../output/experiment-designer-qa/${test.info().project.name}-${width}-${theme}.png`, fullPage: true })
    await page.setViewportSize({ width: Math.round(width / 2), height: 500 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await expect(page.getByLabel('Shift time (min) for minimal_acetate, event 2')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page).toHaveURL(/\/experiments(?:\?|$)/)
  })
}

test('timeline pointer editing preserves serialization and media colors match their markers', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/experiments/new?gene=dnaA')
  await page.getByRole('button', { name: 'Load preset timeline' }).click(); await page.getByLabel('Media protocol preset').selectOption('shift'); await page.getByRole('button', { name: 'Load', exact: true }).click()
  const marker = page.getByRole('button', { name: 'Shift at 30m, Minimal Acetate', exact: true })
  await marker.scrollIntoViewIfNeeded()
  const bar = await page.locator('.cursor-crosshair').boundingBox(), point = await marker.boundingBox()
  expect(bar).not.toBeNull(); expect(point).not.toBeNull()
  await page.mouse.move(point!.x + point!.width / 2, point!.y + point!.height / 2); await page.mouse.down(); await page.mouse.move(bar!.x + bar!.width / 3, point!.y + point!.height / 2, { steps: 8 }); await page.mouse.up()
  await expect(page.getByLabel('Shift time (min) for minimal_acetate, event 2')).toHaveValue('60')
  await expect(page.locator('.designer-summary')).toContainText('3600 minimal_acetate')
  const dot = await page.getByRole('button', { name: 'Shift at 1h, Minimal Acetate', exact: true }).locator('span').first().evaluate(e => getComputedStyle(e).backgroundColor)
  expect(dot).toEqual(await page.getByRole('button', { name: 'Minimal Acetate', exact: true }).locator('span').first().evaluate(e => getComputedStyle(e).backgroundColor))
})

test('dock occupies workspace space without losing designer values or context', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/experiments/new?gene=dnaA&condition=basal')
  await expect(page.locator('.designer-layout')).toHaveCSS('grid-template-columns', /\d+.*340px/)
  await page.getByLabel('Name', { exact: true }).fill('Reviewed draft')
  await page.getByTestId('assistant-dock-toggle').click()
  await expect(page.getByTestId('assistant-dock')).toHaveAttribute('role', 'complementary')
  await expect(page.locator('.designer-layout')).not.toHaveCSS('grid-template-columns', /\d+.*340px/)
  await page.getByLabel('Seeds (replicates)', { exact: true }).fill('4')
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Reviewed draft'); await expect(page.getByLabel('Seeds (replicates)', { exact: true })).toHaveValue('4')
  await page.setViewportSize({ width: 1440, height: 500 })
  await expect(page.locator('.designer-summary')).toHaveCSS('position', 'static')
  await page.getByRole('button', { name: 'Save experiment', exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByRole('button', { name: 'Save experiment', exact: true })).toBeInViewport()
})

for (const theme of ['light', 'dark']) test(`meaningful palette and control contrast in ${theme}`, async ({ page }) => {
  await setup(page); await page.addInitScript(t => localStorage.setItem('wcecoli.theme', t), theme); await page.goto('/experiments/new?gene=dnaA')
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('dnaA knockout')
  const values = await page.locator('.experiment-designer').evaluate(el => {
    const root = getComputedStyle(el)
    const color = (value: string) => { const probe = document.createElement('span'); probe.style.color = value; el.append(probe); const result = getComputedStyle(probe).color; probe.remove(); return result }
    return { bg: color(`rgb(${root.getPropertyValue('--color-surface')})`), colors: ['slate', 'rose', 'ochre', 'teal', 'blue', 'violet', 'control-border'].map(name => color(root.getPropertyValue(`--designer-${name}`))), chips: [...el.querySelectorAll('.designer-status')].map(e => getComputedStyle(e).color), controls: [...el.querySelectorAll('input:not([type=checkbox]):not(:disabled), select:not(:disabled), textarea')].map(e => ({ border: getComputedStyle(e).borderColor, bg: getComputedStyle(e).backgroundColor })) }
  })
  const luminance = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
  for (const value of values.colors) expect(contrast(value, values.bg)).toBeGreaterThanOrEqual(3)
  for (const value of values.controls) expect(contrast(value.border, value.bg)).toBeGreaterThanOrEqual(3)
  for (const value of values.chips) expect(contrast(value, values.bg)).toBeGreaterThanOrEqual(4.5)
})

test('long identifiers, dense protocols and suggestions remain inspectable at narrow widths', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 390, height: 900 })
  const longId = 'minimal_' + 'scientific_medium_identifier_'.repeat(6)
  await page.route('**/api/media-recipes', r => r.fulfill({ json: [...recipes, { ...recipes[0], media_id: longId }] }))
  await page.route('**/api/timelines', r => r.fulfill({ json: [{ name: 'dense', definition: `0 minimal, 1800 ${longId}, 3600 minimal_acetate, 5400 minimal_plus_amino_acids, 7200 minimal_minus_oxygen` }] }))
  const longGene = { ...genes[0], symbol: 'scientific_gene_identifier_'.repeat(5), ecoli_id: 'ECOLI_IDENTIFIER_'.repeat(6) }
  await page.route(/\/api\/genes\/search\?/, r => r.fulfill({ json: [longGene] }))
  await page.goto('/experiments/new?variant=gene_knockout')
  const input = page.getByRole('combobox', { name: 'Search gene to knock out' })
  await input.fill('scientific'); await expect(page.getByRole('listbox')).toBeVisible()
  const option = page.getByRole('listbox').getByRole('option')
  expect(await option.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  await input.press('ArrowDown'); await input.press('Enter')
  await page.getByRole('button', { name: 'Load preset timeline' }).click(); await page.getByLabel('Media protocol preset').selectOption('dense'); await page.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(page.locator('.designer-event-row')).toHaveCount(5)
  await expect(page.locator('.designer-event-row').nth(1).locator('code')).toHaveText(longId)
  // WebKit counts native option-popup widths in ancestor scrollWidth. Check the
  // rendered controls and complete identifier instead of that popup measurement.
  expect(await page.locator('.designer-event-row').evaluateAll(rows => rows.flatMap(row => {
    const bounds = row.getBoundingClientRect()
    return [...row.children].filter(child => {
      const box = child.getBoundingClientRect()
      return box.left < bounds.left - 1 || box.right > bounds.right + 1 || (child.tagName === 'CODE' && child.scrollWidth > child.clientWidth + 1)
    }).map(child => child.tagName)
  }))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.getByRole('button', { name: 'Save experiment', exact: true }).scrollIntoViewIfNeeded()
  const save = await page.getByRole('button', { name: 'Save experiment', exact: true }).boundingBox()
  expect(save!.x).toBeGreaterThanOrEqual(0); expect(save!.x + save!.width).toBeLessThanOrEqual(390)
})

for (const width of [390, 768, 1440]) test(`native wheel scrolling reaches details and save at ${width}px`, async ({ page }) => {
  await setup(page); await page.setViewportSize({ width, height: 900 }); await page.goto('/experiments/new?gene=dnaA')
  const main = page.locator('main')
  await expect(main).toHaveCSS('overflow-y', 'auto')
  const bounds = (await main.boundingBox())!
  await page.mouse.move(bounds.x + Math.min(120, bounds.width / 2), bounds.y + 200)
  await page.mouse.wheel(0, 700)
  await expect.poll(() => main.evaluate(e => e.scrollTop)).toBeGreaterThan(100)
  await page.mouse.wheel(0, 10000)
  await expect(page.getByRole('button', { name: 'Save experiment', exact: true })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => main.evaluate(e => e.scrollTop)).toBe(0)
  await expect(page.getByRole('heading', { name: 'Design experiment' })).toBeInViewport()
})
