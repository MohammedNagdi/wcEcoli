import { expect, test } from '@playwright/test'

const genes = Array.from({ length: 500 }, (_, index) => ({
  id: index + 1,
  symbol: `fixture${index + 1}`,
  ecoli_id: `EG${index + 1}`,
  synonyms: '',
  category: 'other',
  left_end_pos: 1000 + index * 100,
  right_end_pos: 1050 + index * 100,
  direction: '+',
  ko_index: -1,
  is_mechanistic: false,
}))

test('reuses a progressive genome load on return and fetches again on refresh', async ({ page }) => {
  const requestedPages: number[] = []
  let finishSecondPage!: () => void
  const waitForReturn = new Promise<void>((resolve) => { finishSecondPage = resolve })
  await page.route('**/api/genes?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('page_size') !== '500') return route.fallback()
    const batch = Number(query.get('page'))
    requestedPages.push(batch)
    if (batch === 2) await waitForReturn
    await route.fulfill({ json: { genes: batch === 1 ? genes : [], total: 500, page: batch, page_size: 500 } })
  })

  const status = page.locator('.genome-load-status')
  const openMap = () => page.getByRole('link', { name: 'Genome Map', exact: true }).first().click()
  const openGuide = () => page.getByRole('link', { name: 'Guide', exact: true }).first().click()
  try {
    await page.goto('/genome')
    await expect(status).toContainText('500 genes loaded')
    await openGuide()
    await expect(page).toHaveURL(/\/guide/)
    await openMap()
    await expect(status).toContainText('500 genes loaded')
    expect(requestedPages).toEqual([1, 2])
    finishSecondPage()
    await expect(status).toContainText('500 mapped genes')

    await openGuide()
    await expect(page).toHaveURL(/\/guide/)
    await openMap()
    await expect(status).toContainText('500 mapped genes')
    await expect(status.getByRole('status')).toHaveCount(0)
    expect(requestedPages).toEqual([1, 2])

    await page.reload()
    await expect(status).toContainText('500 mapped genes')
    expect(requestedPages).toEqual([1, 2, 1, 2])
  } finally {
    finishSecondPage()
  }
})

test('retries a failed genome batch from the beginning', async ({ page }) => {
  const requestedPages: number[] = []
  await page.route('**/api/genes?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('page_size') !== '500') return route.fallback()
    const batch = Number(query.get('page'))
    requestedPages.push(batch)
    if (requestedPages.length === 2) return route.fulfill({ status: 503, json: { detail: 'Test failure' } })
    await route.fulfill({ json: { genes: batch === 1 ? genes : [], total: 500, page: batch, page_size: 500 } })
  })
  await page.goto('/genome')
  const status = page.locator('.genome-load-status')
  await expect(status.getByRole('alert')).toContainText('Only part of the genome loaded')
  await status.getByRole('button', { name: 'Retry genome data' }).click()
  await expect(status).toContainText('500 mapped genes')
  expect(requestedPages).toEqual([1, 2, 1, 2])
})
