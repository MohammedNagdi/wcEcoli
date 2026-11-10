import {rememberReferenceName} from '../utils/referenceLabel'
export {referenceLabel} from '../utils/referenceLabel'
import {draftBinding} from './mode'
import type {BuilderDraft, BuilderDraftCollection, BuilderDraftSection, ConditionCatalog} from '../types'

export type DraftKind = 'experiment' | 'batch' | BuilderDraftSection
export type PersonalDraft = {
  id: string; kind: DraftKind; name: string; payload: Record<string, any>;
  binding: ReturnType<typeof draftBinding>; created_at: string; updated_at: string;
  applied: boolean; warnings: string[];
}
export type DraftDocument = {schema_version:'explorer-drafts-v1'; drafts:PersonalDraft[]}
const sections: BuilderDraftSection[] = ['media','mediaRecipe','condition','tfCondition','timeline']
const kinds = /* @__PURE__ */ new Set<string>(['experiment','batch',...sections])
const MAX_BYTES = 5*1024*1024

function connect(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Browser storage is unavailable. Download a copy of your design.')); return }
    const request = indexedDB.open('wcecoli-explorer-drafts-v1',1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts',{keyPath:'id'})
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Could not open browser storage. Download a copy of your design.'))
    request.onblocked = () => reject(new Error('Close other explorer tabs before upgrading browser storage.'))
  })
}
async function transaction<T>(mode:IDBTransactionMode, action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await connect()
  return new Promise((resolve,reject) => {
    const tx = db.transaction('drafts',mode)
    let result:T
    const request = action(tx.objectStore('drafts'))
    request.onsuccess = () => { result = request.result }
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Browser save failed. Your design is not saved; download a copy.')) }
  })
}
export async function allDrafts(){const records=await transaction<PersonalDraft[]>('readonly',s=>s.getAll());for(const d of records)rememberReferenceName(d.id,d.name);return records}
export async function getDraft(id:string) {
  const draft = await transaction<PersonalDraft | undefined>('readonly',s=>s.get(id))
  if (!draft) throw new Error('This personal draft is not saved in this browser')
  return draft
}
function clean(value:unknown,depth=0):void {
  if(typeof value==='number'&&!Number.isFinite(value)) throw new Error('Draft numbers must be finite')
  if (depth>32) throw new Error('Draft is nested too deeply')
  if (value && typeof value==='object') {
    for (const [key,item] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw new Error('Unsupported draft property')
      clean(item,depth+1)
    }
  }
}

function validBinding(value:any):boolean {
  return value&&typeof value==='object'&&['campaign_sha256','reference_sha256','model_sha256','source_sha256'].every(k=>typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]))
}
function validatePayload(kind:DraftKind,p:any):void {
  if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Draft payload must be an object')
  if(Object.keys(p).some(k=>['job_id','scientific_results','readiness_receipt','runtime_readiness_receipt'].includes(k)))throw new Error('Drafts cannot carry jobs, scientific results or runtime-readiness receipts')
  const stringKeys=kind==='experiment'?['name','description','variant_type','condition','timeline']:kind==='batch'?['batchName']:['mode','draft_name','events','name']
  for(const key of stringKeys)if(p[key]!==undefined&&p[key]!==null&&typeof p[key]!=='string')throw new Error('Malformed draft field: '+key)
  if(kind==='experiment'){
    for(const key of ['variant_index','seeds','generations','length_sec'])if(p[key]!==undefined&&(!Number.isFinite(p[key])||p[key]<0))throw new Error('Malformed numeric field: '+key)
    if(p.sim_params!==undefined){try{const params=JSON.parse(p.sim_params);if(!params||typeof params!=='object'||Array.isArray(params))throw new Error();clean(params)}catch{throw new Error('Malformed simulation parameter metadata')}}
    if(p.parameters!==undefined&&(!p.parameters||typeof p.parameters!=='object'||Array.isArray(p.parameters)))throw new Error('Malformed experiment parameters')
  }
  const plain=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)
  const genesValid=(value:any)=>Array.isArray(value)&&value.every(g=>plain(g)&&typeof g.symbol==='string'&&Number.isInteger(g.ko_index))
  if(kind==='experiment'){
    if(p.gene_symbols!==undefined&&(!Array.isArray(p.gene_symbols)||p.gene_symbols.some((v:any)=>typeof v!=='string')))throw new Error('Malformed gene symbols')
    if(p._targets!==undefined&&!genesValid(p._targets))throw new Error('Malformed recorded expression targets')
  }
  if(kind==='batch'&&p.recipe!==undefined){
    const r=p.recipe;if(!plain(r))throw new Error('Batch recipe must be an object')
    if(r.selectedGenes!==undefined&&!genesValid(r.selectedGenes))throw new Error('Malformed batch gene targets')
    for(const key of ['selectedIndexes','selectedTimelineIds','removedRows','batchTimelines'])if(r[key]!==undefined&&!Array.isArray(r[key]))throw new Error('Malformed batch recipe: '+key)
    if(r.batchTimelines?.some((t:any)=>!plain(t)||typeof t.definition!=='string'||typeof t.id!=='string'))throw new Error('Malformed batch timelines')
    for(const key of ['name','description','variantType','seedText','composedTimelineEvents'])if(r[key]!==undefined&&typeof r[key]!=='string')throw new Error('Malformed batch field: '+key)
  }
  if(kind==='media')for(const key of ['rows','environment_rows'])if(p[key]!==undefined&&(!Array.isArray(p[key])||p[key].some((r:any)=>!plain(r)||Object.values(r).some(v=>typeof v!=='string'))))throw new Error('Malformed media rows')
  if(kind==='tfCondition'&&p.draft!==undefined&&(!Array.isArray(p.draft)||p.draft.some((r:any)=>!plain(r)||Object.values(r).some(v=>typeof v!=='string'))))throw new Error('Malformed TF-condition rows')
  if(['condition','mediaRecipe'].includes(kind)&&p.draft!==undefined&&(!plain(p.draft)||Object.values(p.draft).some(v=>typeof v!=='string')))throw new Error('Malformed reference fields')
  if(kind==='media'&&p.rows!==undefined&&!Array.isArray(p.rows))throw new Error('Malformed media rows')
  if(kind==='tfCondition'&&p.draft!==undefined&&!Array.isArray(p.draft))throw new Error('Malformed TF-condition rows')
  if(['mediaRecipe','condition'].includes(kind)&&p.draft!==undefined&&(!p.draft||typeof p.draft!=='object'||Array.isArray(p.draft)))throw new Error('Malformed reference draft')
}

export function makeDraft(kind:DraftKind,name:string,payload:Record<string,any>,id:string=crypto.randomUUID()):PersonalDraft {
  if (!name.trim()) throw new Error('Give the draft a name')
  clean(payload)
  validatePayload(kind,payload)
  return {id,kind,name:name.trim(),payload:structuredClone(payload),binding:draftBinding(),created_at:new Date().toISOString(),
    updated_at:new Date().toISOString(),applied:false,warnings:[]}
}
export async function saveDraft(kind:DraftKind,name:string,payload:Record<string,any>,id?:string):Promise<PersonalDraft> {
  const record = makeDraft(kind,name,payload,id)
  if (id) {
    const old = await getDraft(id)
    record.created_at=old.created_at; record.applied=old.applied&&JSON.stringify(old.payload)===JSON.stringify(payload); record.warnings=old.warnings
    if(old.warnings.length)record.binding=old.binding
  }
  await transaction('readwrite',s=>s.put(record))
  window.dispatchEvent(new Event('explorer-drafts-changed'))
  return record
}
export async function removeDraft(id:string) {
  await transaction('readwrite',s=>s.delete(id))
  window.dispatchEvent(new Event('explorer-drafts-changed'))
}
export async function duplicateDraft(id:string) {
  const old=await getDraft(id)
  const copy=makeDraft(old.kind,old.name+' (copy)',old.payload);copy.binding=old.binding;copy.warnings=[...old.warnings]
  await transaction('readwrite',s=>s.add(copy));window.dispatchEvent(new Event('explorer-drafts-changed'));return copy
}
function referencesIn(value:unknown,result=new Set<string>()):Set<string> {
  if (typeof value==='string') {
    for (const match of value.matchAll(/draft:([a-f0-9-]{36})/gi)) result.add(match[1])
  } else if (value && typeof value==='object') for (const item of Object.values(value)) referencesIn(item,result)
  return result
}
export async function exportDocument(records:PersonalDraft[]):Promise<DraftDocument> {
  const all=await allDrafts().catch(()=>[])
  const chosen=new Map(records.map(d=>[d.id,d]))
  // Follow exact browser-reference UUIDs. Environment downloads explicitly pass
  // all current sections; single-design exports include only required dependencies.
  let changed=true
  while(changed) {
    changed=false
    for (const d of [...chosen.values()]) for (const id of referencesIn(d.payload)) {
      const dependency=all.find(x=>x.id===id)
      if(dependency&&!chosen.has(id)){chosen.set(id,dependency);changed=true}
    }
  }
  return {schema_version:'explorer-drafts-v1',drafts:[...chosen.values()]}
}
export async function downloadDrafts(records:PersonalDraft[]) {
  const document=await exportDocument(records)
  const blob=new Blob([JSON.stringify(document,null,2)+'\n'],{type:'application/json'})
  if(blob.size>MAX_BYTES) throw new Error('Draft download exceeds the 5 MiB import limit; export a smaller selection')
  const url=URL.createObjectURL(blob), link=window.document.createElement('a')
  link.href=url;link.download='wcecoli-explorer-drafts.json';link.click();URL.revokeObjectURL(url)
}
export async function importDocument(text:string):Promise<PersonalDraft[]> {
  if(new Blob([text]).size>MAX_BYTES) throw new Error('Draft files must be at most 5 MiB')
  let parsed:any
  try{parsed=JSON.parse(text)}catch{throw new Error('The file is not valid JSON')}
  clean(parsed)
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.schema_version!=='explorer-drafts-v1'||!Array.isArray(parsed.drafts)||!parsed.drafts.length||parsed.drafts.length>1000) throw new Error('Unsupported or empty explorer draft document')
  const mapping=new Map<string,string>()
  for(const d of parsed.drafts){
    if(typeof d.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(d.id)||mapping.has(d.id)||!kinds.has(d.kind)||typeof d.name!=='string'||!d.name.trim()||!d.payload||typeof d.payload!=='object'||Array.isArray(d.payload)||!validBinding(d.binding)) throw new Error('Malformed draft record')
    validatePayload(d.kind,d.payload)
    mapping.set(d.id,crypto.randomUUID())
  }
  const binding=draftBinding()
  const fetchReference=(path:string)=>fetch('/api'+path).then(r=>{if(!r.ok)throw new Error('Reference catalog unavailable; import was not saved');return r.json()})
  const [catalog,genes,variants]:[ConditionCatalog,any,any[]]=await Promise.all([fetchReference('/condition-catalog'),fetchReference('/genes?page_size=5000'),fetchReference('/variants')])
  const geneIndex=new Map<string,number>(genes.genes.map((g:any)=>[g.symbol,g.ko_index]))
  const variantNames=new Set(variants.map(v=>v.name))
  const knownNames=new Set([...catalog.conditions.map(r=>r.condition),...catalog.media_recipes.map(r=>r.media_id),...catalog.media_stocks.map(r=>r.name),...catalog.timelines.map(r=>r.timeline)])
  const remap=(value:any):any=>typeof value==='string'?value.replace(/draft:([a-f0-9-]{36})/gi,(original,id)=>mapping.has(id)?'draft:'+mapping.get(id):original):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)])):value
  const records:PersonalDraft[]=parsed.drafts.map((d:any)=>{
    const payload=remap(d.payload), warnings:string[]=[]
    if(Object.keys(binding).some(key=>d.binding[key]!==binding[key as keyof typeof binding])) warnings.push('Reference revision differs. Review names, indices and dependencies before using this plan; nothing was retargeted.')
    if([...referencesIn(d.payload)].some(id=>!mapping.has(id))) warnings.push('Some draft dependencies are missing and need review.')
    const requested= d.kind==='batch'?payload.recipe?.selectedGenes||[]:payload.gene_symbols?.length?payload.gene_symbols.map((symbol:string)=>({symbol})):payload.gene_symbol?[{symbol:payload.gene_symbol}]:[]
    if(requested.some((g:any)=>!geneIndex.has(g.symbol)||g.ko_index!==undefined&&geneIndex.get(g.symbol)!==g.ko_index)||(d.kind==='experiment'&&payload.variant_type==='gene_knockout'&&requested.length===1&&geneIndex.get(requested[0].symbol)!==payload.variant_index))warnings.push('Unresolved or changed gene/expression-index references need review; indices were not retargeted.')
    const variant=d.kind==='batch'?payload.recipe?.variantType:payload.variant_type
    if(variant&&!variantNames.has(variant))warnings.push('Variant is not present in this reference catalog; review the retained plan.')
    const values:string[]=[]
    if(d.kind==='experiment'){if(payload.condition)values.push(payload.condition);if(payload.timeline)values.push(...String(payload.timeline).split(',').map(s=>s.trim().replace(/^\S+\s+/,'')))}
    if(d.kind==='condition'&&payload.draft?.nutrients)values.push(payload.draft.nutrients)
    if(d.kind==='mediaRecipe')values.push(...[payload.draft?.base_media,payload.draft?.added_media].filter(Boolean))
    if(d.kind==='timeline')values.push(...String(payload.events||'').split(',').filter(Boolean).map(s=>s.trim().replace(/^\S+\s+/,'')))
    if(values.some(v=>!knownNames.has(v)&&!v.startsWith('draft:')))warnings.push('Unresolved catalog references need review; original identifiers were retained.')
    return {kind:d.kind,name:d.name.trim(),binding:d.binding,id:mapping.get(d.id),payload,applied:false,warnings,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}
  })
  const db=await connect()
  await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts')
    for(const d of records) store.add(d)
    tx.oncomplete=()=>{db.close();resolve()};tx.onerror=tx.onabort=()=>{db.close();reject(new Error('Import failed; no drafts were added'))}
  })
  window.dispatchEvent(new Event('explorer-drafts-changed'))
  return records
}
export function builderRecord(d:PersonalDraft):BuilderDraft {
  return {id:d.id,section:d.kind as BuilderDraftSection,name:d.name,payload:d.payload,status:d.applied?'applied':'draft',
    created_at:d.created_at,updated_at:d.updated_at,published_at:'',published_name:d.applied?'draft:'+d.id:''}
}
export async function builderDrafts():Promise<BuilderDraftCollection> {
  const all=await allDrafts()
  return Object.fromEntries(sections.map(section=>[section,all.filter(d=>d.kind===section).map(builderRecord)])) as unknown as BuilderDraftCollection
}
export async function applyDraft(id:string,catalog:ConditionCatalog) {
  const d=await getDraft(id)
  if(d.payload.mode!=='create') throw new Error('Published references are immutable. Create a personal overlay to apply changes.')
  if(d.kind==='media'&&(!Array.isArray(d.payload.rows)||!d.payload.rows.length||d.payload.rows.some((r:any)=>!r.molecule_id||r.concentration===''||(r.concentration!=='Infinity'&&!Number.isFinite(Number(r.concentration)))||Number(r.concentration)<0))) throw new Error('Media rows need molecule identifiers and nonnegative numeric concentrations')
  if(d.kind==='timeline') {
    const rows=String(d.payload.events||'').split(',').map(s=>s.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+(.+)$/))
    if(!rows.length||rows.some(r=>!r)||Number(rows[0]?.[1])!==0||rows.some((r,i)=>i>0&&Number(r?.[1])<=Number(rows[i-1]?.[1]))) throw new Error('A timeline must start at zero and have strictly increasing elapsed-lineage times')
  }
  if(d.warnings.length)throw new Error('This imported draft needs review. Create a new overlay using the current reference catalog before applying it.')
  const stockNames=new Set(catalog.media_stocks.map(r=>r.name)), recipeNames=new Set(catalog.media_recipes.map(r=>r.media_id))
  if(d.kind==='mediaRecipe'){
    const r=d.payload.draft
    if(!r?.media_id||!stockNames.has(r.base_media)||r.added_media&&!stockNames.has(r.added_media))throw new Error('Recipe needs a name and known base/added media stocks')
    for(const key of ['base_media_volume','added_media_volume'])if(r[key]!==''&&(!Number.isFinite(Number(r[key]))||Number(r[key])<0))throw new Error('Recipe volumes must be nonnegative numeric values')
    for(const key of ['ingredients','ingredients_weight','ingredients_counts','ingredients_volume']){
      let value:any
      try{value=JSON.parse(String(r[key]||'[]').replace(/\bInfinity\b/g,'1e999'))}catch{throw new Error('Recipe '+key+' must be an array')}
      if(!Array.isArray(value))throw new Error('Recipe '+key+' must be an array')
    }
  }
  if(d.kind==='condition'){
    const r=d.payload.draft
    if(!r?.condition||!recipeNames.has(r.nutrients)||!(Number(r.doubling_time)>0)||!Number.isFinite(Number(r.doubling_time)))throw new Error('Condition needs a name, known nutrient recipe and positive doubling time in minutes')
    for(const key of ['genotype_perturbations','active_tfs','inactive_tfs'])try{JSON.parse(String(r[key]))}catch{throw new Error('Condition '+key+' must be valid JSON')}
  }
  if(d.kind==='tfCondition'&&(!d.payload.draft?.length||d.payload.draft.some((r:any)=>!catalog.tf_conditions.some(t=>t.tf===r.tf)||!catalog.tf_conditions.some(t=>t.active_tf===r.active_tf)||!['0CS','1CS','2CS'].includes(r.tf_type)||!recipeNames.has(r.active_nutrients)||!recipeNames.has(r.inactive_nutrients))))throw new Error('TF rules need identifiers and known active/inactive nutrient recipes')
  if(d.kind==='timeline'&&String(d.payload.events).split(',').some(s=>!recipeNames.has(s.trim().replace(/^\S+\s+/,''))))throw new Error('Timeline references an unknown nutrient recipe')
  d.applied=true;d.updated_at=new Date().toISOString()
  await transaction('readwrite',s=>s.put(d));window.dispatchEvent(new Event('explorer-drafts-changed'));return builderRecord(d)
}
export async function overlayCatalog(base:ConditionCatalog):Promise<ConditionCatalog> {
  const result=structuredClone(base)
  const drafts=await allDrafts().catch(()=>[])
  const applied=drafts.filter(d=>d.applied&&sections.includes(d.kind as BuilderDraftSection))
  const publishedNames=new Set([...base.media_stocks.map(s=>s.name),...base.media_recipes.map(r=>r.media_id),...base.conditions.map(c=>c.condition),...base.timelines.map(t=>t.timeline)])
  const refFor=(value:string)=>{
    if(publishedNames.has(value)||value?.startsWith('draft:'))return value
    const matches=applied.filter(d=>[d.name,d.payload.draft_name,d.payload.name,d.payload.draft?.media_id,d.payload.draft?.condition].includes(value))
    return matches.length===1?'draft:'+matches[0].id:value
  }
  for(const d of applied) {
    if(!d.applied||!sections.includes(d.kind as BuilderDraftSection))continue
    const p=d.payload,ref='draft:'+d.id
    // Payloads are generated by the existing section forms; references use a
    // separate namespace, so a personal name never shadows a published name.
    if(d.kind==='media') {result.media_stocks.push({name:ref,rows:p.rows||[]});result.environment_molecules.push(...(p.environment_rows||[]))}
    if(d.kind==='mediaRecipe') result.media_recipes.push({...p.draft,media_id:ref,base_media:refFor(p.draft?.base_media||''),added_media:refFor(p.draft?.added_media||'')} as any)
    if(d.kind==='condition') result.conditions.push({...p.draft,condition:ref,nutrients:refFor(p.draft?.nutrients||'')} as any)
    if(d.kind==='tfCondition') result.tf_conditions.push(...(p.draft||[]).map((r:any)=>({...r,active_nutrients:refFor(r.active_nutrients),inactive_nutrients:refFor(r.inactive_nutrients)})))
    if(d.kind==='timeline') result.timelines.push({timeline:ref,events:String(p.events||p.definition||'').split(',').map(row=>row.trim().replace(/^(\S+)\s+(.+)$/,(_m,time,name)=>time+' '+refFor(name))).join(', ')})
  }
  return result
}
