import {useEffect,useMemo,useState} from 'react'
import {getConditionCatalog,getGene,getVariantDetail} from '../api/client'
import type {ConditionCatalog} from '../types'

/** Catalog checks inform planning only; they never grant an execution receipt. */
export function CatalogChecks({payload}:{payload:Record<string,any>}){
  const [catalog,setCatalog]=useState<ConditionCatalog|null>(null),[hints,setHints]=useState<any>(null),[targets,setTargets]=useState<any[]>([]),[error,setError]=useState('')
  const genes=(payload.gene_symbols?.length?payload.gene_symbols:String(payload.gene_symbol||'').split(',')).filter(Boolean)
  useEffect(()=>{void getConditionCatalog().then(setCatalog).catch(e=>setError(e.message))},[])
  useEffect(()=>{setHints(null);if(payload.variant_type)void getVariantDetail(payload.variant_type).then(setHints).catch(e=>setError(e.message))},[payload.variant_type])
  useEffect(()=>{let alive=true;setTargets([]);void Promise.all(genes.map((g:string)=>getGene(g))).then(rows=>{if(alive)setTargets(rows)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[genes.join(',')])
  const warnings=useMemo(()=>{
    if(!catalog)return []
    const messages:string[]=[],params=JSON.parse(payload.sim_params||'{}')
    if(!payload.variant_type)messages.push('Choose a model variant.')
    if(!catalog.conditions.some(c=>c.condition===payload.condition))messages.push('Choose a known condition, or apply a personal condition overlay first.')
    if(!Number.isInteger(payload.variant_index)||payload.variant_index<0)messages.push('A variant needs a nonnegative integer index.')
    const range=hints?.parameter_hints?.index_range
    if(range&&(payload.variant_index<range[0]||payload.variant_index>range[1]))messages.push('Variant index is outside the documented catalog range.')
    for(const key of ['seeds','generations','length_sec'])if(!Number.isFinite(params[key])||params[key]<=0||!Number.isInteger(params[key]))messages.push(key+' must be a positive integer (length is in seconds).')
    const events=String(payload.timeline||'').split(',').map(r=>r.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/))
    if(!events.length||events.some(r=>!r)||Number(events[0]?.[1])!==0||events.some((r,i)=>i>0&&Number(r?.[1])<=Number(events[i-1]?.[1])))messages.push('Timeline must start at 0 and strictly increase in elapsed lineage seconds.')
    if(events.some(r=>r&&!catalog.media_recipes.some(m=>m.media_id===r[2])))messages.push('Timeline references an unresolved nutrient recipe.')
    if(payload.variant_type.includes('gene_knockout')&&!genes.length)messages.push('Select the requested gene symbols so transcription-unit targets can be reviewed.')
    for(const target of targets)if(!target.expression_target||target.ko_index<1)messages.push(target.symbol+': prepared expression target is unavailable.')
    if(payload.variant_type==='gene_knockout'&&targets.length===1&&targets[0].ko_index!==payload.variant_index)messages.push('The recorded gene and expression index differ. Review them; the explorer has not retargeted this plan.')
    return messages
  },[catalog,payload,hints,targets])
  return <section className="rounded-lg border p-3 mb-4 text-sm" aria-label="Catalog checks"><strong>Catalog checks</strong><p>{error?'Reference check unavailable: '+error:!catalog?'Loading reference definitions…':warnings.length?`${warnings.length} planning item(s) need review. Incomplete drafts may still be saved.`:'Required fields and catalog references checked. Runtime readiness remains unverified.'}</p>{warnings.length>0&&<ul className="list-disc ml-5 mt-2">{warnings.map(w=><li key={w}>{w}</li>)}</ul>}{targets.map(t=><p className="mt-2" key={t.symbol}>{t.symbol}: {t.expression_target?<>expression target {t.expression_target.rna_id} · index {t.expression_target.index} · co-targeted genes: {t.expression_target.genes.filter((g:string)=>g!==t.symbol).join(', ')||'none'}</>:'no verified expression target'}</p>)}</section>
}
