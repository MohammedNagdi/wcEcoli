// Capture only: opens existing data and a draft designer without saving or queuing work.
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const baseURL = process.env.PREVIEW_BASE_URL || 'http://localhost:5173'
const directory = process.env.PREVIEW_OUTPUT_DIR || '/private/tmp/wcecoli-previews'
await mkdir(directory, { recursive: true })
const browser = await chromium.launch()
const dimensions = {}
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    })
    await context.addInitScript((value) => localStorage.setItem('wcecoli.theme', value), theme)
    const page = await context.newPage()
    for (const [name, route] of [
      ['workspace', '/explore?gene=dnaA'],
      ['experiment', '/experiments/new?variant=gene_knockout&gene=dnaA'],
      ['results', '/results'],
    ]) {
      await page.goto(baseURL + route)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready)
      // Keep the relevant product content readable: omit repeated global navigation
      // and the floating launcher, and end on a complete card rather than cutting one off.
      const main = page.getByRole('main')
      const bounds = await main.boundingBox()
      if (!bounds) throw new Error(`Missing main content for ${name}`)
      let bottom = bounds.y + bounds.height
      if (name === 'experiment') {
        const parameters = await main.locator('section').filter({
          has: page.getByRole('heading', { name: /^Simulation parameters/ }),
        }).boundingBox()
        const summary = await main.getByRole('heading', { name: 'Run summary', exact: true })
          .locator('..').boundingBox()
        if (!parameters || !summary) throw new Error('Experiment preview is not ready')
        bottom = Math.max(parameters.y + parameters.height, summary.y + summary.height) + 16
      } else if (name === 'results') {
        const cards = main.locator('.space-y-4 > div').filter({ has: page.getByRole('heading', { level: 3 }) })
        const count = await cards.count()
        if (!count) throw new Error('Capture results requires existing completed example records')
        const last = await cards.nth(Math.min(count, 3) - 1).boundingBox()
        if (!last) throw new Error('Result preview is not ready')
        bottom = last.y + last.height + 16
      }
      const clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.ceil(bottom - bounds.y) }
      if (clip.height > bounds.height) throw new Error(`${name} preview does not fit the capture viewport`)
      const key = `${name}${theme === 'dark' ? '-dark' : ''}`
      await page.screenshot({
        path: `${directory}/${key}.png`, clip,
        style: '[data-testid="assistant-dock-toggle"] { visibility: hidden !important; }',
      })
      dimensions[key] = { width: clip.width, height: clip.height }
    }
    await context.close()
  }
} finally {
  await browser.close()
}
await writeFile(`${directory}/dimensions.json`, JSON.stringify(dimensions, null, 2) + '\n')
console.log(`Captured light and dark previews in ${directory}`)
