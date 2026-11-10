import {test,expect,type Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const topics=[['mechanistic','Mechanistic genes'],['expression-only','Expression-only genes'],['knockout-index','Knockout indices and transcription-unit targets'],['model-state-ids','Model state identifiers'],['model-coverage','Model coverage and gene context']]
async function expectTopic(page:Page,id:string,heading:string){
  const target=page.getByRole('heading',{name:heading,exact:true})
  await expect(target).toBeFocused();await expect(target).toBeInViewport()
  await expect(target).toHaveAttribute('data-guide-key','topic:'+id)
  expect(await page.evaluate(()=>window.scrollY)).toBe(0)
}
async function browse(page:Page){
  const switcher=page.getByRole('button',{name:'Browse genes',exact:true})
  if(await switcher.isVisible())await switcher.click()
}
async function selectedGene(page:Page){
  const switcher=page.getByRole('button',{name:/^Selected gene/})
  if(await switcher.isVisible())await switcher.click()
}
async function followHelp(page:Page,label:string,method:'mouse'|'keyboard'|'touch'='mouse'){
  const trigger=page.getByRole('button',{name:'Help: '+label,exact:true})
  if(method==='keyboard'){await trigger.focus();await page.keyboard.press('Enter')}
  else if(method==='touch')await trigger.tap()
  else await trigger.hover()
  const region=page.getByRole('region',{name:label+' help',exact:true})
  const link=region.getByRole('link',{name:'Read the guide',exact:false})
  await expect(link).toBeVisible()
  if(method==='keyboard'){await page.keyboard.press('Tab');await expect(link).toBeFocused();await page.keyboard.press('Enter')}
  else if(method==='touch')await link.tap()
  else await link.click()
}

test('workspace and genome help open their exact explanations',async({page})=>{
  const bad:string[]=[]
  page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/api/')&&(!['GET','HEAD','OPTIONS'].includes(r.method())||/assistant|provider|train|debug/.test(p)))bad.push(p)})
  for(const [label,topic,title] of [['Mechanistic','mechanistic','Mechanistic genes'],['Expression-only','expression-only','Expression-only genes']]){
    await page.goto('/explore');await browse(page);await followHelp(page,label)
    await expectTopic(page,topic,title)
  }
  for(const [label,topic,title] of [['Knockout index','knockout-index','Knockout indices and transcription-unit targets'],['Model state IDs','model-state-ids','Model state identifiers']]){
    await page.goto('/explore?gene=hisG');await selectedGene(page);await followHelp(page,label)
    await expectTopic(page,topic,title)
  }
  await page.goto('/genome?gene=hisG');await followHelp(page,'Knockout index')
  await expectTopic(page,'knockout-index','Knockout indices and transcription-unit targets')
  for(const path of ['/explore','/genome']){
    await page.goto(path);await page.locator('main a.workspace-guide-link').first().click()
    await expectTopic(page,'model-coverage','Model coverage and gene context')
  }
  // The empty inspector is behind the responsive pane switch. Wait for that
  // control explicitly rather than checking isVisible before hydration ends.
  await page.setViewportSize({width:390,height:900})
  await page.goto('/explore')
  await page.getByRole('button',{name:'Selected gene',exact:true}).click()
  await page.getByRole('link',{name:'Learn how the model works',exact:true}).click()
  await expectTopic(page,'model-coverage','Model coverage and gene context')
  expect(bad).toEqual([])
})

test('Mechanistic help supports keyboard activation',async({page},info)=>{
  await page.goto('/explore');await followHelp(page,'Mechanistic','keyboard')
  await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.screenshot({path:info.outputPath('mechanistic-keyboard.png')})
})

test('Mechanistic help supports touch activation',async({browser},info)=>{
  const context=await browser.newContext({hasTouch:true,viewport:{width:390,height:844},reducedMotion:'reduce'})
  const page=await context.newPage()
  try{
    await page.goto((process.env.EXPLORER_URL||'http://127.0.0.1:5175')+'/explore')
    await expect(page.getByRole('heading',{name:'Gene workspace',exact:true})).toBeVisible()
    await browse(page);await followHelp(page,'Mechanistic','touch')
    await expectTopic(page,'mechanistic','Mechanistic genes')
    await page.screenshot({path:info.outputPath('mechanistic-touch.png')})
  }finally{await context.close()}
})

test('topic URLs normalize sections with replacement and preserve browser history',async({page})=>{
  await page.goto('/results');await expect(page.getByRole('heading',{name:'Published results',exact:true})).toBeVisible()
  await page.goto('/guide?section=results&topic=mechanistic')
  await expect(page).toHaveURL('/guide?section=overview&topic=mechanistic')
  await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.goBack();await expect(page).toHaveURL('/results')
  await page.goForward();await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.reload();await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.getByRole('navigation',{name:'Model context topics'}).getByRole('link',{name:'Expression-only genes',exact:true}).click()
  await expectTopic(page,'expression-only','Expression-only genes')
  await page.goBack();await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.goForward();await expectTopic(page,'expression-only','Expression-only genes')
  await page.getByRole('navigation',{name:'Guide sections'}).getByRole('link',{name:'Design parameters',exact:true}).click()
  await expect(page).toHaveURL('/guide?section=parameters')
  await expect(page.locator('[data-guide-target=active]')).toHaveCount(0)
  await page.goto('/guide');await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible()
  expect(await page.getByRole('region',{name:'Guide section content'}).evaluate(e=>e.scrollTop)).toBe(0)
})

test('type Documentation follows the current selection and preserves unsaved protection',async({page})=>{
  await page.goto('/experiments/new?variant=wildtype')
  const documentation=page.getByRole('link',{name:'Documentation',exact:true})
  await expect(documentation).toHaveAttribute('href','/guide?section=variants&variant=wildtype')
  await page.getByLabel('Experiment type',{exact:true}).selectOption('gene_knockout')
  await expect(documentation).toHaveAttribute('href','/guide?section=variants&variant=gene_knockout')
  await page.getByLabel('Name',{exact:true}).fill('Unsaved contextual-help plan')
  await documentation.click()
  const dialog=page.getByRole('alertdialog',{name:'Leave unsaved personal draft?',exact:true})
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button',{name:'Stay',exact:true}).click()
  await expect(page).toHaveURL(/\/experiments\/new/)
  await documentation.click();await dialog.getByRole('button',{name:'Leave without saving',exact:true}).click()
  const card=page.locator('[data-variant="gene_knockout"]')
  await expect(card).toHaveAttribute('open','')
  await expect(card.locator(':scope > summary')).toBeFocused()
  await expect(card.locator(':scope > summary')).toBeInViewport()
  await expect(card).toContainText('TU0-198747[c]')
  await page.goto('/experiments/new?variant=param_sensitivity')
  await expect(documentation).toHaveAttribute('href','/guide?section=variants&variant=param_sensitivity')
  await page.getByLabel('Name',{exact:true}).fill('Advanced contextual-help plan')
  await documentation.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button',{name:'Leave without saving',exact:true}).click()
  await expect(page.locator('[data-variant="param_sensitivity"] > summary')).toBeFocused()
})

test('a help link retains ordinary open-in-new-tab behavior',async({page,context})=>{
  await page.goto('/explore')
  await page.getByRole('button',{name:'Help: Mechanistic',exact:true}).click()
  const popup=context.waitForEvent('page')
  await page.getByRole('region',{name:'Mechanistic help',exact:true}).getByRole('link',{name:'Read the guide',exact:false}).click({button:'middle'})
  const guide=await popup
  try{await expectTopic(guide,'mechanistic','Mechanistic genes');await expect(page).toHaveURL(/\/explore/)}finally{await guide.close()}
})

test('an asynchronously loaded type is targeted only after its content is ready',async({page})=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/variants',async route=>{await gate;await route.continue()})
  try{
    await page.goto('/guide?section=variants&variant=rrna_location')
    await expect(page.getByRole('status')).toContainText('Loading published experiment types')
    await expect(page.locator('[data-variant="rrna_location"]')).not.toBeAttached()
    release()
    const card=page.locator('[data-variant="rrna_location"]')
    await expect(card.locator(':scope > summary')).toBeFocused()
    await expect(card).toHaveAttribute('open','')
  }finally{release()}
})

test('a delayed or failed type reference retains its intended target through retry',async({page})=>{
  let fail=true
  await page.route('**/api/variants',route=>fail?route.fulfill({status:503,json:{detail:'Explicit transport-failure fixture'}}):route.continue())
  await page.goto('/guide?section=overview&variant=tf_activity')
  await expect(page).toHaveURL('/guide?section=variants&variant=tf_activity')
  await expect(page.getByRole('alert')).toContainText('Published reference data could not be loaded')
  fail=false;await page.getByRole('button',{name:'Retry experiment types',exact:true}).click()
  const summary=page.locator('[data-variant="tf_activity"] > summary')
  await expect(summary).toBeFocused();await expect(summary).toBeInViewport()
  await expect(page.locator('[data-variant="tf_activity"]')).toHaveAttribute('open','')
  await page.reload();await expect(summary).toBeFocused()
})

for(const query of ['section=overview&topic=unknown_fixture','section=variants&variant=template','section=variants&variant=unknown_fixture','section=variants&variant=','section=overview&topic=mechanistic&variant=gene_knockout'])test('unavailable target is explicit: '+query,async({page})=>{
  await page.goto('/guide?'+query)
  await expect(page.getByRole('status').filter({hasText:/unavailable|Choose a single/})).toBeVisible()
  await expect(page.locator('[data-guide-target=active]')).toHaveCount(0)
  await expect(page.locator('details[data-variant][open]')).toHaveCount(0)
})

for(const width of [390,1440])for(const theme of ['light','dark'] as const)test(`context targets are accessible ${width}px ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
  for(const [id,title] of topics){
    await page.goto('/guide?topic='+id)
    await expectTopic(page,id,title)
    const heading=page.getByRole('heading',{name:title,exact:true})
    await expect(heading).toHaveAttribute('data-guide-target','active')
    await expect(heading).toHaveCSS('animation-name','none')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
  }
  await page.goto('/guide?section=variants&variant=gene_knockout')
  await expect(page.locator('[data-variant="gene_knockout"] > summary')).toBeFocused()
  await page.screenshot({path:info.outputPath('type-target.png')})
  const result=await new AxeBuilder({page}).analyze();expect(result.violations.map(v=>v.id)).toEqual([])
  await page.goto('/guide?section=overview&topic=mechanistic')
  await expectTopic(page,'mechanistic','Mechanistic genes')
  await page.screenshot({path:info.outputPath('mechanistic-target.png')})
})

test('target colour feedback ends without motion or focus being reapplied',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'})
  await page.goto('/guide?section=overview&topic=mechanistic')
  await expectTopic(page,'mechanistic','Mechanistic genes')
  const heading=page.getByRole('heading',{name:'Mechanistic genes',exact:true})
  await expect(heading).toHaveAttribute('data-guide-target','active')
  await expect(heading).not.toHaveAttribute('data-guide-target','active',{timeout:4000})
  await page.getByRole('region',{name:'Guide section content'}).focus()
  await expect(heading).not.toBeFocused()
})
