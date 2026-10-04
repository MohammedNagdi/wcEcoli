import { test, expect, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi, CREATE_EXPERIMENT_PROPOSAL } from '../mocks/assistantApi'

const conversation = (id = 1) => ({ id, title: `Chat ${id}`, assistant_surface: 'central', status: 'open', provider_id: 'openai', model: 'gpt-4.1-mini', created_at: '', updated_at: '' })
const user = { id: 1, conversation_id: 1, role: 'user', content: 'Question', context: {}, status: 'stored', provider_id: '', model: '', created_at: '' }
const answer = { ...user, id: 2, role: 'assistant', content: 'Completed answer', status: 'completed' }
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
async function send(page: Page, text = 'Question') { await page.getByTestId('assistant-input').fill(text); await expect(page.getByTestId('assistant-send')).toBeEnabled(); await page.getByTestId('assistant-send').click() }
async function openHistory(page: Page) { const trigger = page.getByRole('button', { name: 'History', exact: true }); if (await trigger.count()) { try { await trigger.click({ timeout: 2000 }) } catch (error) { if (!await page.locator('.assistant-history-rail').isVisible()) throw error } } }
async function controlledStream(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const host = window as unknown as { stream: ReadableStreamDefaultController<Uint8Array>; requests: number }
    host.requests = 0
    window.fetch = async (input, init) => {
      if (!String(input).endsWith('/messages/stream')) return original(input, init)
      host.requests++
      const stream = new ReadableStream<Uint8Array>({ start(controller) { host.stream = controller; init?.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('Stopped', 'AbortError')) } catch {} }) } })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
}
async function push(page: Page, events: unknown[], close = false) { await page.evaluate(({ events, close }) => { const host = window as unknown as { stream: ReadableStreamDefaultController<Uint8Array> }; for (const e of events) host.stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); if (close) host.stream.close() }, { events, close }) }

test.describe('Assistant workbench behavior', () => {
  test('starters fill a draft; Enter, Shift+Enter, Cmd/Ctrl+Enter and IME are respected', async ({ page }) => {
    await mockAssistantApi(page)
    await page.goto('/assistant')
    await page.locator('.assistant-starter').first().click()
    await expect(page.getByTestId('assistant-input')).not.toHaveValue('')
    await expect(page.getByTestId('message-user')).toHaveCount(0)
    const input = page.getByTestId('assistant-input')
    await input.fill('Line one'); await input.press('Shift+Enter'); await input.press('a')
    await expect(input).toHaveValue('Line one\na')
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(page.getByTestId('message-user')).toHaveCount(0)
    await input.press('Control+Enter'); await expect(page.getByTestId('message-assistant')).toHaveCount(1)
    await input.fill('Next'); await input.press('Enter'); await expect(page.getByTestId('message-user')).toHaveCount(2)
    await input.fill('Third'); await input.press('Meta+Enter'); await expect(page.getByTestId('message-user')).toHaveCount(3)
  })
  test('unavailable models prevent submission', async ({ page }) => {
    await mockAssistantApi(page, { providerModelOptions: [{ provider_id: 'openai', label: 'OpenAI', models: [] }] })
    await page.goto('/assistant'); await page.getByTestId('assistant-input').fill('Question')
    await expect(page.getByTestId('assistant-send')).toBeDisabled()
    await expect(page.getByText('This conversation’s model is unavailable.', { exact: false })).toBeVisible()
  })
  test('history failure is distinct from successful empty history and can retry', async ({ page }) => {
    await mockAssistantApi(page)
    let fail = true
    await page.route('**/api/assistant/conversations', r => r.fulfill(fail ? { status: 503, json: { detail: 'History temporarily unavailable' } } : { json: [] }))
    await page.goto('/assistant'); await openHistory(page)
    await expect(page.getByText(/History temporarily unavailable/)).toBeVisible()
    await expect(page.getByText('No saved conversations yet.')).toHaveCount(0)
    fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByText('No saved conversations yet.')).toBeVisible()
  })
  test('history search, failed rename draft, and confirmed deletion', async ({ page }) => {
    await mockAssistantApi(page)
    await page.route('**/api/assistant/conversations', r => r.fulfill({ json: [conversation(1), conversation(2)] }))
    let fail = true
    await page.route('**/api/assistant/conversations/1', r => r.request().method() === 'PATCH' && fail ? r.fulfill({ status: 500, json: { detail: 'Rename failed' } }) : r.fulfill({ json: { ...conversation(1), title: r.request().method() === 'PATCH' ? r.request().postDataJSON().title : 'Chat 1' } }))
    await page.goto('/assistant'); await openHistory(page)
    await page.getByRole('searchbox').fill('Chat 1'); await expect(page.locator('.assistant-history-select')).toHaveCount(1)
    await page.getByLabel('Actions for Chat 1').click(); await page.getByRole('button', { name: 'Rename Chat 1' }).click()
    await page.getByLabel('Conversation name').fill('Edited title'); await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByLabel('Conversation name')).toHaveValue('Edited title')
    fail = false; await page.getByRole('button', { name: 'Save name' }).click(); await page.getByRole('searchbox').fill('')
    await page.getByLabel('Actions for Edited title').click(); await page.getByRole('button', { name: 'Delete Edited title' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible(); await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByLabel('Actions for Edited title')).toBeVisible()
    await page.getByLabel('Actions for Edited title').click(); await page.getByRole('button', { name: 'Delete Edited title' }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await expect(page.getByLabel('Actions for Edited title')).toHaveCount(0)
  })
  test('stale message loads cannot replace the selected chat; drafts return', async ({ page }) => {
    await mockAssistantApi(page)
    await page.route('**/api/assistant/conversations', r => r.fulfill({ json: [conversation(1), conversation(2)] }))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/assistant/conversations/1/messages', async r => { await gate; await r.fulfill({ json: [{ ...answer, content: 'Old chat answer' }] }) })
    await page.route('**/api/assistant/conversations/2/messages', r => r.fulfill({ json: [{ ...answer, conversation_id: 2, content: 'Selected chat answer' }] }))
    await page.goto('/assistant'); await openHistory(page)
    await page.locator('.assistant-history-select').filter({ hasText: 'Chat 2' }).click()
    await expect(page.getByTestId('message-assistant')).toContainText('Selected chat answer')
    release(); await expect(page.getByTestId('message-assistant')).not.toContainText('Old chat answer')
    await page.getByTestId('assistant-input').fill('Chat 2 draft')
    await openHistory(page); await page.locator('.assistant-history-select').filter({ hasText: 'Chat 1' }).click()
    await expect(page.getByTestId('message-assistant')).toContainText('Old chat answer')
    await openHistory(page); await page.locator('.assistant-history-select').filter({ hasText: 'Chat 2' }).click()
    await expect(page.getByTestId('assistant-input')).toHaveValue('Chat 2 draft')
  })
  test('settings retain failed saves, show field errors, protect unsaved edits, and preserve query context', async ({ page }) => {
    await mockAssistantApi(page)
    await page.route('**/api/assistant/runtime-settings', async r => { if (r.request().method() === 'PUT') return r.fulfill({ status: 500, json: { detail: 'Settings failed' } }); await r.fallback() })
    await page.goto('/assistant?gene=dnaA&assistantView=settings')
    const turns = page.getByLabel('Max agent turns', { exact: false }); await turns.fill('0')
    await expect(page.getByText('Enter a whole number from 1 to 12.')).toBeVisible(); await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()
    await turns.fill('8'); await page.getByRole('button', { name: 'Save settings' }).click(); await expect(page.getByText(/Settings failed/)).toBeVisible(); await expect(turns).toHaveValue('8')
    await page.getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByRole('alertdialog')).toBeVisible(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(turns).toHaveValue('8')
    await page.getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByRole('button', { name: 'Discard changes' }).click()
    await expect(page).toHaveURL(/gene=dnaA.*assistantView=chat/); await expect(page.getByTestId('assistant-input')).toBeVisible()
  })
  test('provider save failures retain the selected model and entered key', async ({ page }) => {
    await mockAssistantApi(page)
    await page.route('**/api/assistant/provider-configs', r => r.fulfill({ json: [{ provider_id: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini', default_model: 'gpt-4.1-mini', models: [{ model_id: 'gpt-4.1-mini' }], is_active: true, configured: false }] }))
    await page.route('**/api/assistant/provider-configs/*', r => r.fulfill({ status: 500, json: { detail: 'Provider save failed' } }))
    await page.goto('/assistant?assistantView=settings')
    const secret = page.locator('input[type=password]'); await secret.fill('test-key')
    await page.getByRole('button', { name: /Save and use/i }).click()
    await expect(page.getByText(/Provider save failed/)).toBeVisible(); await expect(secret).toHaveValue('test-key')
  })
  test('activity loads only when opened and request failure is not an empty state', async ({ page }) => {
    await mockAssistantApi(page); let calls = 0
    await page.route('**/api/assistant/provenance*', r => { calls++; return r.fulfill({ status: 503, json: { detail: 'Activity unavailable' } }) })
    await page.goto('/assistant'); await expect(page.getByTestId('assistant-input')).toBeVisible(); expect(calls).toBe(0)
    await page.getByRole('button', { name: 'Activity', exact: true }).click(); await expect(page.getByText(/Activity unavailable/)).toBeVisible(); expect(calls).toBeGreaterThan(0)
    await expect(page.getByText('No provenance recorded for this scope.')).toHaveCount(0)
  })
  test('live SSE, tool commentary separation, disabled switching and duplicate prevention', async ({ page }) => {
    await mockAssistantApi(page); await controlledStream(page); await page.goto('/assistant'); await send(page)
    await expect(page.getByTestId('assistant-stop')).toBeVisible()
    await push(page, [{ type: 'user', message: user }, { type: 'delta', text: 'Checking genes' }])
    await expect(page.locator('.assistant-live-turn')).toContainText('Checking genes')
    await page.getByTestId('assistant-input').fill('Next draft'); await page.getByTestId('assistant-input').press('Enter')
    expect(await page.evaluate(() => (window as unknown as { requests: number }).requests)).toBe(1)
    await expect(page.getByLabel('New chat', { exact: true })).toBeDisabled(); await expect(page.getByTestId('model-pill')).toBeDisabled()
    await push(page, [{ type: 'status', tool: 'inspect_gene' }, { type: 'delta', text: 'Completed answer' }])
    await expect(page.locator('.assistant-live-turn .assistant-tool-chip')).toContainText('inspect gene')
    await push(page, [{ type: 'done', conversation: conversation(), user_message: user, assistant_message: answer, proposals: [], compacted: true }], true)
    await expect(page.getByTestId('message-assistant').locator('p').first()).toHaveText('Completed answer')
    await expect(page.getByTestId('thinking-block')).toContainText('Checking genes'); await expect(page.getByTestId('assistant-input')).toHaveValue('Next draft')
    await expect(page.getByTestId('assistant-compaction-notice')).toBeVisible()
  })
  for (const stopped of [true, false]) test(`${stopped ? 'Stop' : 'Premature close'} retains partial output and never falls back after an application event`, async ({ page }) => {
    await mockAssistantApi(page); await controlledStream(page); let fallback = 0
    await page.route('**/api/assistant/conversations/1/messages', r => { if (r.request().method() === 'POST') fallback++; return r.fulfill({ json: [user] }) })
    await page.goto('/assistant'); await send(page); await expect(page.getByTestId('assistant-stop')).toBeVisible()
    await push(page, [{ type: 'user', message: user }, { type: 'delta', text: 'Partial scientific answer' }], !stopped)
    if (stopped) await page.getByTestId('assistant-stop').click()
    await expect(page.locator('.assistant-interrupted')).toContainText('Partial scientific answer'); await expect(page.locator('.assistant-interrupted strong')).toHaveText(stopped ? 'Stopped' : 'Interrupted')
    await expect(page.getByTestId('assistant-send')).toBeVisible(); expect(fallback).toBe(0)
  })
  test('only a stream failure before any application event can use synchronous fallback', async ({ page }) => {
    await mockAssistantApi(page)
    await page.route('**/api/assistant/conversations/1/messages/stream', r => r.fulfill({ status: 404, body: 'No streaming endpoint' }))
    let calls = 0
    await page.route('**/api/assistant/conversations/1/messages', r => { calls++; return r.fulfill({ json: { conversation: conversation(), user_message: user, assistant_message: answer, proposals: [] } }) })
    await page.goto('/assistant'); await send(page); await expect(page.getByTestId('message-assistant').locator('p').first()).toHaveText('Completed answer'); expect(calls).toBeGreaterThan(0)
  })
  test('metadata alone forbids fallback, even when the stream closes immediately', async ({ page }) => {
    await mockAssistantApi(page); let posts = 0
    await page.route('**/api/assistant/conversations/1/messages/stream', r => r.fulfill({ contentType: 'text/event-stream', body: event({ type: 'meta', model: 'gpt-4.1-mini' }) }))
    await page.route('**/api/assistant/conversations/1/messages', r => { if (r.request().method() === 'POST') posts++; return r.fulfill({ json: [user] }) })
    await page.goto('/assistant'); await send(page); await expect(page.locator('.assistant-interrupted')).toBeVisible(); expect(posts).toBe(0)
  })
  test('all proposals are reachable; invalid previews and rejection never execute', async ({ page }) => {
    const proposals = Array.from({ length: 8 }, (_, n) => ({ ...CREATE_EXPERIMENT_PROPOSAL, id: 10 + n, result: { ...CREATE_EXPERIMENT_PROPOSAL.result, title: `Proposal ${n + 1}` } }))
    await mockAssistantApi(page, { proposals }); let executions = 0
    await page.route('**/api/assistant/tools/*/execute', r => { executions++; return r.fulfill({ json: {} }) })
    await page.route('**/api/assistant/tools/*/preview', r => r.fulfill({ json: { tool_name: 'create_experiment', valid: false, execution_enabled: true, side_effect: true, requires_confirmation: true, normalized_arguments: {}, preview: {}, errors: ['Unknown gene'], warnings: [] } }))
    await page.goto('/assistant'); await send(page); await page.getByRole('button', { name: /Show more actions/ }).click(); await page.getByRole('button', { name: /Show more actions/ }).click(); await expect(page.getByTestId('proposal-card')).toHaveCount(8)
    const first = page.getByTestId('proposal-card').first(); await first.getByTestId('proposal-preview').click(); await expect(first.getByTestId('proposal-confirm')).toBeDisabled(); await first.getByTestId('proposal-reject').click(); expect(executions).toBe(0)
  })
  test('approval binds normalized payload and captured context; duplicate execution is prevented', async ({ page }) => {
    await mockAssistantApi(page, { proposals: [CREATE_EXPERIMENT_PROPOSAL] }); await page.goto('/assistant?gene=dnaA'); await send(page)
    const card = page.getByTestId('proposal-card'); await card.getByTestId('proposal-preview').click()
    await page.getByRole('button', { name: 'Activity', exact: true }).click(); await page.getByRole('button', { name: 'Chat', exact: true }).click()
    let executed = 0; let submitted: Record<string, unknown> = {}
    await page.route('**/api/assistant/tools/*/execute', async r => { executed++; submitted = r.request().postDataJSON(); await r.fulfill({ json: { tool_name: 'create_experiment', executed: false, status: 'validation_failed', result: {}, errors: ['Gene no longer available'], warnings: [], normalized_arguments: {}, requires_confirmation: true } }) })
    await card.getByTestId('proposal-confirm').dblclick(); await expect(card).toContainText('Gene no longer available'); expect(executed).toBe(1)
    expect(submitted.arguments).toMatchObject({ sim_params: '{}', gene_symbol: 'dnaA' }); expect(submitted.context).toMatchObject({ selected_gene: 'dnaA', route: '/assistant?gene=dnaA' })
  })
  test('uncertain action outcomes stay blocked across view transitions until records prove execution', async ({ page }) => {
    await mockAssistantApi(page, { proposals: [CREATE_EXPERIMENT_PROPOSAL] })
    let executed = 0
    await page.route('**/api/assistant/tools/*/execute', r => { executed++; return r.fulfill({ status: 500, json: { detail: 'Connection lost' } }) })
    await page.goto('/assistant'); await send(page); await page.getByTestId('proposal-preview').click(); await page.getByTestId('proposal-confirm').click()
    await expect(page.getByText(/Execution outcome is uncertain/)).toBeVisible(); await expect(page.getByTestId('proposal-confirm')).toBeDisabled()
    await page.getByRole('button', { name: 'Activity', exact: true }).click(); await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(page.getByTestId('proposal-confirm')).toBeDisabled(); await page.getByRole('button', { name: 'Check execution records' }).click()
    await expect(page.getByText(/Retry remains disabled/)).toBeVisible(); expect(executed).toBe(1)
    await page.route('**/api/assistant/confirmations*', r => r.fulfill({ json: [{ id: 1, status: 'used', note: 'Used by assistant tool call 11.' }] }))
    await page.route('**/api/assistant/tool-calls*', r => r.fulfill({ json: [{ id: 11, status: 'executed', tool_name: 'create_experiment', arguments: {}, result: { experiment: { id: 5, name: 'dnaA knockout' } } }] }))
    await page.getByRole('button', { name: 'Check execution records' }).click(); await expect(page.getByTestId('proposal-card')).toHaveCount(0); await expect(page.getByText('Action outcome')).toBeVisible(); expect(executed).toBe(1)
  })
  test('desktop dock permits workspace interaction and keeps conversation, model, draft and scroll on full-page transition', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockAssistantApi(page, { reply: Array.from({ length: 80 }, (_, i) => `Evidence line ${i}`).join('\n') })
    await page.route(/^https?:\/\/[^/]+\/api\/(?!assistant|platform)/, r => r.fulfill({ json: [] })); await page.goto('/guide'); await page.getByTestId('assistant-dock-toggle').click()
    await expect(page.getByTestId('assistant-dock')).toHaveAttribute('role', 'complementary')
    expect((await page.getByTestId('assistant-dock').boundingBox())!.width).toBe(440)
    await page.locator('main').click({ position: { x: 20, y: 20 } }); await send(page)
    const scroll = page.getByTestId('assistant-scroll-region'); await scroll.evaluate(el => { el.scrollTop = 100 })
    await page.getByTestId('assistant-input').fill('Retained draft'); await page.getByRole('button', { name: 'Open full page' }).click()
    await expect(page.getByTestId('assistant-input')).toHaveValue('Retained draft'); await expect(page.getByTestId('message-assistant')).toHaveCount(1)
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(100)
    await page.getByRole('link', { name: 'Guide', exact: true }).click(); await expect(page.getByTestId('assistant-input')).toHaveValue('Retained draft')
  })
  test('modal focus containment, nested Escape, and focus restoration', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 }); await mockAssistantApi(page); await page.goto('/guide')
    const launcher = page.getByTestId('assistant-dock-toggle'); await launcher.click(); await expect(page.getByTestId('assistant-dock')).toHaveAttribute('aria-modal', 'true')
    await page.getByTestId('model-pill').click(); await page.keyboard.press('Escape'); await expect(page.getByTestId('model-popover')).toHaveCount(0); await expect(page.getByTestId('assistant-dock')).toBeVisible()
    await page.getByRole('button', { name: 'History', exact: true }).click(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Conversation history' })).toHaveCount(0); await expect(page.getByTestId('assistant-dock')).toBeVisible()
    await page.getByTestId('assistant-dock-close').focus(); await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=assistant-dock]'))).toBe(true)
    await page.keyboard.press('Escape'); await expect(launcher).toBeFocused()
  })
  test('closing the dock preserves an active response', async ({ page }) => {
    await mockAssistantApi(page); await controlledStream(page); await page.route(/^https?:\/\/[^/]+\/api\/(?!assistant|platform)/, r => r.fulfill({ json: [] })); await page.goto('/guide'); await page.getByTestId('assistant-dock-toggle').click(); await send(page)
    await push(page, [{ type: 'user', message: user }, { type: 'delta', text: 'Still responding' }]); await page.getByTestId('assistant-dock-close').click()
    await push(page, [{ type: 'done', conversation: conversation(), user_message: user, assistant_message: answer, proposals: [] }], true)
    await page.getByTestId('assistant-dock-toggle').click(); await expect(page.getByTestId('message-assistant').locator('p').first()).toHaveText('Completed answer')
  })
})

for (const width of [390, 768, 1440]) for (const theme of ['light', 'dark', 'system']) test(`responsive review ${width}px ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(theme => localStorage.setItem('wcecoli.theme', theme), theme)
  await mockAssistantApi(page, { reply: 'The result records are attached below.\n\n| Gene | Condition |\n|---|---|\n| dnaA | basal |\n\n```python\nprint("dnaA")\n```', toolResults: [{ tool_name: 'list_results', result: { results: [{ job_id: 12, experiment_name: 'dnaA knockout', condition: 'basal', gene_symbol: 'dnaA', metrics: { doubling_time_min: { mean: 45 } } }] } }] })
  await page.goto('/assistant?gene=dnaA'); await send(page); await expect(page.getByTestId('grounded-results')).toBeVisible()
  const region = page.getByTestId('assistant-scroll-region'); await region.evaluate(el => { el.scrollTop = 0 })
  const input = await page.getByTestId('assistant-input').boundingBox(); expect(input!.y + input!.height).toBeLessThan(900)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (width === 1440) await expect(page.locator('.assistant-history-rail')).toHaveCount(1); else await expect(page.locator('.assistant-history-rail')).toHaveCount(0)
  await page.screenshot({ path: `../../output/assistant-refresh/${info.project.name}-${width}-${theme}.png` })
  const results = await new AxeBuilder({ page }).include('.assistant-workbench').analyze()
  expect(results.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([])
  // Browser zoom changes CSS viewport size; emulate the resulting 200% layout viewport.
  await page.setViewportSize({ width: Math.round(width / 2), height: 450 })
  await expect(page.getByTestId('assistant-input')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('browser Back protects unsaved assistant settings', async ({ page }) => {
  await mockAssistantApi(page)
  await page.route(/^https?:\/\/[^/]+\/api\/(?!assistant|platform)/, r => r.fulfill({ json: [] }))
  await page.goto('/guide')
  await page.getByRole('link', { name: 'Assistant', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Max agent turns', { exact: false }).fill('8')
  await page.goBack()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByLabel('Max agent turns', { exact: false })).toHaveValue('8')
})

test('interrupted accepted messages block recovery while stored-message reconciliation fails', async ({ page }) => {
  await mockAssistantApi(page)
  let fail = true
  await page.route('**/api/assistant/conversations/1/messages', r => r.fulfill(fail ? { status: 503, json: { detail: 'Storage unavailable' } } : { json: [user] }))
  await page.route('**/api/assistant/conversations/1/messages/stream', r => r.fulfill({ contentType: 'text/event-stream', body: event({ type: 'user', message: user }) + event({ type: 'delta', text: 'Partial output' }) }))
  await page.goto('/assistant'); await send(page)
  await expect(page.getByText(/Stored messages could not be reloaded/)).toBeVisible()
  await page.getByTestId('assistant-input').fill('Another question')
  await expect(page.getByTestId('assistant-send')).toBeDisabled()
  fail = false; await page.getByRole('button', { name: 'Reload stored messages' }).click()
  await expect(page.getByTestId('assistant-send')).toBeEnabled()
})

test('reader scroll position remains fixed during deltas until Jump to latest', async ({ page }) => {
  await mockAssistantApi(page); await controlledStream(page)
  await page.goto('/assistant'); await send(page)
  await push(page, [{ type: 'user', message: user }, { type: 'delta', text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n\n') }])
  const region = page.getByTestId('assistant-scroll-region')
  await expect(page.locator('[data-markdown-mode=streaming] p')).toHaveCount(80)
  await region.evaluate(el => { el.scrollTop = 0 })
  await expect(page.getByTestId('assistant-scroll-down')).toBeVisible()
  await push(page, [{ type: 'delta', text: '\nMore scientific detail' }])
  await expect.poll(() => region.evaluate(el => el.scrollTop)).toBe(0)
  await page.getByTestId('assistant-scroll-down').click()
  await expect.poll(() => region.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('context memory distinguishes failures and confirms clearing with feedback', async ({ page }) => {
  await mockAssistantApi(page)
  await page.route('**/api/assistant/conversations', r => r.fulfill({ json: [conversation()] }))
  let fail = true, cleared = false
  await page.route('**/api/assistant/conversations/1/memory', r => {
    if (r.request().method() === 'DELETE') { cleared = true; return r.fulfill({ json: {} }) }
    return r.fulfill(fail ? { status: 503, json: { detail: 'Memory unavailable' } } : { json: { conversation_id: 1, summary: cleared ? '' : 'Reviewed dnaA regulation.', remembered_genes: cleared ? [] : ['dnaA'], pending_confirmations: [], recent_unresolved_questions: [], covered_up_to_message_id: 2 } })
  })
  await page.goto('/assistant?gene=dnaA')
  await page.locator('.assistant-context > summary').click()
  await page.locator('.assistant-memory > summary').click()
  await expect(page.getByText(/Memory unavailable/)).toBeVisible()
  await expect(page.getByText('No summary has been saved for this conversation.')).toHaveCount(0)
  fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('Reviewed dnaA regulation.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear memory' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear memory' }).click()
  await expect(page.getByText('Conversation memory cleared.')).toBeVisible()
  await expect(page.getByText('No summary has been saved for this conversation.')).toBeVisible()
})
