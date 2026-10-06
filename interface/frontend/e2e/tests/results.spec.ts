import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockAssistantApi } from '../mocks/assistantApi'

const experiment = { id: 101, name: 'dnaA knockout', description: 'Evidence batch', variant_type: 'gene_knockout', variant_index: 42, condition: 'basal', timeline: '0 minimal, 1800 '+ 'long_media_identifier_'.repeat(10), sim_params: '{}', status: 'done', created_at: '2026-10-05T00:00:00Z', updated_at: '', gene_symbol: 'dnaA', batch_id: 'batch-1' }
const experiments = [experiment, { ...experiment, id: 102, name: 'Wildtype', gene_symbol: '', variant_type: 'wildtype', batch_id: '', timeline: '' }, { ...experiment, id: 103, name: 'Sensitivity', gene_symbol: '', variant_type: 'param_sensitivity', timeline: '', status: 'running' }]
const statuses = ['done','failed','done','pending','claimed','waiting_parca','running_parca','running_sim','ingesting','cancelling','recovering','cancelled']
const jobs = statuses.map((status, i) => ({ id: 501+i, experiment_id: i<2?101:i===2?102:103, status, phase: status, sim_dir: '', log_tail: '', started_at: '2026-10-05T00:00:00Z', finished_at: status==='done'?'2026-10-05T01:00:00Z':'', error_message: status==='failed'?'Recorded simulation failure':'', created_at: '2026-10-05T00:00:00Z', variant_type: i<2?'gene_knockout':i===2?'wildtype':'param_sensitivity', variant_index: 42, condition: 'basal', seed: i<2?i:i-2, generations: 1, timeline: i<2?experiment.timeline:'' }))
const metric = (mean:number|null) => ({mean,std: mean===null?null:mean*.1,ci_lower:mean===null?null:mean*.9,ci_upper:mean===null?null:mean*1.1,n:2,values:mean===null?[]:[mean,mean]})
const aggregation = { experiment_id:101,experiment_name:experiment.name,variant_type:'gene_knockout',variant_index:42,condition:'basal',gene_symbol:'dnaA',total_seeds:2,completed_seeds:1,failed_seeds:1,division_rate:'1/2 divided',division_time:metric(3600),final_mass:metric(1200),growth_rate:metric(.001),doubling_time:metric(45),seeds:[{job_id:501,seed:0,status:'done',division_time_sec:3600,final_mass_fg:1200,growth_rate:.001,doubling_time_min:45},{job_id:502,seed:1,status:'failed',division_time_sec:null,final_mass_fg:null,growth_rate:null,doubling_time_min:null}] }
const batch = { batch_id:'batch-1',name:'Evidence batch '+ 'long_identifier_'.repeat(10),created_at:'2026-10-05T00:00:00Z',total:7,targets:['dnaA'],variant_types:['gene_knockout','wildtype'],conditions:['basal'],timelines:[experiment.timeline],draft:1,queued:2,running:1,done:1,failed:1,cancelled:1 }
const members = Array.from({length:30},(_,i)=>({...experiment,id:201+i,name:'Evidence '+i,status:['done','failed','draft','queued','running','cancelled'][i%6],created_at:`2026-10-${String(1+i%5).padStart(2,'0')}T00:00:00Z`}))
async function setup(page:Page,path='/results') {
 await page.route(/^https?:\/\/[^/]+\/api\//,r=>r.fulfill({json:[]}));await mockAssistantApi(page)
 await page.route('**/api/jobs',r=>r.fulfill({json:jobs}));await page.route('**/api/experiments',r=>r.fulfill({json:experiments}))
 await page.route('**/api/experiments/101/results',r=>r.fulfill({json:aggregation}))
 await page.route('**/api/experiments/102/results',r=>r.fulfill({json:{...aggregation,experiment_id:102,total_seeds:1,division_time:metric(null),final_mass:metric(null),growth_rate:metric(null),doubling_time:metric(null),seeds:[{job_id:503,seed:0,status:'done',division_time_sec:null,final_mass_fg:null,growth_rate:null,doubling_time_min:null}]}}))
 await page.route('**/api/experiments/compare?*',r=>r.fulfill({json:{experiments:[],wildtype:null,wildtype_suggestion:null,deltas:[{experiment_id:101,gene_symbol:'dnaA',division_time_pct:10,final_mass_pct:-5,growth_rate_pct:-12,doubling_time_pct:8}]}}))
 await page.route('**/api/experiments/batches',r=>r.fulfill({json:[batch]}))
 await page.route('**/api/experiments/batches/batch-1',r=>r.fulfill({json:{...batch,experiments:members}}))
 await page.goto(path);await expect(page.locator('.results-coverage')).toContainText('Completed jobs')
}

test('tabs use manual keyboard activation, query restoration and unchanged filters',async({page})=>{
 await setup(page,'/results?preserved=yes')
 const outcomes=page.getByRole('tab',{name:'Experiment outcomes',exact:true});await outcomes.focus();await page.keyboard.press('ArrowRight')
 await expect(page.getByRole('tab',{name:'Batches',exact:true})).toBeFocused();await expect(outcomes).toHaveAttribute('aria-selected','true')
 await page.keyboard.press('Enter');await expect(page).toHaveURL(/preserved=yes&view=batches/)
 await page.keyboard.press('End');await page.keyboard.press('Space');await expect(page.getByRole('tab',{name:'Job diagnostics'})).toHaveAttribute('aria-selected','true')
 await page.goBack();await expect(page.getByRole('tab',{name:'Batches',exact:true})).toHaveAttribute('aria-selected','true')
 await outcomes.click();await page.getByLabel('Search results',{exact:true}).fill('dnaA');await expect(page.locator('.results-experiment-card')).toHaveCount(1)
 await page.getByLabel('Filter by seed').selectOption('1');await expect(page.locator('.results-experiment-card')).toHaveCount(1)
 await page.getByLabel('Filter by job status').selectOption('cancelled');await expect(page.getByText('No matching experiments',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'Clear filters',exact:true}).first().click();await expect(page.locator('.results-experiment-card')).toHaveCount(3)
 await page.getByLabel('Filter by date').selectOption('custom');await page.getByLabel('Custom result date').fill('2026-10-05');await expect(page.locator('.results-experiment-card')).toHaveCount(3)
})

test('scientific metrics, intervals, deltas, seeds and original links remain available',async({page})=>{
 await setup(page)
 const card=page.locator('.results-experiment-card').filter({has:page.getByRole('heading',{name:'dnaA',exact:true})})
 await expect(card).toContainText('1/2 divided');await expect(card.locator('[title="95% CI: [54.0, 66.0], n=2"]')).toContainText('60.0')
 await expect(card.locator('[title="Growth rate: -12.0% vs wildtype"]')).toContainText('down12.0%')
 await card.getByRole('button',{name:'Show seeds'}).click();const seeds=card.getByRole('region',{name:'Seeds for dnaA'})
 await expect(seeds).toContainText('60.0 min');await expect(seeds).toContainText('1200.0 fg');await expect(seeds.getByRole('link',{name:'View',exact:true})).toHaveAttribute('href','/results/501')
 await card.getByRole('button',{name:'Hide seeds'}).click();await expect(seeds).toBeHidden()
 await expect(page.getByRole('link',{name:'Compare experiments',exact:true})).toHaveAttribute('href','/results/compare')
 await expect(page.locator('.results-experiment-card').filter({has:page.getByRole('heading',{name:'Wildtype',exact:true})})).toContainText('Division: -')
})

test('portal menus remain usable outside clipping and deletion failures preserve records',async({page})=>{
 await page.setViewportSize({width:390,height:800});await setup(page)
 const trigger=page.locator('.results-experiment-card').first().getByRole('button',{name:'More experiment actions'})
 await trigger.click();const popup=page.locator('.results-action-popup');await expect(popup.getByRole('button',{name:'Delete experiment'})).toBeFocused()
 expect(await popup.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})).toBe(true)
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(popup).toHaveCount(0)
 await trigger.click();await page.locator('.results-header').click();await expect(popup).toHaveCount(0)
 await page.route('**/api/experiments/103',r=>r.fulfill({status:503,json:{detail:'Delete unavailable'}}))
 await trigger.click();await popup.getByRole('button',{name:'Delete experiment'}).click();const dialog=page.getByRole('alertdialog',{name:'Delete experiment'})
 await dialog.getByRole('button',{name:'Delete experiment',exact:true}).click();await expect(page.getByText(/Failed to delete/)).toBeVisible();await expect(page.locator('.results-experiment-card')).toHaveCount(3)
})

test('batch controls send the same requests, table menus and failure retry stay local',async({page})=>{
 await setup(page,'/results?view=batches');const calls:{method:string;url:string;body:string|null}[]=[]
 await page.route('**/api/experiments/batches/batch-1/*',r=>{calls.push({method:r.request().method(),url:r.request().url(),body:r.request().postData()});return r.fulfill({json:{message:'Recorded action',batch_id:'batch-1'}})})
 const card=page.locator('.results-batch-card');await card.getByRole('button',{name:/Run all \(1 draft\)/}).click();await card.getByRole('button',{name:'Stop queue',exact:true}).click();await card.getByRole('button',{name:/Resume \(1\)/}).click()
 expect(calls.map(c=>[c.method,c.url.split('/').pop(),c.body])).toEqual([['POST','run',null],['POST','cancel',null],['POST','resume',null]])
 await card.getByRole('heading').getByRole('button').click();const table=card.getByRole('region',{name:/Experiments in/});await expect(table.getByRole('row')).toHaveCount(31)
 await table.getByRole('button',{name:'More experiment actions'}).last().click();await expect(page.locator('.results-action-popup')).toBeVisible();await page.keyboard.press('Escape')
 await card.getByRole('button',{name:'More batch actions'}).click();await page.locator('.results-action-popup').getByRole('button',{name:'Delete batch'}).click();await page.getByRole('alertdialog',{name:'Delete batch'}).getByRole('button',{name:'Cancel',exact:true}).click()
 await page.route('**/api/experiments/batches/batch-1/run',r=>r.fulfill({status:503,json:{detail:'Runner unavailable'}}));await card.getByRole('button',{name:/Run all \(1 draft\)/}).click();await expect(page.getByText(/Error:.*Runner unavailable/)).toBeVisible();await expect(card).toBeVisible()
})

for(const width of [390,768,1440])for(const theme of ['light','dark','system'])test(`results layout ${width} ${theme}, reduced motion and effective zoom`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme==='light'?'light':'dark',reducedMotion:'reduce'});await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme);await setup(page)
 for(const w of [width,Math.floor(width/2)]){
  await page.setViewportSize({width:w,height:1000})
  for(const name of ['Experiment outcomes','Batches','Job diagnostics']){
   await page.getByRole('tab',{name,exact:true}).click()
   if(name==='Experiment outcomes')await page.locator('.results-experiment-card').filter({has:page.getByRole('heading',{name:'dnaA',exact:true})}).getByRole('button',{name:/seeds/}).click()
   if(name==='Batches')await page.locator('.results-batch-card').getByRole('heading').getByRole('button').click()
   expect(await page.locator('.results-browser').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
   for(const select of await page.locator('.results-browser').getByRole('combobox').all())expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(36)
   expect((await new AxeBuilder({page}).include('.results-browser').analyze()).violations).toEqual([])
  }
 }
 await page.setViewportSize({width:1680,height:1000});await page.keyboard.press('ControlOrMeta+j');await expect(page.locator('.results-browser')).toBeVisible();expect(await page.locator('.results-browser').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
 await page.keyboard.press('Escape');await page.locator('main').evaluate(e=>e.scrollTop=0);const header=await page.locator('.results-header').boundingBox();await page.mouse.move(header!.x+10,header!.y+10);await page.mouse.wheel(0,600);await expect.poll(()=>page.locator('main').evaluate(e=>e.scrollTop)).toBeGreaterThan(0)
})

test('empty results retain the existing actions and scope',async({page})=>{
 await setup(page);await page.route('**/api/jobs',r=>r.fulfill({json:[]}));await page.route('**/api/experiments/batches',r=>r.fulfill({json:[]}));await page.reload()
 await expect(page.getByText('No simulation jobs yet',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Go to Experiments'})).toHaveAttribute('href','/experiments')
 await page.getByRole('tab',{name:'Batches',exact:true}).click();await expect(page.getByText('No batches yet',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'+ Create your first batch'})).toHaveAttribute('href','/experiments/batch')
})
