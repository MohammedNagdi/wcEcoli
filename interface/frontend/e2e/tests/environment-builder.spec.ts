import {test,expect,type Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {mockAssistantApi} from '../mocks/assistantApi'
const catalog={media_stocks:[{name:'MIX0-57',rows:[{molecule_id:'GLC',concentration:'10.0'},{molecule_id:'WATER',concentration:'Infinity'}]}],environment_molecules:[{molecule_id:'GLC',exchange_molecule_location:'[p]',formula_weight:'180'},{molecule_id:'WATER',exchange_molecule_location:'[p]',formula_weight:'18'}],media_recipes:[{media_id:'minimal',base_media:'MIX0-57',base_media_volume:'1',added_media:'',added_media_volume:'0',ingredients:'[]',ingredients_weight:'[]',ingredients_counts:'[]',ingredients_volume:'[]'}],conditions:[{condition:'basal',nutrients:'minimal',genotype_perturbations:'{}',doubling_time:'44',active_tfs:'[]',inactive_tfs:'[]'}],tf_conditions:[{tf:'crp',active_tf:'CPLX0-226',active_nutrients:'minimal',inactive_nutrients:'minimal',active_genotype_perturbations:'{}',inactive_genotype_perturbations:'{}',tf_type:'1CS'}],timelines:[{timeline:'shift',events:'0 minimal, 1800 minimal'}]}
async function setup(page:Page,path='/environment-builder'){
 await page.route(/^https?:\/\/[^/]+\/api\//,r=>r.fulfill({json:[]}));await mockAssistantApi(page)
 await page.route('**/api/timelines',r=>r.fulfill({json:[{name:'shift',definition:'0 minimal, 1800 minimal'}]}))
 await page.route('**/api/condition-catalog',r=>r.fulfill({json:catalog}))
 await page.route('**/api/builder-drafts',r=>r.fulfill({json:{media:[],mediaRecipe:[],condition:[],tfCondition:[],timeline:[]}}))
 await page.goto(path);await expect(page.locator('#builder-section-media').getByRole('combobox')).toHaveValue('MIX0-57')
}
const sections=['media','mediaRecipe','condition','tfCondition','timeline']
test('content, existing/create modes, disclosures and section order are preserved',async({page})=>{
 await setup(page)
 await expect(page.locator('.builder-section[id]')).toHaveCount(5)
 expect(await page.locator('.builder-section[id]').evaluateAll(es=>es.map(e=>e.id))).toEqual(sections.map(s=>`builder-section-${s}`))
 await expect(page.getByText('drafts saved in backend',{exact:true})).toBeVisible()
 await page.getByText('Five-question dependency map',{exact:true}).click();await expect(page.getByText('How to read this flow',{exact:true})).toBeVisible();await page.locator('.environment-builder').evaluate(async e=>{await Promise.allSettled(e.getAnimations({subtree:true}).map(a=>a.finished))});expect((await new AxeBuilder({page}).include('.builder-dependency-grid').analyze()).violations).toEqual([])
 await page.getByText('Catalog status',{exact:true}).click();await expect(page.locator('.builder-catalog-grid')).toBeVisible()
 for(const s of sections){const section=page.locator(`#builder-section-${s}`);await section.getByRole('button',{name:'Create new',exact:true}).click();await expect(section.getByRole('button',{name:'Publish',exact:true})).toBeEnabled();await section.getByRole('button',{name:'Collapse section',exact:true}).click();await expect(section.getByRole('button',{name:'Expand section',exact:true})).toHaveAttribute('aria-expanded','false');await section.getByRole('button',{name:'Expand section',exact:true}).click()}
 await expect(page.getByText('Recommended first event',{exact:true})).toBeVisible()
})
test('draft payload, saved/dirty states, review confirmation and failures retain values',async({page})=>{
 await setup(page);const section=page.locator('#builder-section-media');await section.getByRole('button',{name:'Create new',exact:true}).click()
 const name=section.getByPlaceholder('MY_NEW_MIX',{exact:true});await name.fill('MY_TEST_MIX')
 let body:any;let publishes=0
 await page.route('**/api/builder-drafts/media',r=>{body=r.request().postDataJSON();return r.fulfill({json:{id:1,section:'media',...body,status:'draft'}})})
 await page.route('**/api/builder-drafts/media/1',r=>{body=r.request().postDataJSON();return r.fulfill({json:{id:1,section:'media',...body,status:'draft'}})})
 await page.route('**/api/builder-drafts/media/1/preview',r=>r.fulfill({json:{section:'media',draft_id:1,draft_name:'MY_TEST_MIX',warnings:['Review molecule IDs.'],changes:[{file:'condition/media/MY_TEST_MIX.tsv',action:'create',rows:['MY_CARBON_SRC\t10.0','WATER\tInfinity']}]}}))
 await page.route('**/api/builder-drafts/media/1/publish',r=>{publishes++;return r.fulfill({status:503,json:{detail:'Publish unavailable'}})})
 await section.getByRole('button',{name:'Save',exact:true}).click();await expect(section.locator('.builder-status')).toHaveText('Saved')
 expect(body.name).toBe('MY_TEST_MIX');expect(body.payload).toMatchObject({mode:'create',selected:'MIX0-57',draft_name:'MY_TEST_MIX'});expect(body.payload.rows.map((r:any)=>[r.molecule_id,r.concentration])).toEqual([['MY_CARBON_SRC','10.0'],['WATER','Infinity']])
 await name.fill('MY_TEST_MIX_EDIT');await expect(section.locator('.builder-status')).toHaveText('Unsaved changes')
 await section.getByRole('button',{name:'Publish',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Publish review'});await expect(dialog).toContainText('WATER');expect(publishes).toBe(0)
 await expect(dialog).toContainText('Review molecule IDs.');await dialog.getByRole('button',{name:'Confirm publish',exact:true}).click();await expect(dialog).toContainText('Publish unavailable');expect(publishes).toBe(1)
 await dialog.getByRole('button',{name:'Cancel',exact:true}).first().click();await expect(name).toHaveValue('MY_TEST_MIX_EDIT')
 await page.route('**/api/builder-drafts/media/1',r=>r.fulfill({status:503,json:{detail:'Save unavailable'}}));await section.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByText(/API error 503.*Save unavailable/)).toBeVisible();await expect(name).toHaveValue('MY_TEST_MIX_EDIT')
})
for(const width of [390,768,1440])for(const theme of ['light','dark','system'])test(`environment layout ${width} ${theme}, reduced motion and effective 200% zoom`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme==='light'?'light':'dark',reducedMotion:'reduce'});await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
 await setup(page,width===768?'/experiments/environment-builder':'/environment-builder')
 expect((await new AxeBuilder({page}).include('.environment-builder').analyze()).violations).toEqual([])
 for(const w of [width,Math.floor(width/2)]){await page.setViewportSize({width:w,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.locator('#builder-section-timeline').getByRole('button',{name:'Save',exact:true}).scrollIntoViewIfNeeded();await expect(page.locator('#builder-section-timeline').getByRole('button',{name:'Save',exact:true})).toBeInViewport();await page.locator('main').evaluate(e=>{e.scrollTop=0});await page.mouse.move(w-25,500);await page.mouse.wheel(0,600);await expect.poll(()=>page.locator('main').evaluate(e=>e.scrollTop)).toBeGreaterThan(0)}
})

for(const theme of ['light','dark'])test(`expanded creation controls and publish review at narrow widths ${theme}`,async({page})=>{
 await page.setViewportSize({width:390,height:1000});await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme);await setup(page)
 for(const s of sections)await page.locator(`#builder-section-${s}`).getByRole('button',{name:'Create new',exact:true}).click()
 expect((await new AxeBuilder({page}).include('.environment-builder').analyze()).violations).toEqual([])
 const timeline=page.locator('#builder-section-timeline');await timeline.getByRole('button',{name:/Load preset media protocol/}).click()
 await timeline.getByLabel('Media protocol preset').selectOption('shift');await timeline.getByRole('button',{name:'Load',exact:true}).click()
 await expect(timeline.getByLabel('Shift time (min) for minimal, event 2')).toHaveValue('30')
 await page.route('**/api/builder-drafts/media',r=>r.fulfill({json:{id:1,section:'media',...r.request().postDataJSON(),status:'draft'}}))
 await page.route('**/api/builder-drafts/media/1/preview',r=>r.fulfill({json:{section:'media',draft_id:1,draft_name:'MY_NEW_MIX',warnings:['Check concentrations and molecule IDs.'],changes:[{file:'condition/media/'+ 'long_identifier_'.repeat(10)+'.tsv',action:'create',rows:Array.from({length:50},(_,i)=>`MOLECULE_${i}\tInfinity`)}]}}))
 await page.locator('#builder-section-media').getByRole('button',{name:'Publish',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Publish review'});await expect(dialog).toBeVisible()
 expect((await new AxeBuilder({page}).include('.builder-dialog').analyze()).violations).toEqual([])
 for(const w of [390,195]){await page.setViewportSize({width:w,height:1000});const confirm=dialog.getByRole('button',{name:'Confirm publish',exact:true});await expect(confirm).toBeInViewport();expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)}
 await dialog.getByRole('button',{name:'Cancel',exact:true}).last().click()
 await page.setViewportSize({width:1680,height:1000});await page.keyboard.press('ControlOrMeta+j')
 await expect(page.locator('.builder-layout')).toHaveCSS('grid-template-columns',/^[\d.]+px$/)
 await expect(page.locator('#builder-section-media').getByPlaceholder('MY_NEW_MIX',{exact:true})).toHaveValue('MY_NEW_MIX')
})
