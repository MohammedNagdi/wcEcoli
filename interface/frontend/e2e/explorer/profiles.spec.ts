import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'

for(const failure of ['missing','malformed','incompatible'] as const)test(`profile readiness recovers from ${failure} capabilities without loading workspace early`,async({page,request})=>{
 const capabilities=await(await request.get('/api/capabilities')).json()
 let fail=true
 const other:string[]=[]
 page.on('request',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/')&&path!=='/api/capabilities')other.push(path)})
 await page.route('**/api/capabilities',route=>{
  if(!fail)return route.fulfill({json:capabilities})
  if(failure==='missing')return route.fulfill({status:503,json:{detail:'Explicit unavailable-capabilities fixture'}})
  if(failure==='malformed')return route.fulfill({body:'{invalid',contentType:'application/json'})
  return route.fulfill({json:{...capabilities,training:true}})
 })
 await page.goto('/experiments/new')
 await expect(page.getByRole('alert')).toBeVisible()
 await expect(page.getByLabel('Name',{exact:true})).toHaveCount(0)
 expect(other).toEqual([])
 fail=false;await page.getByRole('button',{name:'Retry configuration'}).click()
 await expect(page.getByLabel('Name',{exact:true})).toBeVisible()
 await expect(page.getByText('Personal browser draft.',{exact:false}).first()).toBeVisible()
})

test('pre-refactor browser drafts reopen and update without a storage migration',async({browser,baseURL})=>{
 test.skip(!process.env.LEGACY_DRAFT_STATE,'Requires captured pre-refactor browser storage')
 const legacy=JSON.parse(await readFile(process.env.LEGACY_DRAFT_STATE!,'utf8'))
 const origin=new URL(baseURL!).origin
 const state={cookies:[],origins:legacy.state.origins.filter((o:{origin:string})=>o.origin==='https://safrot-wcecoli-explorer.hf.space').map((o:object)=>({...o,origin}))}
 const context=await browser.newContext({storageState:state})
 try{
  const page=await context.newPage()
  await page.goto(origin+'/experiments/new?draft='+legacy.id)
  await expect(page.getByLabel('Name',{exact:true})).toHaveValue(legacy.name)
  await page.getByLabel('Name',{exact:true}).fill(legacy.name+' updated')
  await page.getByRole('button',{name:'Save in this browser',exact:true}).click()
  // Saving is asynchronous. Assert the durable record before intentionally
  // reloading; a click alone does not wait for an IndexedDB commit.
  await expect.poll(()=>page.evaluate(id=>new Promise<string>((resolve,reject)=>{
   const open=indexedDB.open('wcecoli-explorer-drafts-v1')
   open.onerror=()=>reject(open.error)
   open.onsuccess=()=>{
    const db=open.result,tx=db.transaction('drafts','readonly'),request=tx.objectStore('drafts').get(id)
    request.onsuccess=()=>resolve(request.result?.name||'')
    request.onerror=()=>reject(request.error)
    tx.oncomplete=tx.onabort=()=>db.close()
   }
  }),legacy.id),{timeout:15_000}).toBe(legacy.name+' updated')
  await page.reload();await expect(page.getByLabel('Name',{exact:true})).toHaveValue(legacy.name+' updated')
  expect(new URL(page.url()).searchParams.get('draft')).toBe(legacy.id)
 }finally{await context.close()}
})
