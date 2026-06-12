import { defineConfig, devices } from '@playwright/test'

/**
 * E2E config for the Assistant UI.
 *
 * Tests run against the Vite dev server ONLY — the assistant/platform API is mocked at the browser
 * boundary (see e2e/mocks/assistantApi.ts), so no backend, Docker, or LLM is required and runs are
 * deterministic. Playwright auto-starts `npm run dev`.
 *
 * First-time setup:
 *   npm install
 *   npx playwright install chromium
 *   npm run e2e
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Dedicated port + no reuse so e2e always serves THIS working tree, never a stray dev/Docker
  // server that may be on :5173.
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
