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

  test('renders markdown (bold/headers/lists), not raw characters', async ({ page }) => {
    await mockAssistantApi(page, { reply: '### Genes\n\n- **dnaA** is replication initiator\n- crp is a regulator' })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('Tell me about dnaA')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg).toBeVisible()
    // Bold is a real <strong>, list is a real <li>; the raw markdown chars are gone.
    await expect(msg.locator('strong', { hasText: 'dnaA' })).toBeVisible()
    await expect(msg.locator('li')).toHaveCount(2)
    await expect(msg).not.toContainText('**dnaA**')
    await expect(msg).not.toContainText('### Genes')
  })

  test('does not mangle snake_case identifiers as italics', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Call create_experiment with variant_index and include_wildtype set correctly.',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('how do I make a knockout')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg).toBeVisible()
    // Underscores must survive (GFM treats intraword `_` as literal), so the identifiers read intact
    // and nothing between them gets italicized away.
    await expect(msg).toContainText('create_experiment')
    await expect(msg).toContainText('variant_index')
    await expect(msg).toContainText('include_wildtype')
    await expect(msg.locator('em')).toHaveCount(0)
  })

  test('renders a GFM table', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Comparison:\n\n| Gene | KO index |\n|------|----------|\n| dnaA | 42 |\n| crp | 84 |',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('compare')
    await page.getByTestId('assistant-send').click()

    const msg = page.getByTestId('message-assistant')
    await expect(msg.locator('table')).toBeVisible()
    await expect(msg.locator('th')).toHaveCount(2)
    await expect(msg.locator('tbody tr')).toHaveCount(2)
    await expect(msg).not.toContainText('|------|') // separator row is not shown literally
  })

  test('surfaces a provider error clearly', async ({ page }) => {
    await mockAssistantApi(page, {
      reply: 'Ollama call failed. Check the endpoint is reachable. No side effects were executed.',
      assistantStatus: 'provider_call_failed',
    })
    await page.goto('/assistant')
    await page.getByTestId('assistant-input').fill('hi')
    await page.getByTestId('assistant-send').click()

    await expect(page.getByTestId('message-assistant')).toContainText('Ollama call failed')
    await expect(page.getByText('provider error')).toBeVisible() // friendly status badge
  })

  test('docked panel: summon from another page, chat, Esc to close', async ({ page }) => {
    // Quiet other pages' own data calls. Anchor to the API origin so we don't intercept the app's
    // own /src/api/* module scripts.
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) => r.fulfill({ json: [] }))
    await mockAssistantApi(page, { reply: 'There are 4,749 genes.' })
    await page.goto('/guide') // a non-assistant page

    // Summon the dock (it's not the /assistant route).
    await page.getByTestId('assistant-dock-toggle').click()
    const input = page.getByTestId('assistant-input')
    await expect(input).toBeVisible()
    await input.fill('How many genes?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('message-assistant')).toContainText('There are 4,749 genes.')

    // Esc closes the dock and restores the floating toggle.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('assistant-input')).toHaveCount(0)
    await expect(page.getByTestId('assistant-dock-toggle')).toBeVisible()
  })
})
