import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

const origin='https://safrot-wcecoli-explorer.hf.space'
const sections=[['overview','Overview'],['variants','Experiment types'],['conditions','Growth conditions'],['timelines','Timelines'],['parameters','Design parameters'],['workflows','Design workflows'],['results','Reading results'],['shortcuts','Keyboard shortcuts']]

for(const [width,theme] of [[1440,'light'],[390,'dark']] as const)test(`hosted explorer guide ${width}px ${theme}`,async({page,context},info)=>{
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
  await page.setViewportSize({width,height:900})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
  const bad:string[]=[]
  page.on('request',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/')&&(!['GET','HEAD','OPTIONS'].includes(r.method())||/assistant|provider|train|debug/.test(path)))bad.push(r.method()+' '+path)})
  const source=await readFile(process.env.EXPLORER_HOSTED_REFERENCES || '../.pilot/explorer-release/references.json','utf8'),reference=JSON.parse(source)
  await page.goto('/guide')
  await expect(page.getByRole('navigation',{name:'Guide sections'})).toBeVisible()
  const capabilities=await page.evaluate(async()=>await(await fetch('/api/capabilities')).json())
  expect(capabilities.reference_sha256).toBe(createHash('sha256').update(source).digest('hex'))
  for(const [id,label] of sections){
    await page.getByRole('navigation',{name:'Guide sections'}).getByRole('link',{name:label,exact:true}).click()
    await expect(page).toHaveURL(origin+'/guide?section='+id)
    await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible()
    if(id==='variants'){
      await expect(page.locator('[data-variant]')).toHaveCount(reference.variants.filter((v:{name:string})=>!['apply_variant','template','template_internal_shift'].includes(v.name)).length)
      const card=page.locator('[data-variant="gene_knockout"]');await card.locator(':scope > summary').click()
      const expected=reference.gene_targets.hisG
      await expect(card).toContainText(expected.rna_id)
      await expect(card).toContainText(expected.genes.filter((g:string)=>g!=='hisG').join(', '))
    }
    if(id==='conditions')await expect(page.getByRole('table',{name:'Published conditions',exact:true}).locator('tbody tr')).toHaveCount(reference.condition_catalog.conditions.length)
    if(id==='timelines')await expect(page.locator('.guide-card')).toHaveCount(reference.condition_catalog.timelines.length)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
  }
  await page.reload();await expect(page.getByRole('heading',{name:'Keyboard shortcuts',exact:true})).toBeVisible()
  await page.goto('/guide?section=results')
  await expect(page.getByRole('heading',{name:'Reading results',exact:true})).toBeVisible()
  const content=page.getByRole('region',{name:'Guide section content'});await content.hover();await page.mouse.wheel(0,1000)
  await expect.poll(()=>content.evaluate(e=>e.scrollTop)).toBeGreaterThan(0)
  if(width<640)expect(await page.locator('.explorer-guide').evaluate(e=>e.clientWidth)).toBeGreaterThanOrEqual(width-32)
  if (!publicCheck) await page.screenshot({path:info.outputPath('guide-results.png')})
  await page.goto('/explore')
  await page.getByRole('button',{name:'Help: Mechanistic',exact:true}).click()
  await page.getByRole('region',{name:'Mechanistic help',exact:true}).getByRole('link',{name:'Read the guide',exact:false}).click()
  const mechanistic=page.getByRole('heading',{name:'Mechanistic genes',exact:true})
  await expect(mechanistic).toBeFocused();await expect(mechanistic).toBeInViewport()
  if (!publicCheck) await page.screenshot({path:info.outputPath('mechanistic-target.png')})
  await page.goto('/guide?section=workflows')
  await page.locator('.guide-links a[href="/experiments/new"]').click()
  await expect(page.getByText('Personal browser draft.',{exact:false}).first()).toBeVisible()
  await page.getByLabel('Experiment type',{exact:true}).selectOption('gene_knockout')
  await page.getByLabel('Name',{exact:true}).fill('Hosted contextual guide check')
  await page.getByRole('link',{name:'Documentation',exact:true}).click()
  const leave=page.getByRole('alertdialog',{name:'Leave unsaved personal draft?',exact:true})
  await expect(leave).toBeVisible();await leave.getByRole('button',{name:'Leave without saving',exact:true}).click()
  await expect(page.locator('[data-variant="gene_knockout"] > summary')).toBeFocused()
  expect(bad).toEqual([])
})
