// Real publication captures only. Never opens the full platform or assistant.
import {chromium} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const url=process.env.EXPLORER_URL||'http://127.0.0.1:5175'
const dest=path.resolve('../.pilot/proofs/hf06/captures')
await mkdir(dest,{recursive:true})
const browser=await chromium.launch({headless:true})
const evidence=[]
try{
 for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1440,height:1100},colorScheme:theme,reducedMotion:'reduce'})
  await context.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
  const page=await context.newPage()
  const response=await context.request.get(url+'/api/capabilities'),cap=await response.json()
  if(cap.mode!=='explorer'||!cap.references_available||cap.execution!==false)throw new Error('Validated explorer capability gate required')
  const records=await(await context.request.get(url+'/api/experiments')).json(),wt=records.find(e=>e.name==='wt-basal')
  for(const [name,route,section] of [['results',`/results/${wt.job_id}`,'#timeseries'],['designer',`/experiments/new?duplicate=${wt.id}`,'.experiment-designer']]){
   await page.goto(url+route);await page.waitForLoadState('networkidle')
   if(name==='results')await page.locator(section).scrollIntoViewIfNeeded()
   else await page.locator('main').evaluate(el=>{el.scrollTop=0})
   const filename=name+(theme==='dark'?'-dark':'')+'.png'
   await page.screenshot({path:path.join(dest,filename)})
   evidence.push({filename,theme,route,campaign_sha256:cap.campaign_sha256,reference_sha256:cap.reference_sha256,science:'real published artifacts; no mocked curves',size:[1440,1100]})
  }
  await context.close()
 }
 await writeFile(path.join(dest,'capture.json'),JSON.stringify(evidence,null,2)+'\n')
}finally{await browser.close()}
