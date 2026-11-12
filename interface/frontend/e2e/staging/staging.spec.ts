import {test,expect} from '@playwright/test'

const origin='https://safrot-wcecoli-explorer.hf.space'
test('private staging serves published results and personal drafts',async({page,context},info)=>{
  const publicCheck = Boolean(process.env.EXPLORER_HOSTED_REFERENCES)
  test.skip(!publicCheck && process.env.HF08_STAGING_ACCEPTANCE!=='1','Requires a hosted verification run')
  if (!publicCheck) {
    const token=process.env.HF_VERIFY_TOKEN
    expect(token,'Configure verification access securely').toBeTruthy()
    // Scope the verification credential to this Space. Public checks use no credentials.
    await context.route(origin+'/**',async route=>{
      if(new URL(route.request().url()).origin!==origin){await route.abort();return}
      await route.continue({headers:{...route.request().headers(),authorization:'Bearer '+token}})
    })
  }
  const writes:string[]=[]
  page.on('request',r=>{if(r.url().startsWith(origin+'/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push(r.method())})
  await page.goto('/experiments')
  await expect(page.getByRole('button',{name:'Published experiments (12)',exact:true})).toBeVisible()
  const experiments=await page.evaluate(async()=>await(await fetch('/api/experiments')).json())
  expect(experiments).toHaveLength(12)
  const wt=experiments.find((e:{name:string})=>e.name==='wt-basal')
  await page.goto('/results/'+wt.job_id)
  await expect(page.locator('canvas').first()).toBeVisible()
  for(const family of ['mRNA','protein','reaction_flux','exchange_flux']){
    const data=await page.evaluate(async({job,family})=>await(await fetch(`/api/jobs/${job}/molecules/${family}/ids?limit=1`)).json(),{job:wt.job_id,family})
    expect(data.ids.length).toBeGreaterThan(0)
    const series=await page.evaluate(async({job,family,id})=>await(await fetch(`/api/jobs/${job}/molecules/${family}/timeseries?ids=${encodeURIComponent(id)}`)).json(),{job:wt.job_id,family,id:data.ids[0]})
    expect(series.molecules.length).toBeGreaterThan(0)
  }
  await page.locator('canvas').first().scrollIntoViewIfNeeded()
  if (!publicCheck) await page.screenshot({path:info.outputPath('real-result.png')})
  await page.goto('/experiments/new')
  await expect(page.getByText('Personal browser draft.',{exact:false}).first()).toBeVisible()
  await page.getByLabel('Name',{exact:true}).fill('Private staging draft')
  await page.getByRole('button',{name:'Save in this browser',exact:true}).click()
  await expect(page).toHaveURL(/draft=[a-f0-9-]{36}/)
  await page.reload()
  await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Private staging draft')
  const download=page.waitForEvent('download')
  await page.getByRole('button',{name:'Download current draft',exact:true}).click()
  expect((await download).suggestedFilename()).toMatch(/\.json$/)
  expect(writes).toEqual([])
})
