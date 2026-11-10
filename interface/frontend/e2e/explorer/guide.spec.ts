import {test,expect} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const sections=[['overview','Overview'],['variants','Experiment types'],['conditions','Growth conditions'],['timelines','Timelines'],['parameters','Design parameters'],['workflows','Design workflows'],['results','Reading results'],['shortcuts','Keyboard shortcuts']]
const forbidden=(method:string,path:string)=>path.startsWith('/api/')&&(!['GET','HEAD','OPTIONS'].includes(method)||/assistant|provider|train|debug/.test(path))

test('guide sections have durable URLs, history and working workspace shortcuts',async({page})=>{
  const requests:string[]=[],bad:string[]=[]
  page.on('request',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/'))requests.push(path);if(forbidden(r.method(),path))bad.push(path)})
  await page.goto('/guide')
  await expect(page.getByRole('heading',{name:'Explorer guide',exact:true})).toBeVisible()
  await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible()
  expect(requests).not.toContain('/api/variants')
  expect(requests).not.toContain('/api/condition-catalog')
  for(const [id,label] of sections){
    const link=page.getByRole('navigation',{name:'Guide sections'}).getByRole('link',{name:label,exact:true})
    await link.click();await expect(page).toHaveURL('/guide?section='+id)
    await expect(link).toHaveAttribute('aria-current','page')
    await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible()
  }
  await page.reload();await expect(page.getByRole('heading',{name:'Keyboard shortcuts',exact:true})).toBeVisible()
  await page.goBack();await expect(page.getByRole('heading',{name:'Reading results',exact:true})).toBeVisible()
  await page.goForward();await expect(page.getByRole('heading',{name:'Keyboard shortcuts',exact:true})).toBeVisible()
  await page.goto('/guide?section=overview')
  await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible()
  await page.keyboard.press('?')
  await expect(page).toHaveURL('/guide?section=shortcuts')
  const commandSearch=page.getByPlaceholder('Search genes, proteins, or IDs...', {exact:true})
  await page.keyboard.press('Control+k');await expect(commandSearch).toBeVisible()
  await expect(commandSearch).toBeFocused()
  await page.keyboard.press('Escape');await expect(commandSearch).not.toBeVisible()
  for(const section of ['not-a-section','assistant']){
    await page.goto('/guide?section='+section)
    await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible()
    await expect(page.getByRole('status')).toContainText(section==='assistant'?'Assistant is not available':'That guide section is unavailable')
  }
  expect(bad).toEqual([])
})

test('every designer-visible type has reviewed documentation and current metadata',async({page,request})=>{
  const all=await(await request.get('/api/variants')).json()
  const variants=all.filter((v:any)=>!['apply_variant','template','template_internal_shift'].includes(v.name))
  await page.goto('/guide?section=variants')
  await expect(page.locator('[data-variant]')).toHaveCount(variants.length)
  for(const variant of variants){
    const card=page.locator(`[data-variant="${variant.name}"]`)
    await card.locator(':scope > summary').click()
    await expect(card).toContainText(variant.parameter_hints.index_meaning)
    await expect(card).not.toContainText('Documentation for this catalog type has not been reviewed')
    if(variant.parameter_hints.timeline_notice)await expect(card).toContainText(variant.parameter_hints.timeline_notice)
    if(variant.parameter_hints.index_options?.length){
      await card.locator('.guide-options > summary').click()
      await expect(card.locator('.guide-options li')).toHaveText(variant.parameter_hints.index_options)
    }
  }
  const geneCard=page.locator('[data-variant="gene_knockout"]')
  for(const symbol of ['hisG','trpA','pgi']){
    const reference=await(await request.get('/api/genes/'+symbol)).json(),target=reference.expression_target
    const example=geneCard.locator('.guide-target').filter({has:page.getByRole('heading',{name:symbol,exact:true})})
    await expect(example).toContainText(String(target.index))
    await expect(example).toContainText(target.rna_id)
    await expect(example).toContainText(target.genes.filter((g:string)=>g!==symbol).join(', ')||'None recorded')
  }
  await expect(geneCard).not.toContainText('4749')
  await expect(page.locator('[data-variant="param_sensitivity"]')).toContainText('Detailed index options are not available')
})

test('environment reference tables match the publication and preserve timeline clocks',async({page,request})=>{
  const catalog=await(await request.get('/api/condition-catalog')).json()
  await page.goto('/guide?section=conditions')
  const conditions=page.getByRole('table',{name:'Published conditions',exact:true})
  await expect(conditions.locator('tbody tr')).toHaveCount(catalog.conditions.length)
  for(const c of catalog.conditions){
    const row=conditions.locator('tbody tr').filter({has:page.getByRole('rowheader',{name:c.condition,exact:true})})
    await expect(row).toContainText(c.nutrients)
    await expect(row.locator('td').nth(1)).toHaveText(c.doubling_time||'Not recorded')
  }
  const recipes=page.getByRole('table',{name:'Published media recipes',exact:true})
  await expect(recipes.locator('tbody tr')).toHaveCount(catalog.media_recipes.length)
  const stock=catalog.media_stocks[0]
  await page.locator('.guide-card').filter({has:page.locator('summary').getByText(stock.name,{exact:true})}).locator(':scope > summary').click()
  const stockTable=page.getByRole('table',{name:stock.name+' concentrations',exact:true})
  await expect(stockTable.locator('tbody tr')).toHaveCount(stock.rows.length)
  await expect(stockTable.locator('tbody td')).toHaveText(stock.rows.map((r:any)=>r.concentration))
  await page.goto('/guide?section=timelines')
  for(const timeline of catalog.timelines){
    const card=page.locator('.guide-card').filter({has:page.locator('summary').getByText(timeline.timeline,{exact:true})})
    await card.locator(':scope > summary').click()
    const events=timeline.events.split(',').map((s:string)=>s.trim().split(/\s+/))
    const rows=card.locator('tbody tr');await expect(rows).toHaveCount(events.length)
    for(let i=0;i<events.length;i++){
      await expect(rows.nth(i).locator('td').nth(0)).toHaveText(String(Number(events[i][0])))
      await expect(rows.nth(i).locator('td').nth(1)).toHaveText(String(Number(events[i][0])/60))
      await expect(rows.nth(i).locator('td').nth(2)).toHaveText(events[i][1])
    }
  }
})

test('reference failures keep static guidance, focus the error and recover on retry',async({page})=>{
  let fail=true
  await page.route('**/api/variants',route=>fail?route.fulfill({status:503,json:{detail:'Transport failure fixture'}}):route.continue())
  await page.goto('/guide?section=variants')
  const error=page.getByRole('alert')
  await expect(error).toContainText('Published reference data could not be loaded')
  await expect(error).toBeFocused()
  await expect(page.getByRole('heading',{name:'Read the parameter and environment together'})).toBeVisible()
  fail=false;await page.getByRole('button',{name:'Retry experiment types',exact:true}).click()
  await expect(page.locator('[data-variant="wildtype"]')).toBeVisible()
  await expect(error).not.toBeAttached()
})

test('malformed reference responses are unavailable rather than guessed',async({page})=>{
  await page.route('**/api/condition-catalog',route=>route.fulfill({json:{conditions:'malformed transport fixture'}}))
  await page.goto('/guide?section=conditions')
  await expect(page.getByRole('alert')).toContainText('Static guidance is still available')
  await expect(page.getByRole('heading',{name:'Stocks, recipes and conditions'})).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
})

for(const definition of ['1200 minimal','0 minimal, 0 minimal','0 minimal, -1 minimal','0 unknown_fixture_medium','not a timeline'])test(`invalid timeline is explicit: ${definition}`,async({page,request})=>{
  const catalog=await(await request.get('/api/condition-catalog')).json()
  catalog.timelines=[{timeline:'invalid_transport_fixture',events:definition}]
  await page.route('**/api/condition-catalog',route=>route.fulfill({json:catalog}))
  await page.goto('/guide?section=timelines')
  await page.getByText('invalid_transport_fixture',{exact:true}).click()
  await expect(page.getByRole('status')).toContainText('No schedule has been inferred')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('guide links keep designs personal and keyboard section navigation works',async({page})=>{
  const bad:string[]=[]
  page.on('request',r=>{if(forbidden(r.method(),new URL(r.url()).pathname))bad.push(r.method()+' '+new URL(r.url()).pathname)})
  await page.goto('/guide')
  const nav=page.getByRole('navigation',{name:'Guide sections'})
  await nav.getByRole('link',{name:'Overview',exact:true}).focus()
  await page.keyboard.press('Tab');await expect(nav.getByRole('link',{name:'Experiment types',exact:true})).toBeFocused()
  await page.keyboard.press('Enter')
  const card=page.locator('[data-variant="wildtype"]')
  await card.locator(':scope > summary').focus();await page.keyboard.press('Space')
  await expect(card).toHaveAttribute('open','')
  await card.getByRole('link',{name:'Design with this type',exact:false}).click()
  await expect(page).toHaveURL(/\/experiments\/new\?variant=wildtype$/)
  await expect(page.getByText('Personal browser draft.',{exact:false}).first()).toBeVisible()
  await page.getByLabel('Name',{exact:true}).fill('Guide verification draft')
  await page.getByRole('button',{name:'Save in this browser',exact:true}).click()
  await expect(page).toHaveURL(/draft=/)
  await page.reload();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Guide verification draft')
  await page.goto('/guide?section=workflows')
  const links=page.getByRole('navigation',{name:'Design workflows next steps'})
  for(const [label,path] of [['Single designer','/experiments/new'],['Batch builder','/experiments/batch'],['Environment Builder','/environment-builder'],['My drafts','/experiments?view=drafts']]){
    await expect(links.getByRole('link',{name:label+' →',exact:true})).toHaveAttribute('href',path)
  }
  for(const path of ['/experiments/batch','/environment-builder']){
    await page.goto('/guide?section=workflows')
    await page.locator(`.guide-links a[href="${path}"]`).click();await expect(page).toHaveURL(path)
    await expect(page.getByText(path==='/environment-builder'?'Personal environment workspace.':'Personal browser draft.',{exact:false}).first()).toBeVisible()
  }
  expect(bad).toEqual([])
})

for(const width of [390,1440])for(const theme of ['light','dark'] as const)test(`guide layout and access ${width}px ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:720})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
  for(const section of ['overview','variants','conditions','timelines','parameters','workflows','results','shortcuts']){
    await page.goto('/guide?section='+section)
    await expect(page.getByRole('heading',{name:'Explorer guide',exact:true})).toBeVisible()
    if(width<640)expect(await page.locator('.explorer-guide').evaluate(e=>e.clientWidth)).toBeGreaterThanOrEqual(width-32)
    if(section==='variants'){
      const card=page.locator('[data-variant="gene_knockout"]');await card.locator(':scope > summary').click()
      await expect(card).toContainText('TU0-198747[c]')
    }
    if(section==='conditions')await expect(page.getByRole('table',{name:'Published conditions',exact:true})).toBeVisible()
    if(section==='timelines')await expect(page.locator('.guide-card').first()).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
    const result=await new AxeBuilder({page}).analyze()
    expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([])
    if(['variants','conditions','results'].includes(section))await page.screenshot({path:info.outputPath(section+'.png')})
  }
  await page.goto('/guide?section=results')
  const content=page.getByRole('region',{name:'Guide section content'})
  expect(await content.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true)
  await content.hover();await page.mouse.wheel(0,1200)
  await expect.poll(()=>content.evaluate(e=>e.scrollTop)).toBeGreaterThan(0)
  await page.locator('.guide-source').scrollIntoViewIfNeeded()
  await expect(page.locator('.guide-source')).toBeInViewport()
  await page.screenshot({path:info.outputPath('results-scrolled.png')})
  if(width<640){
    const menu=page.locator('.guide-site-menu')
    await menu.locator('summary').click()
    await expect(page.getByRole('navigation',{name:'Guide site navigation'})).toBeVisible()
    await page.keyboard.press('Escape');await expect(menu).not.toHaveAttribute('open','')
    await menu.locator('summary').click()
    await page.getByRole('navigation',{name:'Guide site navigation'}).getByRole('link',{name:'Results',exact:true}).click()
    await expect(page).toHaveURL('/results')
    await expect(page.getByRole('button',{name:'Open workspace navigation',exact:true})).toBeVisible()
  }
})
