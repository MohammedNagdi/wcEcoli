import { test, expect } from '@playwright/test'
import { CREATE_EXPERIMENT_PROPOSAL, mockAssistantApi } from '../mocks/assistantApi'

async function mockPlatformApi(page: import('@playwright/test').Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
  await mockAssistantApi(page, {})
}

test.describe('Theme', () => {
  test('toggles dark theme and persists after reload', async ({ page }) => {
    await mockPlatformApi(page)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/guide')

    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.getByTestId('theme-dark')).toBeVisible()
    await page.getByTestId('theme-dark').click({ force: true })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
    expect(await page.evaluate(() => window.localStorage.getItem('wcecoli.theme'))).toBe('dark')
  })

  test('system mode follows the OS color scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await mockPlatformApi(page)
    await page.goto('/guide')

    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByTestId('theme-light')).toBeVisible()
    await page.getByTestId('theme-light').click({ force: true })
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await page.getByTestId('theme-system').click({ force: true })
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })

  test('assistant composer uses a dark surface in dark mode', async ({ page }) => {
    await mockPlatformApi(page)
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/assistant')
    await expect(page.locator('html')).toHaveClass(/dark/)

    const composerBackground = await page.getByTestId('assistant-input').evaluate((input) => {
      const frame = input.parentElement
      return frame ? getComputedStyle(frame).backgroundColor : ''
    })
    expect(composerBackground).not.toBe('rgb(255, 255, 255)')
  })

  test('assistant composer returns to light colors after switching from dark', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
    await mockAssistantApi(page, {
      reply: 'Light mode should restore the chat surface.',
      proposals: [CREATE_EXPERIMENT_PROPOSAL],
    })
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/assistant')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.getByTestId('assistant-input').fill('check theme switch')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('message-assistant')).toContainText('Light mode should restore')
    await expect(page.getByTestId('chat-proposals')).toBeVisible()

    await page.getByTestId('theme-light').click({ force: true })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true')

    const colors = await page.getByTestId('assistant-input').evaluate((input) => {
      const frame = input.parentElement as HTMLElement | null
      const footer = frame?.parentElement as HTMLElement | null
      return {
        input: getComputedStyle(input).color,
        frame: frame ? getComputedStyle(frame).backgroundColor : '',
        footer: footer ? getComputedStyle(footer).backgroundColor : '',
      }
    })
    const chatBackground = await page.getByTestId('assistant-scroll-region').evaluate((region) => getComputedStyle(region).backgroundImage)
    const assistantBackground = await page.getByTestId('message-assistant').evaluate((message) => getComputedStyle(message).backgroundColor)
    const proposalBackgrounds = await page.getByTestId('chat-proposals').evaluate((panel) => {
      const card = panel.querySelector<HTMLElement>('[data-testid="proposal-card"]')
      return {
        panel: getComputedStyle(panel).backgroundColor,
        card: card ? getComputedStyle(card).backgroundColor : '',
      }
    })
    expect(colors.frame).toBe('rgb(255, 255, 255)')
    expect(colors.footer).toBe('rgb(255, 255, 255)')
    expect(colors.input).toBe('rgb(31, 41, 55)')
    expect(chatBackground).toContain('rgb(249, 250, 251)')
    expect(assistantBackground).toBe('rgb(255, 255, 255)')
    expect(proposalBackgrounds.panel).toBe('rgba(239, 246, 255, 0.5)')
    expect(proposalBackgrounds.card).toBe('rgb(249, 250, 251)')
  })

  test('assistant proposal review panel uses a dark surface in dark mode', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
    await mockAssistantApi(page, {
      reply: "I've prepared a draft for your review.",
      proposals: [CREATE_EXPERIMENT_PROPOSAL],
    })
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/assistant')

    await page.getByTestId('assistant-input').fill('Draft a dnaA knockout under basal.')
    await page.getByTestId('assistant-send').click()
    const reviewPanel = page.getByTestId('chat-proposals')
    const proposalCard = page.locator('[data-testid="proposal-card"]').first()
    await expect(reviewPanel).toBeVisible()
    await expect(proposalCard).toBeVisible()

    const backgrounds = await reviewPanel.evaluate((panel) => {
      const card = panel.querySelector<HTMLElement>('[data-testid="proposal-card"]')
      return {
        panel: getComputedStyle(panel).backgroundColor,
        card: card ? getComputedStyle(card).backgroundColor : '',
      }
    })
    const luminance = (rgb: string) => {
      const [r, g, b] = rgb.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(luminance(backgrounds.panel)).toBeLessThan(60)
    expect(luminance(backgrounds.card)).toBeLessThan(40)
  })

  test('assistant thought process panel is readable in dark mode', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
    await mockAssistantApi(page, {
      thinking: 'I need to inspect the available simulation data before recommending a model setup.',
      reply: 'Here is the setup review.',
    })
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('assess ml setup')
    await page.getByTestId('assistant-send').click()

    const thought = page.getByText(/Thought process/)
    await expect(thought).toBeVisible()
    await thought.click()
    const panel = thought.locator('..')
    const colors = await panel.evaluate((element) => {
      const body = element.querySelector('p')
      return {
        panel: getComputedStyle(element).backgroundColor,
        text: body ? getComputedStyle(body).color : '',
      }
    })
    const channelValues = (rgb: string) => rgb.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255]
    const luminance = (rgb: string) => {
      const [r, g, b] = channelValues(rgb)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(luminance(colors.panel)).toBeLessThan(45)
    expect(luminance(colors.text)).toBeGreaterThan(120)
  })

  test('grounded platform data tables avoid bright row bands in dark mode', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
    await mockAssistantApi(page, {
      reply: 'Here are the experiments.',
      toolResults: [{
        tool_name: 'list_experiments',
        result: {
          experiments: [
            { id: 9, name: 'aaeB knockout follow-up', variant_type: 'gene_knockout', gene_symbol: 'aaeB', condition: 'basal', status: 'draft' },
            { id: 8, name: 'timelines experiment', variant_type: 'timelines', gene_symbol: '', condition: 'succinate', status: 'draft' },
          ],
        },
      }],
    })
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('list experiments')
    await page.getByTestId('assistant-send').click()

    const grounded = page.getByTestId('grounded-results')
    await expect(grounded).toBeVisible()
    const rowBackgrounds = await grounded.locator('tbody tr').evaluateAll((rows) => (
      rows.map((row) => getComputedStyle(row).backgroundColor)
    ))
    expect(rowBackgrounds.every((color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent')).toBe(true)
  })

  test('disabled ML train button is muted in dark mode', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ json: [] }))
    await page.route('**/api/ml/data-summary', (route) => route.fulfill({
      json: {
        total_experiments: 0,
        total_completed_jobs: 0,
        total_genes: 0,
        mechanistic_genes: 0,
        divided_count: 0,
        not_divided_count: 0,
        conditions: [],
        variant_types: [],
      },
    }))
    await page.route('**/api/features*', (route) => route.fulfill({
      json: {
        total_rows: 0,
        total_experiments: 0,
        total_genes: 0,
        columns: [],
        rows: [],
      },
    }))
    await mockAssistantApi(page, {})
    await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
    await page.goto('/ml')
    await expect(page.locator('html')).toHaveClass(/dark/)

    const trainButton = page.getByTestId('ml-train-button')
    await expect(trainButton).toBeVisible()
    const background = await trainButton.evaluate((button) => getComputedStyle(button).backgroundColor)
    const [r, g, b] = background.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255]
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    expect(luminance).toBeLessThan(80)
  })

  for (const route of ['/', '/assistant', '/network', '/genome', '/results', '/environment-builder']) {
    test(`renders ${route} without pure-white panels in dark mode`, async ({ page }) => {
      await mockPlatformApi(page)
      await page.addInitScript(() => window.localStorage.setItem('wcecoli.theme', 'dark'))
      await page.goto(route)
      await expect(page.locator('html')).toHaveClass(/dark/)

      await expect.poll(() => page.evaluate(() => {
        const visible = Array.from(document.querySelectorAll<HTMLElement>('[class*="bg-white"]'))
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 20 && rect.height > 20
          })
          .filter((element) => Array.from(element.classList).some((className) => (
            className === 'bg-white' || className.startsWith('bg-white/')
          )))
        return visible.filter((element) => getComputedStyle(element).backgroundColor === 'rgb(255, 255, 255)').length
      })).toBe(0)
    })
  }
})
