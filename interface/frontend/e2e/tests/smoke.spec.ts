import { test, expect } from '@playwright/test'
import { mockAssistantApi, CREATE_EXPERIMENT_PROPOSAL } from '../mocks/assistantApi'

/**
 * Phase 0 regression baseline for the Assistant UI (current page layout).
 * Runs against the Vite dev server with a fully mocked API — deterministic, no backend/LLM.
 */

test.describe('Assistant smoke', () => {
  test('sends a message and renders the streamed reply', async ({ page }) => {
    await mockAssistantApi(page, { reply: 'The platform supports 4,749 genes.' })
    await page.goto('/assistant')

    const input = page.getByTestId('assistant-input')
    await expect(input).toBeVisible()
    await input.fill('How many genes are supported?')
    await page.getByTestId('assistant-send').click()

    // Optimistic user message appears, then the streamed assistant reply.
    await expect(page.getByTestId('message-user')).toContainText('How many genes are supported?')
    await expect(page.getByTestId('message-assistant')).toContainText('The platform supports 4,749 genes.')
  })

  test('proposes an action, then preview → confirm clears the card', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: "I've prepared a dnaA knockout draft for your review.",
      proposals: [CREATE_EXPERIMENT_PROPOSAL],
    })
    await page.goto('/assistant')

    await page.getByTestId('assistant-input').fill('Draft a dnaA knockout under basal.')
    await page.getByTestId('assistant-send').click()

    // A confirmation-gated create_experiment card appears (nothing executed yet).
    const card = page.locator('[data-testid="proposal-card"][data-tool="create_experiment"]')
    await expect(card).toBeVisible()

    // Preview → Confirm.
    await card.getByTestId('proposal-preview').click()
    await expect(card.getByTestId('proposal-confirm')).toBeEnabled()
    await card.getByTestId('proposal-confirm').click()

    // After execution the card is removed from the awaiting-review rail.
    await expect(card).toHaveCount(0)
  })
})
