import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

test.describe('Assistant accessibility', () => {
  test('docked assistant dialog has no serious axe violations', async ({ page }) => {
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await mockAssistantApi(page, {})
    await page.goto('/guide')

    await page.getByTestId('assistant-dock-toggle').click()
    await expect(page.getByTestId('assistant-input')).toBeVisible()

    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    if (serious.length) {
      console.log('A11Y violations:', JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2))
    }
    expect(serious).toEqual([])
  })
})
