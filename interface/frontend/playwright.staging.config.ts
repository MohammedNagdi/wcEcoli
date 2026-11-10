import {defineConfig,devices} from '@playwright/test'
export default defineConfig({
  testDir:'./e2e/staging', workers:1, retries:0, timeout:300_000, reporter:'list',
  expect:{timeout:60_000},
  outputDir:'../.publication/proofs/browser',
  use:{baseURL:'https://safrot-wcecoli-explorer.hf.space',trace:'off',video:'off',screenshot:'off',
    viewport:{width:1440,height:1100}},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
})
