import { defineConfig, devices } from '@playwright/test'
// Dedicated real-artifact test: no dev server, routes, fixtures or mocked science.
export default defineConfig({
  testDir: './e2e/pilot',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  outputDir: process.env.PILOT_BROWSER_OUTPUT || '/tmp/wcecoli-hf04-browser',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1100 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
