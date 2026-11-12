import { test, expect, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

const scientific = String.raw`## Growth condition and timeline

1. Growth Condition and Timeline:

   - The experiment used \`glc_20mM\`: 20 mM glucose, 5 mM at 1800 seconds, and 2 mM at 3600 seconds.

2. Division and Growth:

   - One division after 2529 seconds (42.15 minutes).
   - Final cell mass: **2344.5 fg**.

3. Growth Rate and Doubling Time:

   - Average growth rate: 0.000247 per second.
   - Doubling time: 46.7 minutes.

4. Summary:

   - The cell grew and divided.

| Metric | Value | Unit |
| --- | ---: | --- |
| Mass | 2344.5 | fg |
| Growth | 0.000247 | s⁻¹ |

$$
\mu = \frac{\ln 2}{T_d}
$$

create_experiment and variant_index remain intact.`.replace(/\\`/g, '`')
const code = '  const concentration = 20;\n\nconsole.log("glc_20mM");\n'
const withCode = scientific + '\n\n```javascript\n' + code + '```'
const conv = { id: 1, title: 'Formatting', assistant_surface: 'central', status: 'open', provider_id: 'openai', model: 'gpt-4.1-mini', created_at: '', updated_at: '' }
const user = { id: 1, conversation_id: 1, role: 'user', content: 'Question', context: {}, status: 'stored', provider_id: '', model: '', created_at: '' }
const answer = (content: string, id = 2) => ({ ...user, id, role: 'assistant', content, status: 'completed' })
async function send(page: Page) { await page.getByTestId('assistant-input').fill('Question'); await expect(page.getByTestId('assistant-send')).toBeEnabled(); await page.getByTestId('assistant-send').click() }
async function stored(page: Page, contents: string[], url = '/assistant') {
  await mockAssistantApi(page)
  await page.route('**/api/assistant/conversations', r => r.fulfill({ json: [conv] }))
  await page.route('**/api/assistant/conversations/1/messages', r => r.fulfill({ json: contents.map((content, i) => answer(content, i * 2 + 2)) }))
  await page.goto(url)
}
async function clipboard(page: Page) { await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).copied = text } }, configurable: true })) }
async function controlled(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); (window as any).streamRequests = 0
    window.fetch = async (input, init) => {
      if (!String(input).endsWith('/messages/stream')) return original(input, init)
      ;(window as any).streamRequests++
      const body = new ReadableStream({ start(controller) { (window as any).controller = controller; init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError'))) } })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
}
async function push(page: Page, events: unknown[]) {
  await page.waitForFunction(() => !!(window as any).controller)
  await page.evaluate(events => {
    for (const e of events) (window as any).controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
  }, events)
}
async function instrument(page: Page, fail = false) {
  await page.addInitScript(fail => { (window as any).formattingFailure = fail; (window as any).markdownParses = {} }, fail)
  await page.route('**/src/components/assistant/AssistantMarkdown.tsx', async r => {
    const response = await r.fetch()
    const body = (await response.text()).replace('function FormattedMarkdown({ text, mode, messageKey }) {', `function FormattedMarkdown({ text, mode, messageKey }) { window.markdownParses[messageKey] = (window.markdownParses[messageKey] || 0) + 1; if (window.formattingFailure) throw new Error('Deterministic renderer failure');`)
    await r.fulfill({ response, body })
  })
}

test('scientific nesting, values, code and answer copying preserve original source', async ({ page }) => {
  await clipboard(page); await stored(page, [withCode]); const response = page.getByTestId('message-assistant')
  await expect(response.locator('ol').first().locator(':scope > li')).toHaveCount(4); await expect(response.locator('ol > li > ul')).toHaveCount(4)
  await expect(response.locator('h2').first()).toHaveText('Growth condition and timeline'); await expect(response.locator('table tbody tr')).toHaveCount(2)
  await expect(response).toContainText('2344.5'); await expect(response).toContainText('variant_index')
  await response.getByRole('button', { name: 'Copy code', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(code)
  await response.getByRole('button', { name: 'View source', exact: true }).click(); await expect(response.locator('.assistant-source')).toHaveText(withCode)
  await page.getByRole('button', { name: 'Copy answer', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(withCode)
  await response.getByRole('button', { name: 'Formatted answer', exact: true }).click(); await expect(response.locator('ol > li > ul')).toHaveCount(4)
})
test('CommonMark starts, loose paragraphs, nesting, escapes and intentional restarts', async ({ page }) => {
  await stored(page, ['3. Third\n\n   Continuation paragraph.\n\n   - Nested **bold and _italic_**.\n4. Fourth\n\n---\n\n1. Restart\n\n\\*literal\\* and snake_case_identifier.\n\n> Evidence\n\n- [x] checked\n- [ ] unchecked']); const response = page.getByTestId('message-assistant')
  await expect(response.locator('ol').first()).toHaveAttribute('start', '3'); await expect(response.locator('ol')).toHaveCount(2)
  await expect(response.locator('ol').first().locator(':scope > li')).toHaveCount(2); await expect(response.locator('li strong em')).toHaveText('italic')
  await expect(response).toContainText('*literal* and snake_case_identifier.'); await expect(response.locator('blockquote')).toContainText('Evidence'); await expect(response.locator('input[type=checkbox]:disabled')).toHaveCount(2)
})
test('links are safe, HTML literal, and images make no requests', async ({ page }) => {
  let images = 0; page.on('request', r => { if (r.resourceType() === 'image' && r.url().includes('untrusted.invalid')) images++ })
  await stored(page, ['[gene](/genome?gene=dnaA&job=12) [docs](https://example.org/help) [bad](javascript:alert(1)) [data](data:text/html,bad) [redirect](//untrusted.invalid)\n\n<img src="https://untrusted.invalid/a" onerror="alert(1)">\n\n<script>window.infected=true</script>\n\n![evidence figure](https://untrusted.invalid/figure.png)']); const response = page.getByTestId('message-assistant')
  await expect(response.getByRole('link', { name: 'gene' })).toHaveAttribute('href', '/genome?gene=dnaA&job=12'); await expect(response.getByRole('link', { name: 'docs' })).toHaveAttribute('rel', 'noopener noreferrer'); await expect(response.getByRole('link')).toHaveCount(2)
  await expect(response.locator('img, script')).toHaveCount(0); await expect(response).toContainText('<img src='); await expect(response).toContainText('evidence figure'); expect(images).toBe(0); expect(await page.evaluate(() => (window as any).infected)).toBeUndefined()
})
test('valid MathML and invalid or resource-limited equations fail locally', async ({ page }) => {
  await stored(page, ['Inline $$x^2$$. Dollars $5 and $10; literal 10^-3.\n\n$$\nx = \\frac{1}{2}\n$$\n\n```math\ny = x^2\n```\n\nUnsupported $$\\unknown{2}$$.\n\n$$\\def\\a{\\a}\\a$$\n\n$$\\rule{1000em}{1000em}$$\n\n$$\\href{javascript:alert(1)}{bad}$$']); const response = page.getByTestId('message-assistant')
  await expect(response.locator('math').first()).toBeAttached(); await expect(response.locator('math')).toHaveCount(4); await expect(response).toContainText('Dollars $5 and $10; literal 10^-3.')
  await expect(response.locator('.assistant-equation-error')).toHaveCount(3); await expect(response).toContainText('\\unknown{2}'); await expect(response.getByRole('link', { name: 'bad' })).toHaveCount(0)
  expect(await response.locator('.katex').last().evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(400)
})
test('footnotes are unique and scroll only the conversation', async ({ page }) => {
  await stored(page, ['First[^1].\n\n' + 'Evidence paragraph.\n\n'.repeat(35) + '[^1]: First note.', 'Second[^1].\n\n[^1]: Second note.']); await expect(page.getByTestId('message-assistant')).toHaveCount(2)
  const ids = await page.locator('.assistant-markdown [id]').evaluateAll(nodes => nodes.map(n => n.id)); expect(new Set(ids).size).toBe(ids.length); expect(ids.filter(id => id.endsWith('footnote-label'))).toHaveLength(2)
  const region = page.getByTestId('assistant-scroll-region'); await region.evaluate(el => { el.scrollTop = 0 }); const windowBefore = await page.evaluate(() => window.scrollY)
  await page.getByTestId('message-assistant').first().locator('sup a').click(); await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(100); expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore)
})
test('local rendering retry retains source and makes no submissions', async ({ page }) => {
  await clipboard(page); await instrument(page, true); let submissions = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/messages')) submissions++ })
  await stored(page, ['**Original scientific value: 2344.5 fg.**']); const response = page.getByTestId('message-assistant')
  await expect(response.getByRole('alert')).toContainText('Formatting unavailable'); await expect(response.locator('.assistant-source')).toContainText('2344.5 fg')
  await response.getByRole('button', { name: 'Copy original response' }).click(); expect(await page.evaluate(() => (window as any).copied)).toBe('**Original scientific value: 2344.5 fg.**')
  await page.evaluate(() => { (window as any).formattingFailure = false }); await response.getByRole('button', { name: 'Retry formatting' }).click(); await expect(response.locator('strong')).toHaveText('Original scientific value: 2344.5 fg.'); expect(submissions).toBe(0)
})
test('unfinished streaming formatting is temporary and final source authoritative', async ({ page }) => {
  await clipboard(page); await controlled(page); await mockAssistantApi(page); await page.goto('/assistant'); await send(page)
  await push(page, [{ type: 'user', message: user }, { type: 'delta', text: '**Mass 2344.5' }]); const live = page.locator('[data-markdown-mode=streaming]'); await expect(live.locator('strong')).toHaveText('Mass 2344.5')
  await push(page, [{ type: 'delta', text: ' fg**\n\n[Evidence](https://exampl' }]); await expect(live).toContainText('Evidence'); await expect(live.locator('a')).toHaveCount(0)
  await push(page, [{ type: 'delta', text: 'e.org)\n\n```python\nx = {' }]); await expect(live.locator('pre code')).toHaveText('x = {'); await live.getByRole('button', { name: 'Copy code' }).click(); expect(await page.evaluate(() => (window as any).copied)).toBe('x = {')
  await push(page, [{ type: 'delta', text: '1, 2}\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n$$x^' }]); await expect(live.locator('table')).toBeVisible(); await push(page, [{ type: 'delta', text: '2$$' }]); await expect(live.locator('math')).toHaveCount(1)
  await push(page, [{ type: 'done', conversation: conv, user_message: user, assistant_message: answer(withCode), proposals: [] }]); await expect(live).toHaveCount(0); await expect(page.getByTestId('message-assistant').locator('ol > li > ul')).toHaveCount(4)
  await page.getByTestId('message-assistant').getByRole('button', { name: 'View source' }).click(); await expect(page.locator('.assistant-source')).toHaveText(withCode); expect(await page.evaluate(() => (window as any).streamRequests)).toBe(1)
})
test('Stop preserves received source and incomplete code', async ({ page }) => {
  await controlled(page); await mockAssistantApi(page); await page.goto('/assistant'); await send(page); const partial = '**Partial value**\n\n```python\nx = {1'
  await push(page, [{ type: 'user', message: user }, { type: 'delta', text: partial }]); await expect(page.locator('[data-markdown-mode=streaming] pre')).toContainText('x = {1'); await page.getByRole('button', { name: 'Stop response' }).click()
  const result = page.locator('[data-markdown-mode=partial]'); await expect(result.locator('strong')).toHaveText('Partial value'); await result.getByRole('button', { name: 'View source' }).click(); await expect(result.locator('.assistant-source')).toHaveText(partial); expect(await page.evaluate(() => (window as any).streamRequests)).toBe(1)
})
for (const size of [20, 100]) test(`streamed ${size} KB stays usable without reparsing completed answers`, async ({ page }, info) => {
  await instrument(page); await controlled(page); await stored(page, ['## Stored answer\n\nValue **2344.5 fg**.']); await expect(page.getByTestId('message-assistant')).toBeVisible()
  const before = await page.evaluate(() => (window as any).markdownParses['1-2']); expect(before).toBeGreaterThan(0); await send(page)
  const text = ('Scientific value **2344.5 fg**, `glc_20mM`, and 0.000247 s⁻¹.\n\n').repeat(2000).slice(0, size * 1024); const started = Date.now()
  for (let i = 0; i < text.length; i += 8192) { await push(page, [{ type: 'delta', text: text.slice(i, i + 8192) }]); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))) }
  await expect(page.locator('[data-markdown-mode=streaming]')).toContainText('Scientific value'); const settled = Date.now() - started
  await page.getByTestId('assistant-input').fill('Retained next question'); await expect(page.getByTestId('assistant-input')).toHaveValue('Retained next question'); await page.getByTestId('assistant-scroll-region').evaluate(el => { el.scrollTop = 0 }); await expect(page.getByTestId('assistant-scroll-down')).toBeVisible()
  expect(await page.evaluate(() => (window as any).markdownParses['1-2'])).toBe(before); await page.getByRole('button', { name: 'Stop response' }).click(); await expect(page.locator('[data-markdown-mode=partial]')).toBeVisible()
  const measurement = { browser: info.project.name, sizeKB: size, streamedDisplayMs: settled, completedMessageParsesBefore: before, completedMessageParsesAfter: await page.evaluate(() => (window as any).markdownParses['1-2']) }
  await mkdir('../../output/assistant-markdown', { recursive: true })
  await writeFile(`../../output/assistant-markdown/${info.project.name}-${size}kb.json`, JSON.stringify(measurement, null, 2))
  await info.attach('stream-measurement', { body: JSON.stringify(measurement), contentType: 'application/json' })
})
for (const width of [390, 768, 1440]) for (const theme of ['light', 'dark'] as const) for (const dock of [false, true]) test(`${dock ? 'dock' : 'page'} ${width}px ${theme} scientific formatting`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' }); await page.addInitScript(theme => localStorage.setItem('theme', theme), theme)
  await stored(page, [withCode], dock ? '/explore' : '/assistant'); if (dock) await page.getByTestId('assistant-dock-toggle').click(); const response = page.getByTestId('message-assistant')
  await expect(response.locator('table')).toBeAttached(); await expect(response.locator('math')).toBeAttached(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByTestId('assistant-scroll-region').evaluate(el => { el.scrollTop = 0 }); expect((await new AxeBuilder({ page }).include('.assistant-markdown').analyze()).violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual([])
  await page.screenshot({ path: `../../output/assistant-markdown/${info.project.name}-${dock ? 'dock' : 'page'}-${width}-${theme}.png` }); await page.setViewportSize({ width: Math.floor(width / 2), height: 450 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await expect(page.getByTestId('assistant-input')).toBeVisible()
})


test('code copy handles nested quotes, lists, CRLF, empty blocks and trailing whitespace', async ({ page }) => {
  await clipboard(page)
  const fixtures = ['> ```python\n>   x = 1  \n> ```', '1. Example\n\n   ```python\n     x = 2\n   ```', '```text\r\n  a\r\n\r\nb\r\n```', '```text\n```', '```text\nends with spaces  ']
  await stored(page, fixtures)
  const expected = ['  x = 1  \n', '  x = 2\n', '  a\r\n\r\nb\r\n', '', 'ends with spaces  ']
  const responses = page.getByTestId('message-assistant')
  for (let i = 0; i < fixtures.length; i++) {
    await responses.nth(i).getByRole('button', { name: 'Copy code', exact: true }).click()
    expect(await page.evaluate(() => (window as any).copied)).toBe(expected[i])
  }
})

test('incomplete HTML, comparisons, snake_case and reference definitions stay faithful', async ({ page }) => {
  await controlled(page); await mockAssistantApi(page); await page.goto('/assistant'); await send(page)
  await push(page, [{ type: 'delta', text: 'A <custom and value > 25; snake_case_identifier.\n\n[Result][ref]' }])
  const live = page.locator('[data-markdown-mode=streaming]')
  await expect(live).toContainText('A <custom and value > 25; snake_case_identifier.'); await expect(live.locator('a')).toHaveCount(0)
  await push(page, [{ type: 'delta', text: '\n\n[ref]: /results?job=12' }]); await expect(live.getByRole('link', { name: 'Result' })).toHaveAttribute('href', '/results?job=12')
  await page.getByRole('button', { name: 'Stop response' }).click()
})
