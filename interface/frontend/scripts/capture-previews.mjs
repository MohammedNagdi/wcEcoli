// Capture only: opens existing data and a draft designer without saving or queuing work.
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const baseURL = process.env.PREVIEW_BASE_URL || 'http://localhost:5173'
const directory = process.env.PREVIEW_OUTPUT_DIR || '/private/tmp/wcecoli-previews'
await mkdir(directory, { recursive: true })
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
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
      await page.screenshot({ path: `${directory}/${name}${theme === 'dark' ? '-dark' : ''}.png` })
    }
    await context.close()
  }
} finally {
  await browser.close()
}
console.log(`Captured light and dark previews in ${directory}`)
