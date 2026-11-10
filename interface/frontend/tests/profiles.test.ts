import {test} from 'node:test'
import assert from 'node:assert/strict'
import {beginExplorerReadiness,acceptExplorerCapabilities,clearExplorerCapabilities,draftBinding,validateExplorerCapabilities} from '../src/explorer/readiness'
import {apiFetch} from '../src/api/transport'
import {persistence as local} from '../src/deployment/persistence-local'
import {persistence as explorer} from '../src/deployment/persistence-explorer'
import {deleteExperiment,deleteBatch,cancelJob,deleteJobPermanent,streamAssistantMessage} from '../src/api/client'
const fingerprint='a'.repeat(64)
const valid={schema_version:'explorer-capabilities-v1',mode:'explorer',read_only:true,execution:false,shared_persistence:false,assistant:false,training:false,browser_drafts:true,references_available:true,molecular_views:['mRNA','protein','reaction_flux','exchange_flux'],campaign_sha256:fingerprint,reference_sha256:fingerprint,model_sha256:fingerprint,source_sha256:fingerprint}
test('capabilities reject malformed, incompatible and incomplete responses',()=>{
 assert.equal(validateExplorerCapabilities(valid).mode,'explorer')
 for(const value of [null,[],{}, {...valid,read_only:'true'},{...valid,execution:true},{...valid,molecular_views:[]},{...valid,reference_sha256:'bad'},{...valid,references_available:false}])assert.throws(()=>validateExplorerCapabilities(value))
})
test('retry clears provenance and stale attempts cannot publish or clear readiness',()=>{
 const first=beginExplorerReadiness();assert.throws(draftBinding);assert.equal(acceptExplorerCapabilities(first,valid),true)
 assert.equal(draftBinding().source_sha256,fingerprint)
 const second=beginExplorerReadiness();assert.throws(draftBinding);assert.equal(acceptExplorerCapabilities(first,valid),false)
 assert.equal(acceptExplorerCapabilities(second,valid),true);clearExplorerCapabilities(first);assert.equal(draftBinding().source_sha256,fingerprint)
 clearExplorerCapabilities(second);assert.throws(draftBinding)
})
test('local persistence preserves endpoints methods and payloads',async()=>{
 if(process.env.TEST_PROFILE!=='local')return
 const previous=globalThis.fetch,calls:{url:string;init?:RequestInit}[]=[]
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response('{}')}
 try{
  await local.createBuilderDraft('condition','kept',{value:1});await local.updateBuilderDraft('condition',7,'updated',{value:2});await local.publishBuilderDraft('condition',7);await local.saveUserTimeline('timeline','0 minimal')
  assert.deepEqual(calls.map(c=>[c.url,c.init?.method]),[['/api/builder-drafts/condition','POST'],['/api/builder-drafts/condition/7','PUT'],['/api/builder-drafts/condition/7/publish','POST'],['/api/user-timelines','POST']])
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)),{name:'kept',payload:{value:1}})
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)),{name:'timeline',definition:'0 minimal'})
 }finally{globalThis.fetch=previous}
})
test('explorer transport blocks every mutation path before network access',async()=>{
 if(process.env.TEST_PROFILE!=='explorer')return
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}')}
 try{
  for(const method of ['POST','put','PATCH','DELETE'])await assert.rejects(apiFetch('/jobs',{method}))
  for(const action of [()=>deleteExperiment(1),()=>deleteBatch('one'),()=>cancelJob(1),()=>deleteJobPermanent(1),()=>streamAssistantMessage(1,{content:'blocked',context:{} as any},{})])await assert.rejects(action())
  assert.equal(calls,0);assert.deepEqual(await explorer.getUserTimelines(),[]);await assert.rejects(explorer.saveUserTimeline('x','0 minimal'));assert.equal(calls,0)
 }finally{globalThis.fetch=previous}
})
