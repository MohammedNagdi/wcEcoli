import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('real WT artifact reaches mass, growth and selected molecular charts', async ({ page, request }, info) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('request', req => requests.push(new URL(req.url()).pathname))
  const health = await (await request.get('/api/health')).json()
  expect(health).toMatchObject({ status: 'ok', read_only: true, synthetic: false })
  const index = await (await request.get('/api/pilot')).json()
  const wt = index.experiments.find((e: {key: string}) => e.key === 'wt-basal')
  expect(wt).toBeTruthy()
  const scalar = await (await request.get(`/api/jobs/${wt.job_id}/timeseries`)).json()
  for (const name of ['cell_mass', 'growth_rate']) {
    expect(scalar.timeseries[name].length).toBeGreaterThan(0)
    for (const series of scalar.timeseries[name]) {
      expect(series.time_basis).toBe('elapsed_lineage_seconds')
      expect(series.points.length).toBeGreaterThan(1)
      expect(series.points.every((p: {time: number; value: number}) => Number.isFinite(p.time) && (p.value === null || Number.isFinite(p.value)))).toBeTruthy()
      expect(series.label).toContain(`generation ${series.generation}`)
    }
  }
  const ids = await (await request.get(`/api/jobs/${wt.job_id}/molecules/protein/ids?limit=50`)).json()
  let selected = '', molecular: any
  for (const id of ids.ids) {
    const candidate = await (await request.get(`/api/jobs/${wt.job_id}/molecules/protein/timeseries?ids=${encodeURIComponent(id)}`)).json()
    if (candidate.molecules?.some((s: any) => s.points.some((p: any) => p.value > 0))) {
      selected = id; molecular = candidate; break
    }
  }
  expect(selected).not.toBe('')
  await page.goto('/')
  await expect(page.getByRole('heading', {name: index.scope === 'full' ? 'Published campaign results' : 'Published pilot results', exact: true})).toBeVisible()
  await expect(page.getByTestId('pilot-scalar-charts').locator('canvas')).toHaveCount(2)
  await page.getByLabel('Molecular channel', {exact: true}).selectOption('protein')
  await expect(page.getByLabel('Molecule', {exact: true}).locator('option', {hasText: selected})).toHaveCount(1)
  if (await page.getByLabel('Molecule', {exact: true}).inputValue() !== selected) {
    const response = page.waitForResponse(r => r.url().includes('/protein/timeseries') && r.url().includes(encodeURIComponent(selected)) && r.status() === 200)
    await page.getByLabel('Molecule', {exact: true}).selectOption(selected)
    await response
  }
  await expect(page.getByTestId('pilot-molecule-chart').locator('canvas')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('assistant-dock-toggle')).toHaveCount(0)
  expect(requests.filter(path => path.includes('/assistant'))).toEqual([])
  expect(errors).toEqual([])
  expect((await request.post('/api/jobs', {data: {}})).status()).toBe(405)
  const screenshot = info.outputPath('real-pilot.png')
  await page.screenshot({path: screenshot, fullPage: true})
  const evidence = {
    passed: true, scientific_data: 'real validated published artifact; no route mocking',
    url: 'http://127.0.0.1:5175', key: wt.key, job_id: wt.job_id,
    generations: scalar.timeseries.cell_mass.map((s: any) => s.generation),
    scalar_samples: Object.fromEntries(['cell_mass','growth_rate'].map(name => [name, scalar.timeseries[name].map((s: any) => s.points.length)])),
    molecule_type: 'protein', molecule_id: selected,
    molecular_samples: molecular.molecules.map((s: any) => s.points.length),
    screenshot, console_errors: errors, assistant_requests: [], checked_at: new Date().toISOString(),
  }
  await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
})

test('completed pilot exposes all real outcomes and the verified lineage shift', async ({page, request}, info) => {
  test.skip(process.env.PILOT_COMPLETE !== '1', 'Enabled after all three pilot outcomes are accounted for')
  const data = await (await request.get('/api/pilot')).json()
  expect(data.experiments.map((e: any) => e.key).sort()).toEqual(['hisG-basal','wt-add-aa','wt-basal'])
  expect(data.unrun).toHaveLength(9)
  const his = data.experiments.find((e: any) => e.key === 'hisG-basal')
  expect(his.outcome).toBe('no_division')
  expect(his.reason).toContain('TimeLimitReached')
  expect(his.trajectories.map((t: any) => t.generation)).toEqual([0,1,2])
  expect(his.co_targeted_genes).toHaveLength(7)
  const shift = data.experiments.find((e: any) => e.key === 'wt-add-aa')
  expect(shift.execution_provenance.event_observations[0]).toMatchObject({
    requested_lineage_sec: 1200, first_saved_observation_sec: 1200, status: 'verified',
  })
  expect(shift.controls.find((c: any) => c.key === 'wt-with-aa').available).toBe(false)
  await page.goto('/')
  for (const experiment of data.experiments) {
    const select = page.getByLabel('Experiment', {exact: true})
    if (await select.inputValue() !== String(experiment.job_id)) {
      const response = page.waitForResponse(r => r.url().includes(`/api/jobs/${experiment.job_id}/timeseries`) && r.status() === 200)
      await select.selectOption(String(experiment.job_id))
      await response
    }
    await expect(page.getByRole('heading', {name: experiment.question,exact: true})).toBeVisible()
    await expect(page.getByTestId('pilot-scalar-charts').locator('canvas')).toHaveCount(2)
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (experiment.key === 'hisG-basal') {
      await expect(page.getByText(`Model expression perturbation targets ${his.transcription_unit_id}.`, {exact:false})).toBeVisible()
    }
    await page.screenshot({path:info.outputPath(`${experiment.key}.png`),fullPage:true})
  }
})
