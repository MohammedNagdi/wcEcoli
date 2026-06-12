# Assistant E2E (Playwright)

Browser tests for the Assistant UI. The assistant/platform API is **mocked at the browser boundary**
(`e2e/mocks/assistantApi.ts`), so these run against the Vite dev server alone — **no backend, Docker,
or LLM required**, and they're deterministic.

## First-time setup
```bash
cd interface/frontend
npm install                      # installs @playwright/test
npx playwright install chromium  # one-time browser download
```

## Run
```bash
npm run e2e        # headless; Playwright auto-starts `npm run dev`
npm run e2e:ui     # interactive UI mode
npx playwright test --list   # list/validate specs without running browsers
```

## Layout
- `playwright.config.ts` — config (auto-starts the dev server, baseURL :5173).
- `e2e/mocks/assistantApi.ts` — `mockAssistantApi(page, { reply, proposals })` stubs every assistant
  endpoint (status, conversations, SSE stream, preview/execute/confirm/dismiss).
- `e2e/tests/smoke.spec.ts` — Phase 0 baseline: send→streamed reply; propose→preview→confirm→card clears.

## Notes
- Tests target stable `data-testid`s (`assistant-input`, `assistant-send`, `assistant-stop`,
  `message-user`, `message-assistant`, `proposal-card`, `proposal-preview/confirm/reject`).
- The mock returns the whole SSE body at once; the frontend's stream parser still emits each
  `delta`/`done` event, so streaming render and the proposal lifecycle are exercised.
- Real backend coverage lives in `interface/backend/app/tests/test_assistant_harness.py` (48 tests).
