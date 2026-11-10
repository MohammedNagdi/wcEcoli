import {test,expect} from '@playwright/test'
import {readFile,writeFile} from 'node:fs/promises'

test.beforeEach(async({page})=>{page.on('dialog',dialog=>dialog.accept())})

test('full public pages read real artifacts without assistant or mutations',async({page,request},info)=>{
  const failures:string[]=[],errors:string[]=[],forbidden:string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&(!['GET','HEAD','OPTIONS'].includes(r.method())||/assistant|provider|train/.test(r.url())))forbidden.push(r.method()+' '+r.url())})
  page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&r.status()>=400)failures.push(r.status()+' '+r.url())})
  const cap=await(await request.get('/api/capabilities')).json();expect(cap).toMatchObject({mode:'explorer',references_available:true,execution:false})
  const exps=await(await request.get('/api/experiments')).json();expect(exps).toHaveLength(12)
  const wt=exps.find((e:any)=>e.name==='wt-basal')
  for(const path of ['/','/explore?gene=hisG','/genes','/genome','/network','/pathways','/design','/guide','/experiments','/results',`/results/${wt.job_id}`,'/results/compare','/experiments/new','/experiments/batch','/environment-builder','/assistant','/ml']){
    await page.goto(path);await page.waitForLoadState('networkidle');
    await expect(page.locator('main').first()).toBeVisible()
    expect(await page.locator('body').innerText()).not.toContain('Unexpected Application Error')
    if(path.startsWith('/results/')&&path!== '/results/compare')await expect(page.locator('canvas').first()).toBeVisible()
    await page.screenshot({path:info.outputPath(path.replace(/[^a-z0-9]/gi,'_')+'.png'),fullPage:true})
  }
  expect(errors).toEqual([]);expect(forbidden).toEqual([]);expect(failures).toEqual([])
  await writeFile(info.outputPath('page-evidence.json'),JSON.stringify({pages:17,errors,forbidden,failures,cap},null,2))
})

test('personal single and batch drafts survive reload and transfer as copies',async({page,browser},info)=>{
  await page.goto('/experiments/new');await page.getByLabel('Name',{exact:true}).fill('My basal question')
  await page.getByRole('button',{name:'Save in this browser',exact:true}).click()
  await expect(page).toHaveURL(/draft=[a-f0-9-]{36}/)
  const original=page.url();await page.reload();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('My basal question')
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download current draft'}).click();const file=await download
  const json=JSON.parse(await readFile((await file.path())!,'utf8'));expect(json.schema_version).toBe('explorer-drafts-v1')
  expect(json.drafts[0].kind).toBe('experiment')
  await page.goto('/experiments');await page.getByRole('button',{name:/^My drafts/}).click();await expect(page.getByText('My basal question',{exact:true})).toBeVisible()
  await page.getByLabel('Draft JSON file').setInputFiles({name:'drafts.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(json))})
  await expect(page.getByText('My basal question',{exact:true})).toHaveCount(2)
  const isolated=await browser.newContext();const other=await isolated.newPage();await other.goto(new URL('/experiments',original).toString());await other.getByRole('button',{name:/^My drafts/}).click();await expect(other.getByText('My basal question',{exact:true})).toHaveCount(0);await isolated.close()
  await page.goto('/experiments/batch');await page.getByLabel('Batch name',{exact:true}).fill('My batch recipe');await page.getByRole('button',{name:'Save in this browser',exact:true}).click();await expect(page).toHaveURL(/draft=/);await page.reload();await expect(page.getByLabel('Batch name',{exact:true})).toHaveValue('My batch recipe')
  await page.screenshot({path:info.outputPath('personal-batch.png'),fullPage:true})
})

test('design-from-result preserves the actual configuration and has an unsaved guard',async({page,request})=>{
  const exps=await(await request.get('/api/experiments')).json(),exp=exps.find((e:any)=>e.name==='wt-add-aa')
  await page.goto(`/results/${exp.job_id}`);await page.getByRole('link',{name:'Design from this experiment',exact:true}).click()
  await expect(page.getByLabel('Name',{exact:true})).toHaveValue(/wt-add-aa/)
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download current draft'}).click();const draft=JSON.parse(await readFile((await(await downloaded).path())!,'utf8'));expect(draft.drafts[0].payload.timeline).toContain('1200')
  await page.getByLabel('Name',{exact:true}).fill('My shift')
  await page.getByRole('link',{name:'Results',exact:true}).first().click();await expect(page.getByRole('alertdialog',{name:'Leave unsaved personal draft?'})).toBeVisible();await page.getByRole('button',{name:'Stay',exact:true}).click()
  await page.getByRole('button',{name:'Save in this browser',exact:true}).click();await expect(page).toHaveURL(/draft=/)
})

test('environment sections apply only browser overlays and transfer dependencies',async({page},info)=>{
  const writes:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&r.method()!=='GET')writes.push(r.url())})
  await page.goto('/environment-builder')
  const stock=page.locator('#builder-section-media');await stock.getByRole('button',{name:'Create new',exact:true}).click();await stock.getByPlaceholder('MY_NEW_MIX',{exact:true}).fill('MY_BROWSER_STOCK')
  await stock.getByRole('button',{name:'Save in this browser',exact:true}).click();await expect(stock.locator('.builder-status')).toHaveText('Saved')
  await stock.getByRole('button',{name:'Use in my drafts',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Personal overlay review'});await dialog.getByRole('button',{name:'Use in my drafts',exact:true}).click();await expect(dialog).not.toBeVisible()
  const stockId=await stock.getByRole('combobox').inputValue();expect(stockId).toMatch(/^draft:/)
  const recipe=page.locator('#builder-section-mediaRecipe');await recipe.getByRole('button',{name:'Create new',exact:true}).click();await recipe.locator('select').first().selectOption(stockId)
  await recipe.getByRole('button',{name:'Use in my drafts',exact:true}).click();await dialog.getByRole('button',{name:'Use in my drafts',exact:true}).click();await expect(dialog).not.toBeVisible()
  const recipeId=await recipe.getByRole('combobox').inputValue();expect(recipeId).toMatch(/^draft:/)
  const tf=page.locator('#builder-section-tfCondition');await tf.getByRole('button',{name:'Create new',exact:true}).click();await tf.getByLabel(/Active nutrient recipe/).selectOption(recipeId)
  await tf.getByRole('button',{name:'Use in my drafts',exact:true}).click();await dialog.getByRole('button',{name:'Use in my drafts',exact:true}).click();await expect(dialog).not.toBeVisible()
  for(const sectionName of ['condition','timeline']){
    const section=page.locator('#builder-section-'+sectionName);await section.getByRole('button',{name:'Create new',exact:true}).click();await section.getByRole('button',{name:'Use in my drafts',exact:true}).click();await dialog.getByRole('button',{name:'Use in my drafts',exact:true}).click();await expect(dialog).not.toBeVisible()
  }
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download current environment drafts'}).click();const file=await download;const document=JSON.parse(await readFile((await file.path())!,'utf8'))
  expect(document.drafts.some((d:any)=>d.kind==='mediaRecipe'&&d.payload.draft.base_media===stockId)).toBe(true)
  await page.reload();await expect(stock.getByRole('combobox')).toHaveValue(stockId);await expect(tf.locator('input[type=checkbox]:checked')).toHaveCount(1)
  await page.goto('/experiments?view=drafts');await page.getByLabel('Draft JSON file').setInputFiles({name:'env.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))})
  await expect(page.getByRole('status')).toContainText('Imported')
  const allDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download all drafts'}).click();const all=JSON.parse(await readFile((await(await allDownload).path())!,'utf8'))
  const imported=all.drafts.filter((d:any)=>!document.drafts.some((o:any)=>o.id===d.id));expect(imported.length).toBe(document.drafts.length)
  const newStock=imported.find((d:any)=>d.kind==='media');const newRecipe=imported.find((d:any)=>d.kind==='mediaRecipe');expect(newRecipe.payload.draft.base_media).toBe('draft:'+newStock.id)
  expect(writes).toEqual([]);await writeFile(info.outputPath('environment-transfer.json'),JSON.stringify({passed:true,original_ids:document.drafts.map((d:any)=>d.id),imported_ids:imported.map((d:any)=>d.id),writes},null,2))
})

test('imports reject bad files atomically and retain stale reference warnings',async({page,request})=>{
  const cap=await(await request.get('/api/capabilities')).json()
  const binding={campaign_sha256:cap.campaign_sha256,reference_sha256:cap.reference_sha256,model_sha256:cap.model_sha256,source_sha256:cap.source_sha256}
  const draft={id:crypto.randomUUID(),kind:'experiment',name:'Review imported plan',payload:{condition:'unresolved_custom'},binding:{...binding,reference_sha256:'a'.repeat(64)}}
  await page.goto('/experiments?view=drafts');const file=page.getByLabel('Draft JSON file')
  for(const contents of ['{broken',JSON.stringify({schema_version:'unsupported',drafts:[draft]}),JSON.stringify({schema_version:'explorer-drafts-v1',drafts:[draft,{...draft,id:crypto.randomUUID(),payload:[]}]})]){
    await file.setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(contents)});await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('Review imported plan',{exact:true})).toHaveCount(0)
  }
  await file.setInputFiles({name:'large.json',mimeType:'application/json',buffer:Buffer.alloc(5*1024*1024+1,32)});await expect(page.getByRole('alert')).toContainText('5 MiB');await expect(page.getByRole('alert')).toBeFocused()
  await file.setInputFiles({name:'stale.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schema_version:'explorer-drafts-v1',drafts:[draft]}))});await expect(page.getByText(/Reference revision differs/)).toBeVisible();await expect(page.getByText(/Unresolved catalog references/)).toBeVisible()
})

test('failed browser storage never claims save; downloading current design works',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new Error('Storage denied for test')}}))
  await page.goto('/experiments/new');await page.getByLabel('Name',{exact:true}).fill('Download despite storage failure');await page.getByRole('button',{name:'Save in this browser',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Storage denied')
  const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download current draft'}).click();const doc=JSON.parse(await readFile((await(await event).path())!,'utf8'));expect(doc.drafts[0].name).toBe('Download despite storage failure');await expect(page.getByText('Saved in this browser',{exact:true})).toHaveCount(0)
})

test('all four real molecular families, controls and missing generation remain honest',async({page,request},info)=>{
  const records=await(await request.get('/api/experiments')).json(),his=records.find((e:any)=>e.name==='hisG-basal')
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`/results/${his.job_id}`);await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  for(const [family,label] of [['mRNA','mRNAs'],['protein','Proteins'],['reaction_flux','Reaction fluxes'],['exchange_flux','Exchange fluxes']]){
    await page.locator('#result-molecule-body').getByRole('button',{name:new RegExp('^'+label+' ')}).click()
    const choice=page.locator('#result-molecule-body .result-output-browse button[aria-pressed]').first();await expect(choice).toBeVisible()
    const response=page.waitForResponse(r=>r.url().includes(`/molecules/${family}/timeseries`)&&r.status()===200);await choice.click();expect((await(await response).json()).molecules.length).toBeGreaterThan(0)
    await expect(page.locator('#result-molecule-body canvas').first()).toBeVisible()
  }
  for(const key of ['wt-add-aa','wt-cut-aa']){
    const experiment=records.find((e:any)=>e.name===key);await page.goto(`/results/${experiment.job_id}`);await expect(page.getByText(/^Initial environment reference:/)).toBeVisible();await expect(page.getByText(/^Endpoint environment reference:/)).toBeVisible()
  }
  await page.goto(`/results/compare?ids=${his.id}`);await page.getByLabel('Comparison generation').selectOption('3');await expect(page.getByText('No saved generation 3',{exact:false})).toBeVisible()
  expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('honest-missing-generation.png'),fullPage:true})
})

test('capability mismatch fails before loading the explorer workspace',async({page,request})=>{
  const capabilities=await(await request.get('/api/capabilities')).json(),other:string[]=[]
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!r.url().includes('/capabilities'))other.push(r.url())})
  // Only the capability error is simulated; scientific APIs are never replaced.
  await page.route('**/api/capabilities',r=>r.fulfill({json:{...capabilities,mode:'local',execution:true}}))
  await page.goto('/experiments/new');await expect(page.getByRole('alert')).toContainText('configuration mismatch');expect(other).toEqual([]);await expect(page.getByLabel('Name',{exact:true})).toHaveCount(0)
})

test('large batch previews are bounded while the complete recipe remains portable',async({page})=>{
  await page.goto('/experiments/batch');await page.getByLabel('Experiment type',{exact:true}).selectOption('wildtype');await page.getByLabel('Batch name',{exact:true}).fill('Large planned batch')
  await page.getByLabel('Seeds',{exact:true}).fill(Array.from({length:1200},(_,i)=>i).join(','))
  await expect(page.getByText(/Showing at most 1,000 preview rows/)).toBeVisible()
  expect(await page.getByRole('region',{name:'Preview records',exact:true}).locator('tbody tr').count()).toBeLessThanOrEqual(1000)
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download current draft'}).click();const document=JSON.parse(await readFile((await(await download).path())!,'utf8'));expect(document.drafts[0].payload.planned_count).toBe(1200);expect(document.drafts[0].payload.recipe.seedText.split(',')).toHaveLength(1200)
})

test('rename, duplicate, selected export and delete stay personal',async({page})=>{
  await page.goto('/experiments/new');await page.getByLabel('Name',{exact:true}).fill('Personal CRUD question');await page.getByRole('button',{name:'Save in this browser',exact:true}).click();await expect(page).toHaveURL(/draft=/)
  await page.goto('/experiments?view=drafts');const row=page.getByRole('row').filter({has:page.getByRole('link',{name:'Personal CRUD question',exact:true})})
  await row.getByRole('button',{name:'Rename',exact:true}).click();const rename=page.getByRole('alertdialog',{name:'Rename personal draft'});await rename.getByLabel('Draft name').fill('Renamed personal question');await rename.getByRole('button',{name:'Save name',exact:true}).click();await expect(rename).not.toBeVisible()
  const renamed=page.getByRole('row').filter({has:page.getByRole('link',{name:'Renamed personal question',exact:true})});await renamed.getByRole('button',{name:'Duplicate',exact:true}).click();await expect(page.getByRole('link',{name:'Renamed personal question (copy)',exact:true})).toBeVisible()
  await renamed.getByRole('checkbox').check();const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download selected drafts'}).click();const doc=JSON.parse(await readFile((await(await downloaded).path())!,'utf8'));expect(doc.drafts.map((d:any)=>d.name)).toEqual(['Renamed personal question'])
  await renamed.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('alertdialog',{name:'Delete personal draft?'}).getByRole('button',{name:'Delete draft',exact:true}).click();await expect(page.getByRole('link',{name:'Renamed personal question',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Renamed personal question (copy)',exact:true})).toBeVisible()
})
