import {test,expect,type Page} from '@playwright/test'
import {randomUUID} from 'node:crypto'
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

async function seedV1Draft(page:Page,origin:string,id:string,name:string){
 // Seed the public v1 IndexedDB schema independently of the application writer.
 const url=origin+'/__test/draft-fixture'
 await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Draft fixture</title>'}))
 await page.goto(url)
 await page.evaluate(({id,name})=>new Promise<void>((resolve,reject)=>{
  const open=indexedDB.open('wcecoli-explorer-drafts-v1',1)
  open.onupgradeneeded=()=>open.result.createObjectStore('drafts',{keyPath:'id'})
  open.onerror=()=>reject(open.error)
  open.onsuccess=()=>{
   const db=open.result,tx=db.transaction('drafts','readwrite')
   const stamp='2000-01-01T00:00:00.000Z',fingerprint='0'.repeat(64)
   tx.objectStore('drafts').add({
    id,kind:'experiment',name,payload:{
     name,description:'Synthetic compatibility fixture',variant_type:'wildtype',variant_index:0,
     condition:'basal',timeline:'',gene_symbol:'',gene_symbols:[],_targets:[],
    },
    binding:{campaign_sha256:fingerprint,reference_sha256:fingerprint,model_sha256:fingerprint,source_sha256:fingerprint},
    created_at:stamp,updated_at:stamp,applied:false,warnings:[],
   })
   tx.oncomplete=()=>{db.close();resolve()}
   tx.onabort=()=>{db.close();reject(tx.error)}
  }
 }),{id,name})
}

test('pre-refactor browser drafts reopen and update without a storage migration',async({browser,baseURL})=>{
 const fixture=process.env.LEGACY_DRAFT_STATE
 const legacy=fixture?JSON.parse(await readFile(fixture,'utf8')):undefined
 const id:string=legacy?.id??randomUUID()
 const name:string=legacy?.name??'Synthetic v1 explorer draft'
 const origin=new URL(baseURL!).origin
 const state=legacy?{cookies:[],origins:legacy.state.origins.filter((o:{origin:string})=>o.origin==='https://safrot-wcecoli-explorer.hf.space').map((o:object)=>({...o,origin}))}:undefined
 const context=await browser.newContext({storageState:state})
 try{
  const page=await context.newPage()
  if(!legacy)await seedV1Draft(page,origin,id,name)
  await page.goto(origin+'/experiments/new?draft='+id)
  await expect(page.getByLabel('Name',{exact:true})).toHaveValue(name)
  await page.getByLabel('Name',{exact:true}).fill(name+' updated')
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
  }),id),{timeout:15_000}).toBe(name+' updated')
  await page.reload();await expect(page.getByLabel('Name',{exact:true})).toHaveValue(name+' updated')
  expect(new URL(page.url()).searchParams.get('draft')).toBe(id)
 }finally{await context.close()}
})
