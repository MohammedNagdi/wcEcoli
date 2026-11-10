import {test, expect} from '@playwright/test'
import {writeFile} from 'node:fs/promises'

test('full campaign serves twelve real cleaned experiments and controls', async ({page, request}, info) => {
  test.skip(process.env.DEMO_COMPLETE !== '1', 'Run after the complete real campaign is activated')
  test.setTimeout(240_000)
  const errors: string[] = []
  const assistant: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('request', req => {if (new URL(req.url()).pathname.includes('/assistant')) assistant.push(req.url())})
  const health = await (await request.get('/api/health')).json()
  expect(health).toMatchObject({scope:'full', read_only:true, synthetic:false})
  const data = await (await request.get('/api/pilot')).json()
  expect(data.experiments).toHaveLength(12)
  expect(data.unrun).toEqual([])
  const evidence: any[] = []
  await page.goto('/')
  await expect(page.getByRole('heading', {name:'Published campaign results', exact:true})).toBeVisible()
  for (const experiment of data.experiments) {
    expect(['completed','no_division','terminated']).toContain(experiment.outcome)
    expect(experiment.controls.every((control: any) => control.available)).toBe(true)
    const select = page.getByLabel('Experiment', {exact:true})
    if (await select.inputValue() !== String(experiment.job_id)) {
      const response = page.waitForResponse(r => r.url().includes(`/api/jobs/${experiment.job_id}/timeseries`) && r.status() === 200)
      await select.selectOption(String(experiment.job_id))
      await response
    }
    await expect(page.getByRole('heading', {name:experiment.question, exact:true})).toBeVisible()
    const scalars = await (await request.get(`/api/jobs/${experiment.job_id}/timeseries`)).json()
    const expectedCharts = ['cell_mass','growth_rate'].filter(name => scalars.timeseries[name]?.length).length
    await expect(page.getByTestId('pilot-scalar-charts').locator('canvas')).toHaveCount(expectedCharts)
    const channels = await (await request.get(`/api/jobs/${experiment.job_id}/molecules`)).json()
    for (const channel of channels.available_types) {
      const kind = page.getByLabel('Molecular channel', {exact:true})
      if (await kind.inputValue() !== channel.molecule_type) {
        const response = page.waitForResponse(r => r.url().includes(`/api/jobs/${experiment.job_id}/molecules/${channel.molecule_type}/timeseries?`) && r.status() === 200)
        await kind.selectOption(channel.molecule_type)
        const payload = await (await response).json()
        expect(payload.molecules.length).toBeGreaterThan(0)
        expect(payload.molecules.every((series:any) => series.molecule_type === channel.molecule_type && series.time_basis === 'elapsed_lineage_seconds')).toBe(true)
      }
      await expect(page.getByLabel('Molecule', {exact:true})).not.toHaveValue('')
      await expect(page.getByTestId('pilot-molecule-chart').locator('canvas')).toHaveCount(1)
    }
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (experiment.key === 'wt-add-aa' || experiment.key === 'wt-cut-aa') {
      const event = experiment.execution_provenance.event_observations[0]
      expect(event.requested_lineage_sec).toBe(1200)
      expect(['verified','not_reached_before_lineage_end']).toContain(event.status)
      if (event.status === 'verified') expect(event.first_saved_observation_sec).toBeGreaterThanOrEqual(1200)
    }
    evidence.push({key:experiment.key, outcome:experiment.outcome, generations:experiment.trajectories.map((t:any)=>t.generation),
      controls:experiment.controls, matrix_families:channels.available_types.map((t:any)=>t.molecule_type)})
    if (['wt-with-aa','trpA-basal','pgi-acetate','wt-cut-aa'].includes(experiment.key)) {
      await page.screenshot({path:info.outputPath(`${experiment.key}.png`), fullPage:true})
    }
  }
  expect((await request.post('/api/jobs', {data:{}})).status()).toBe(405)
  expect(errors).toEqual([])
  expect(assistant).toEqual([])
  await writeFile(info.outputPath('full-campaign-evidence.json'), JSON.stringify({passed:true, scientific_data:'real artifacts; no route mocks', experiments:evidence}, null, 2))
})
