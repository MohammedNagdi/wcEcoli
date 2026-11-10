import {defineConfig,devices} from '@playwright/test'
export default defineConfig({
  testDir:'./e2e/explorer',workers:1,retries:0,timeout:120_000,reporter:'list',
  outputDir:process.env.EXPLORER_PROOFS||'../.pilot/proofs/hf06/browser',
  use:{actionTimeout:10_000,baseURL:process.env.EXPLORER_URL||'http://127.0.0.1:5175',trace:'retain-on-failure',viewport:{width:1440,height:1100}},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
})
