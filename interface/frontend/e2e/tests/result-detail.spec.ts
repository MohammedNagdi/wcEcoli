import { test, expect, type Page } from '@playwright/test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { mockAssistantApi } from '../mocks/assistantApi'

const baseline = JSON.parse(readFileSync(new URL('../fixtures/result-detail-content.json', import.meta.url), 'utf8')) as {text:string;count:number}[]
test('result detail preserves every existing JSX label, help passage, and unit', () => {
  const counts = new Map<string,number>()
  const add = (s:string) => { const text=s.replace(/\s+/g,' ').trim(); if(text)counts.set(text,(counts.get(text)||0)+1) }
  for(const file of ['ResultsPage.tsx','MoleculeExplorer.tsx']) {
    const source=ts.createSourceFile(file,readFileSync(new URL('../../src/components/results/'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    function visit(n:ts.Node) { if(ts.isJsxText(n))add(n.text); if(ts.isJsxAttribute(n)&&['text','help','label','unit','title','placeholder'].includes(n.name.getText(source))&&n.initializer&&ts.isStringLiteral(n.initializer))add(n.initializer.text); ts.forEachChild(n,visit) } visit(source)
  }
  for(const entry of baseline)expect(counts.get(entry.text)||0,entry.text).toBeGreaterThanOrEqual(entry.count)
})

async function setup(page:Page, options:{wt?:'present'|'missing'|'pending';multi?:boolean;mock?:boolean;empty?:boolean;failure?:boolean;gene?:boolean}={}) {
  await mockAssistantApi(page,{})
  const summary={job_id:16,seed:0,generation:0,division_time_sec:2529,final_mass_fg:2344.5,growth_rate:0.000247,doubling_time_min:46.7}
  const series={label:'Seed 0',unit:'fg',points:[{time:0,value:300},{time:3600,value:2344.5}]}
  const channels=['cell_mass','protein_mass','growth_rate','ppgpp_conc','dry_mass','rna_mass','dna_mass','cell_volume','small_molecule_mass']
  await page.route('**/api/jobs/16',r=>r.fulfill({json:{id:16,experiment_id:12,status:'done',phase:'Complete',sim_dir:options.mock?'':'/tmp/sim',log_tail:'',started_at:'',finished_at:'',error_message:'',created_at:'',variant_type:options.gene?'gene_knockout':'timelines',variant_index:0,condition:'glc_20mM',seed:0,generations:options.multi?2:1,timeline:'long_protocol_identifier'}}))
  await page.route('**/api/experiments/12',r=>r.fulfill({json:{id:12,name:'timelines[0] seed 0',description:'',variant_type:options.gene?'gene_knockout':'timelines',variant_index:0,condition:'glc_20mM',timeline:'0 minimal_GLC_20mM, 1800 minimal_GLC_5mM, 3600 minimal_GLC_2mM',sim_params:'{}',status:'done',created_at:'',updated_at:'',gene_symbol:options.gene?'dnaA':''}}))
  await page.route('**/api/jobs/16/timeseries',r=>options.failure?r.fulfill({status:500,json:{detail:'fixture unavailable'}}):r.fulfill({json:{summary:options.multi?[summary,{...summary,generation:1,division_time_sec:null}]:[summary],timeseries:options.empty?{}:Object.fromEntries(channels.map(ch=>[ch,options.multi?[{...series,unit:ch==='growth_rate'?'1/s':ch==='ppgpp_conc'?'uM':'fg'},{...series,label:'Seed 1',unit:ch==='growth_rate'?'1/s':ch==='ppgpp_conc'?'uM':'fg'}]:[{...series,unit:ch==='growth_rate'?'1/s':ch==='ppgpp_conc'?'uM':'fg'}]]))}}))
  await page.route('**/api/experiments/wt-delta/12',r=>r.fulfill({json:options.wt==='present'?{has_wildtype:true,wt_experiment_id:11,wt_status:'done',division_time_pct:12,final_mass_pct:-4,growth_rate_pct:-15,doubling_time_pct:7,wt_division_time_min:50,wt_final_mass_fg:2400,wt_growth_rate:0.0003,wt_doubling_time_min:40}:{has_wildtype:false,wt_experiment_id:options.wt==='pending'?11:null,wt_status:options.wt==='pending'?'running_sim':null}}))
  await page.route('**/api/jobs/16/molecules',r=>r.fulfill({json:{available_types:[{molecule_type:'protein',count:20},{molecule_type:'reaction_flux',count:10}]}}))
  await page.route('**/api/jobs/16/molecules/search?*',r=>r.fulfill({json:{results:{protein:['VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS[c]']}}}))
  await page.route('**/api/jobs/16/molecules/*/ids?*',r=>r.fulfill({json:{ids:['VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS[c]'],total:1}}))
  await page.route('**/api/jobs/16/molecules/*/timeseries?*',r=>r.fulfill({json:{molecules:[{molecule_id:'VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS[c]',molecule_type:'protein',seed:0,generation:0,unit:'count',points:series.points}]}}))
  await page.route('**/api/genes/by-ko-index/0',r=>r.fulfill({json:{symbol:'dnaA'}}))
  await page.route('**/api/jobs/16/state-explorer?*',r=>r.fulfill({json:{focus_gene:'dnaA',wt_job_id:11,variables:[{gene_symbol:'dnaA',molecule_type:'protein',display_type:'protein',id:'DNAA-MONOMER[c]',role:'focus',available:true,plottable:true,final_value:10,wt_final_value:12,delta_pct:-16.7}],edges:[]}}))
  await page.route('**/api/jobs/16/stoichiometry-neighborhood?*',r=>r.fulfill({json:{focus_gene:'dnaA',reactions:[]}}))
  await page.goto('/results/16?condition=glc_20mM&experiment=12&job=16&view=results')
  if(!options.failure)await expect(page.getByRole('heading',{name:'timelines[0] seed 0'})).toBeVisible()
}

test('summary order, scientific values, anchor links, and retained context',async({page})=>{
  await setup(page)
  await expect(page.locator('.result-summary-metric')).toHaveCount(4)
  await expect(page.locator('#phenotype')).toContainText('42.1 min')
  await expect(page.locator('#phenotype')).toContainText('2344.5 fg')
  await expect(page.locator('#phenotype')).toContainText('0.25 x10^-3 /s')
  expect(await page.locator('#phenotype').evaluate(el=>[...el.querySelectorAll('.result-metric-strip,.result-next-step,.result-run-context')].map(e=>e.className.split(' ')[0]))).toEqual(['result-metric-strip','result-next-step','result-run-context'])
  await expect(page.locator('#comparison')).toContainText('No completed condition-matched WT baseline is available for this result.')
  await page.getByRole('link',{name:'Open plots',exact:true}).click()
  await expect(page).toHaveURL(/view=results#timeseries/)
  await expect(page.locator('#timeseries canvas')).toHaveCount(4)
  expect(await page.locator('.app-shell > main').evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
  expect(await page.locator('.result-detail').evaluate(el=>getComputedStyle(el).overflowY)).toBe('visible')
})

for(const wt of ['present','pending'] as const)test(`WT ${wt} retains values and comparison link`,async({page})=>{
  await setup(page,{wt})
  await expect(page.locator('#comparison')).toContainText(wt==='present'?'WT experiment #11':'WT Running (Sim)')
  await expect(page.getByRole('link',{name:'Open comparison',exact:true})).toHaveAttribute('href',/ids=12/)
  if(wt==='present') { await expect(page.locator('#comparison')).toContainText('50.0 min'); await expect(page.locator('#comparison')).toContainText('Interpretation') }
})

test('presets, channels, model depth, molecule disclosure, and diagnostics retain state',async({page})=>{
  await setup(page,{multi:true,gene:true,wt:'present'})
  await page.getByRole('button',{name:'Biomass 6 available channels',exact:true}).click()
  await expect(page.locator('#timeseries canvas')).toHaveCount(6)
  const customize=page.getByRole('button',{name:'Customize channels',exact:true})
  await customize.click()
  await expect(page.getByRole('button',{name:'Hide channels',exact:true})).toHaveAttribute('aria-expanded','true')
  await page.getByRole('button',{name:'Cell mass',exact:true}).click()
  await expect(page.locator('#timeseries canvas')).toHaveCount(5)
  await page.getByRole('button',{name:'Hide channels',exact:true}).click()
  await page.getByRole('button',{name:'Customize channels',exact:true}).click()
  await expect(page.getByRole('button',{name:'Cell mass',exact:true})).toHaveAttribute('aria-pressed','false')
  await page.getByRole('button',{name:'Show model-depth note',exact:true}).click()
  await expect(page.locator('#result-model-depth')).toContainText('4,749')
  await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  await expect(page.getByRole('button',{name:'Collapse molecule explorer',exact:true})).toHaveAttribute('aria-expanded','true')
  await expect(page.getByRole('heading',{name:'Result state explorer'})).toBeVisible()
  await page.getByRole('button',{name:/Per-generation diagnostics/}).click()
  await expect(page.getByRole('region',{name:'Per-generation diagnostics',exact:true})).toBeVisible()
  await expect(page.locator('#result-generation-table tbody tr')).toHaveCount(2)
})

test('mock notices, empty channels, and request failure preserve explanations',async({page})=>{
  await setup(page,{mock:true,empty:true})
  await expect(page.locator('#phenotype')).toContainText('Preview or fallback data')
  await expect(page.locator('#timeseries')).toContainText('No channels are selected.')
  await setup(page,{failure:true})
  await expect(page.getByText(/Failed to load results:.*fixture unavailable/)).toBeVisible()
})

for(const width of [390,768,1440])for(const theme of ['light','dark'] as const)test(`readable ${width}px ${theme} layout, scrolling and explorer`,async({page},info)=>{
  await page.setViewportSize({width,height:1000})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.addInitScript(theme=>localStorage.setItem('wcecoli.theme',theme),theme)
  await setup(page,{multi:true})
  await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  await expect(page.locator('#result-molecule-body')).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.locator('main').evaluate(el=>{el.scrollTop=0})
  await page.screenshot({path:`/tmp/result-detail-${info.project.name}-${width}-${theme}.png`})
  await page.locator('#model-outputs').scrollIntoViewIfNeeded()
  expect(await page.locator('main').evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
  if(width===1440){await page.getByTestId('assistant-dock-toggle').click();await expect(page.getByTestId('assistant-input')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
})

test('molecule search and selection preserve request values and drafts across disclosures',async({page})=>{
  await setup(page)
  await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  const search=page.getByPlaceholder(/Search a gene/)
  await search.fill('dnaA')
  const molecule=page.getByRole('button',{name:/VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS\[c\]/}).first()
  await expect(molecule).toBeVisible()
  const request=page.waitForRequest('**/api/jobs/16/molecules/protein/timeseries?*')
  await molecule.click()
  expect((await request).url()).toContain('ids=VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS%5Bc%5D')
  await expect(page.locator('.result-selected-output')).toContainText('VERY_LONG_PROTEIN_IDENTIFIER_WITH_UNDERSCORES_AND_EXTRA_DETAILS[c]')
  await expect(page.locator('#result-molecule-body canvas')).toHaveCount(1)
  await page.getByRole('button',{name:'Collapse molecule explorer',exact:true}).click()
  await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  await expect(search).toHaveValue('dnaA')
  await expect(page.locator('#result-molecule-body canvas')).toHaveCount(1)
})

for(const theme of ['light','dark'] as const)test(`effective 200% zoom and ${theme} text contrast`,async({page},info)=>{
  await page.setViewportSize({width:720,height:600})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.addInitScript(theme=>localStorage.setItem('wcecoli.theme',theme),theme)
  await setup(page,{gene:true,wt:'present',multi:true})
  await page.getByRole('button',{name:'Expand molecule explorer',exact:true}).click()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const samples=await page.locator('.result-detail h2,.result-context-field dt,.result-context-field dd,.result-next-step p,.result-baseline-status').evaluateAll(els=>els.map(el=>{
    const style=getComputedStyle(el);let parent:Element|null=el;let bg='';while(parent){const c=getComputedStyle(parent).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){bg=c;break}parent=parent.parentElement}return {text:el.textContent,color:style.color,bg}
  }))
  const lum=(rgb:string)=>{const c=(rgb.match(/[\d.]+/g)||[]).slice(0,3).map(Number).map(v=>{const n=rgb.startsWith('color(srgb')?v:v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722}
  for(const s of samples){const a=lum(s.color),b=lum(s.bg);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05),s.text||'text').toBeGreaterThanOrEqual(4.5)}
  await page.locator('#timeseries').scrollIntoViewIfNeeded()
  await page.screenshot({path:`/tmp/result-detail-${info.project.name}-zoom-${theme}-plots.png`})
  await page.locator('#model-outputs').scrollIntoViewIfNeeded()
  await page.screenshot({path:`/tmp/result-detail-${info.project.name}-zoom-${theme}-outputs.png`})
  await page.getByRole('button',{name:/Per-generation diagnostics/}).click()
  const table=page.getByRole('region',{name:'Per-generation diagnostics',exact:true})
  await expect(table).toBeVisible()
  expect(await table.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true)
})

test('real wheel scrolling, contained wide evidence, and system theme remain usable',async({page})=>{
  await page.setViewportSize({width:768,height:700})
  await page.emulateMedia({colorScheme:'light'})
  await setup(page,{gene:true,multi:true,wt:'present'})
  await page.mouse.move(550,350)
  await page.mouse.wheel(0,500)
  await expect.poll(()=>page.locator('main').evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
  const table=page.getByRole('region',{name:'Recommended state variables',exact:true})
  await table.scrollIntoViewIfNeeded()
  expect(await table.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true)
  const box=await table.boundingBox()
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2)
  await page.mouse.wheel(500,0)
  await expect.poll(()=>table.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0)
  await page.getByRole('button',{name:'Customize channels',exact:true}).click()
  const marker=page.getByRole('button',{name:'Cell mass',exact:true}).locator('span')
  await expect(marker).toHaveCSS('background-color','rgb(83, 110, 145)')
  await page.emulateMedia({colorScheme:'dark'})
  await expect(marker).toHaveCSS('background-color','rgb(129, 156, 188)')
  await expect(page.locator('html')).toHaveClass(/dark/)
})


test('consistent reading scale and balanced Run context pairs',async({page})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page)
  await expect(page.locator('h1')).toHaveCSS('font-size','22px')
  await expect(page.locator('#phenotype h2')).toHaveCSS('font-size','16px')
  await expect(page.locator('.result-summary-metric').first().locator('p').nth(0)).toHaveCSS('font-size','13px')
  await expect(page.locator('.result-summary-metric').first().locator('p').nth(1)).toHaveCSS('font-size','18px')
  await expect(page.locator('.result-context-field dt').first()).toHaveCSS('font-size','13px')
  await expect(page.locator('.result-context-field dd').first()).toHaveCSS('font-size','13px')
  await expect(page.locator('.result-next-step p').first()).toHaveCSS('font-size','14px')
  await expect(page.locator('.result-source-notice')).toHaveCSS('font-size','13px')
  expect(await page.locator('.result-context-fields').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2)
  await expect(page.locator('.result-context-field dt').first()).toHaveCSS('text-transform','none')
})
