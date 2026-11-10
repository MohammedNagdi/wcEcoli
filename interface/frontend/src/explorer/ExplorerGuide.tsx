import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {Link,useLocation,useSearchParams} from 'react-router-dom'
import type {ConditionCatalog,VariantDetail} from '../types'
import {variantLabel} from '../utils/labels'
import {ThemeToggle} from '../components/theme/ThemeToggle'
import {GUIDE_ARTICLES,GUIDE_GROUPS,GUIDE_SECTIONS,GUIDE_SHORTCUTS,GUIDE_VARIANTS,type GuideSection} from './guideContent'
import {GUIDE_TOPICS,guideTopicHref,resolveGuideDestination,type GuideTopicId} from './guideLinks'
import './guide.css'

const INTERNAL = new Set(['apply_variant','template','template_internal_shift'])
const isObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
const hasStrings=(value:unknown,keys:readonly string[])=>isObject(value)&&keys.every(key=>typeof value[key]==='string')
const isVariants=(value:unknown):value is VariantDetail[]=>Array.isArray(value)&&value.every(v=>
  isObject(v)&&typeof v.name==='string'&&isObject(v.parameter_hints)&&
  (v.parameter_hints.index_options===undefined||(Array.isArray(v.parameter_hints.index_options)&&v.parameter_hints.index_options.every(i=>typeof i==='string'))))
const isCatalog=(value:unknown):value is ConditionCatalog=>isObject(value)&&
  ['conditions','media_recipes','media_stocks','tf_conditions','timelines','environment_molecules'].every(k=>Array.isArray(value[k]))&&
  (value.conditions as unknown[]).every(c=>hasStrings(c,['condition','nutrients','doubling_time','active_tfs','inactive_tfs','genotype_perturbations']))&&
  (value.media_recipes as unknown[]).every(r=>hasStrings(r,['media_id','base_media','added_media','base_media_volume','added_media_volume','ingredients','ingredients_weight','ingredients_counts','ingredients_volume']))&&
  (value.media_stocks as unknown[]).every(s=>isObject(s)&&typeof s.name==='string'&&Array.isArray(s.rows)&&s.rows.every(r=>isObject(r)&&typeof r.molecule_id==='string'&&typeof r.concentration==='string'))&&
  (value.tf_conditions as unknown[]).every(t=>hasStrings(t,['tf','tf_type','active_tf','active_nutrients','inactive_nutrients','active_genotype_perturbations','inactive_genotype_perturbations']))&&
  (value.timelines as unknown[]).every(t=>hasStrings(t,['timeline','events']))

function usePublished<T>(path:string,validate:(value:unknown)=>value is T){
  const [data,setData]=useState<T>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    setData(undefined);setError('')
    void (async()=>{
      const response=await fetch('/api'+path,{signal:controller.signal})
      if(!response.ok)throw new Error('Reference request failed')
      const value:unknown=await response.json()
      if(!validate(value))throw new Error('Reference format is unavailable')
      if(!controller.signal.aborted)setData(value)
    })().catch(()=>{if(!controller.signal.aborted)setError('Published reference data could not be loaded. Static guidance is still available.')})
    return()=>controller.abort()
  },[path,validate,attempt])
  return {data,error,retry:()=>setAttempt(n=>n+1)}
}

function ReferenceStatus({resource,label}:{resource:{data:unknown;error:string;retry:()=>void};label:string}){
  const error=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(resource.error)error.current?.focus()},[resource.error])
  if(resource.error)return <div ref={error} role="alert" tabIndex={-1} className="guide-notice"><p>{resource.error}</p><button className="explorer-button" onClick={resource.retry}>Retry {label}</button></div>
  if(resource.data===undefined)return <p role="status">Loading published {label}…</p>
  return null
}

function ReferenceTable({label,headings,children}:{label:string;headings:string[];children:ReactNode}){
  return <div className="guide-table-wrap" role="region" aria-label={label} tabIndex={0}><table><caption>{label}</caption><thead><tr>{headings.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}
function Value({value}:{value:unknown}){return value===undefined||value===null||value===''?<span>Not recorded</span>:<code>{String(value)}</code>}

type GeneReference={symbol:string;expression_target:{index:number;rna_id:string;genes:string[]}|null}
const isGene=(v:unknown):v is GeneReference=>isObject(v)&&typeof v.symbol==='string'&&(v.expression_target===null||
  (isObject(v.expression_target)&&typeof v.expression_target.index==='number'&&typeof v.expression_target.rna_id==='string'&&Array.isArray(v.expression_target.genes)&&v.expression_target.genes.every(g=>typeof g==='string')))
function TargetExample({symbol}:{symbol:string}){
  const resource=usePublished('/genes/'+symbol,isGene),gene=resource.data,target=gene?.expression_target
  return <section className="guide-target"><h4><Link to={'/explore?gene='+symbol}>{symbol}</Link></h4><ReferenceStatus resource={resource} label={symbol+' target'}/>
    {gene&&(target?<dl><dt>Prepared index</dt><dd>{target.index}</dd><dt>RNA / transcription unit</dt><dd><code>{target.rna_id}</code></dd><dt>Co-targeted genes</dt><dd>{target.genes.filter(g=>g!==gene.symbol).join(', ')||'None recorded'}</dd></dl>:<p>No prepared target mapping is available for this gene.</p>)}
  </section>
}

function VariantCard({variant,targeted=false,onReady}:{variant:VariantDetail;targeted?:boolean;onReady?:(element:HTMLElement|null)=>void}){
  const [open,setOpen]=useState(targeted),entry=GUIDE_VARIANTS[variant.name],hints=variant.parameter_hints,summary=useRef<HTMLElement>(null)
  useLayoutEffect(()=>{if(targeted)onReady?.(open?summary.current:null)},[targeted,open,onReady])
  return <details className="guide-card" data-variant={variant.name} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary ref={summary} className="guide-topic-heading" data-guide-key={targeted?'variant:'+variant.name:undefined} onAnimationEnd={event=>event.currentTarget.removeAttribute('data-guide-target')} onBlur={event=>event.currentTarget.removeAttribute('data-guide-target')}><span>{variantLabel(variant.name)}</span><code>{variant.name}</code></summary>
    {open&&<div className="guide-card-body">
      {entry?<><p>{entry.summary}</p><h4>Question to investigate</h4><p>{entry.question}</p>{entry.limitation&&<p className="guide-notice">{entry.limitation}</p>}</>:<p role="status">Documentation for this catalog type has not been reviewed. Do not infer its behavior from its name.</p>}
      <h4>Published parameter metadata</h4>
      <p>{hints.index_meaning||'A detailed parameter meaning is not recorded in this catalog.'}</p>
      {hints.hide_index&&<p>The index is hidden or derived; use the designer’s selection controls.</p>}
      {hints.index_range&&<p>Recorded index range: <code>{hints.index_range[0]}–{hints.index_range[1]}</code>.</p>}
      {hints.min_valid_index!==undefined&&<p>Recorded minimum index: {hints.min_valid_index}.</p>}
      {hints.max_valid_index!==undefined&&<p>Recorded maximum index: {hints.max_valid_index}.</p>}
      {hints.index_options?.length?<details className="guide-options"><summary>Recorded index options ({hints.index_options.length})</summary><ul>{hints.index_options.map((option,index)=><li key={index}>{option}</li>)}</ul></details>:<p>Detailed index options are not available. Do not guess a parameter mapping.</p>}
      <h4>Environment and timeline</h4>
      <p>{hints.timeline_notice||'The catalog exposes composed media controls for this type. Model-specific preparation and execution behavior remain unverified for an unrun design.'}</p>
      <dl><dt>Catalog timeline behavior</dt><dd><Value value={hints.timeline_behavior}/></dd>{hints.environment_lock&&<><dt>Environment restriction</dt><dd><Value value={hints.environment_lock}/></dd></>}{hints.fixed_condition&&<><dt>Fixed condition</dt><dd><Value value={hints.fixed_condition}/></dd></>}{hints.fixed_timeline&&<><dt>Variant-managed media definition</dt><dd><Value value={hints.fixed_timeline}/></dd></>}</dl>
      {variant.name==='gene_knockout'&&<section><h4>Prepared transcription-unit examples</h4><p>These mappings are read from the published prepared-model references, not inferred from gene order. Co-targets are part of the perturbation.</p><div className="guide-targets">{['hisG','trpA','pgi'].map(symbol=><TargetExample key={symbol} symbol={symbol}/>)}</div></section>}
      <p className="guide-muted">Catalog information supports a personal plan. It does not establish runtime readiness or a biological outcome.</p>
      <Link className="guide-action" to={'/experiments/new?variant='+encodeURIComponent(variant.name)}>Design with this type →</Link>
    </div>}
  </details>
}
function VariantReference({targetVariant,onReady}:{targetVariant?:string;onReady:(element:HTMLElement|null)=>void}){
  const resource=usePublished('/variants',isVariants),variants=resource.data?.filter(v=>!INTERNAL.has(v.name))
  return <section aria-label="Published experiment type reference"><ReferenceStatus resource={resource} label="experiment types"/>
    {variants&&targetVariant&&!variants.some(v=>v.name===targetVariant)&&<p role="status" className="guide-notice">The requested experiment type is unavailable in this published catalog. No other type has been selected.</p>}
    {variants?.length===0&&<p role="status">No experiment types are available in the published catalog.</p>}
    {GUIDE_GROUPS.map(([id,label])=>{
      const group=variants?.filter(v=>GUIDE_VARIANTS[v.name]?.group===id)
      return group?.length?<section className="guide-group" key={id}><h3>{label}</h3>{group.map(v=><VariantCard key={v.name} variant={v} targeted={v.name===targetVariant} onReady={onReady}/>)}</section>:null
    })}
    {variants?.filter(v=>!GUIDE_VARIANTS[v.name]).map(v=><VariantCard key={v.name} variant={v} targeted={v.name===targetVariant} onReady={onReady}/>)}
  </section>
}

function ConditionReference(){
  const resource=usePublished('/condition-catalog',isCatalog),catalog=resource.data
  return <section aria-label="Published environment references"><ReferenceStatus resource={resource} label="growth conditions"/>{catalog&&<>
    <ReferenceTable label="Published conditions" headings={['Condition','Nutrient recipe','Reference doubling time (min)','Additional settings']}>
      {catalog.conditions.map(c=><tr key={c.condition}><th scope="row"><code>{c.condition}</code></th><td><code>{c.nutrients}</code></td><td><Value value={c.doubling_time}/></td><td><details><summary>TF and expression settings</summary><dl><dt>Active TFs</dt><dd><Value value={c.active_tfs}/></dd><dt>Inactive TFs</dt><dd><Value value={c.inactive_tfs}/></dd><dt>Expression perturbations</dt><dd><Value value={c.genotype_perturbations}/></dd></dl></details></td></tr>)}
    </ReferenceTable>
    {!catalog.conditions.length&&<p>No conditions are recorded.</p>}
    <h3>Media recipes</h3><p>Recipe fields retain the published quantities: stock and ingredient volumes in L, ingredient weights in g, and ingredient amounts in mmol. These are distinct from stock concentrations in mmol/L.</p>
    <ReferenceTable label="Published media recipes" headings={['Recipe ID','Base stock','Added stock','Recipe details']}>
      {catalog.media_recipes.map(r=><tr key={r.media_id}><th scope="row"><code>{r.media_id}</code></th><td><Value value={r.base_media}/></td><td>{r.added_media?<code>{r.added_media}</code>:'No added stock'}</td><td><details><summary>Recorded recipe fields</summary><dl>{(['base_media_volume','added_media_volume','ingredients','ingredients_weight','ingredients_counts','ingredients_volume'] as const).map(key=><div key={key}><dt>{key}</dt><dd><Value value={r[key]}/></dd></div>)}</dl></details></td></tr>)}
    </ReferenceTable>
    <h3>Media stocks</h3><p>Concentrations below are in mmol/L. Infinity means unconstrained model supply.</p>
    {catalog.media_stocks.map(stock=><details className="guide-card" key={stock.name}><summary><code>{stock.name}</code><span>{stock.rows.length} molecules</span></summary><div className="guide-card-body"><ReferenceTable label={stock.name+' concentrations'} headings={['Molecule ID','Concentration (mmol/L)']}>{stock.rows.map((r,i)=><tr key={i}><th scope="row"><code>{r.molecule_id}</code></th><td><code>{r.concentration}</code></td></tr>)}</ReferenceTable></div></details>)}
    <h3>TF-condition definitions</h3><p>Active and inactive definitions can specify different nutrient recipes and expression perturbations. A TF label alone does not describe the whole environment.</p>
    {catalog.tf_conditions.map(c=><details className="guide-card" key={c.tf}><summary><code>{c.tf}</code><span>{c.tf_type}</span></summary><div className="guide-card-body"><dl>{(['active_tf','active_nutrients','inactive_nutrients','active_genotype_perturbations','inactive_genotype_perturbations'] as const).map(key=><div key={key}><dt>{key}</dt><dd><Value value={c[key]}/></dd></div>)}</dl></div></details>)}
  </>}</section>
}

function parseTimeline(definition:string){
  const events:{seconds:number;media:string}[]=[]
  for(const part of definition.split(',')){
    const match=part.trim().match(/^(\d+(?:\.\d+)?)\s+(\S+)$/)
    if(!match)return null
    const seconds=Number(match[1])
    if(!Number.isFinite(seconds)||(events.length?seconds<=events[events.length-1].seconds:seconds!==0))return null
    events.push({seconds,media:match[2]})
  }
  return events.length?events:null
}
function TimelineReference(){
  const resource=usePublished('/condition-catalog',isCatalog),catalog=resource.data
  const media=new Set(catalog?.media_recipes.map(r=>r.media_id))
  return <section aria-label="Published timeline references"><ReferenceStatus resource={resource} label="timelines"/>{catalog&&<>
    <h3>Published timeline definitions</h3><p>These are reference schedules, not additional executed campaign results. The first row describes the time-zero medium; later rows are subsequent media changes.</p>
    {!catalog.timelines.length&&<p>No timeline definitions are recorded.</p>}
    {catalog.timelines.map(t=>{
      const events=parseTimeline(t.events),resolved=events?.every(e=>media.has(e.media))
      return <details className="guide-card" key={t.timeline}><summary><code>{t.timeline}</code></summary><div className="guide-card-body"><p>Recorded definition: <code>{t.events}</code></p>
        {events&&resolved?<ReferenceTable label={t.timeline+' events'} headings={['Event','Elapsed seconds','Elapsed minutes','Media recipe']}>{events.map((e,i)=><tr key={i}><th scope="row">{i===0?'Starting medium':'Media change'}</th><td>{e.seconds}</td><td>{e.seconds/60}</td><td><code>{e.media}</code></td></tr>)}</ReferenceTable>:<p role="status">This reference timeline cannot be resolved: its ordering, time-zero event or media reference is invalid. No schedule has been inferred.</p>}
      </div></details>
    })}
  </>}</section>
}

export function ExplorerGuide(){
  const [params,setParams]=useSearchParams(),location=useLocation()
  const {section,target,notice,canonical}=resolveGuideDestination(params)
  const article=GUIDE_ARTICLES[section],title=GUIDE_SECTIONS.find(([id])=>id===section)![1]
  const scroll=useRef<HTMLDivElement>(null),navigation=useRef<HTMLElement>(null),mobileMenu=useRef<HTMLDetailsElement>(null)
  const [targetElement,setTargetElement]=useState<HTMLElement|null>(null),handled=useRef('')
  const navigationKey=location.key+'?'+params.toString()
  const targetKey=target?(target.kind==='topic'?'topic:'+target.id:'variant:'+target.name):''
  useEffect(()=>{if(canonical)setParams(canonical,{replace:true})},[canonical,setParams])
  useLayoutEffect(()=>{
    scroll.current?.scrollTo({top:0})
    navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'})
  },[navigationKey])
  useLayoutEffect(()=>{
    const panel=scroll.current
    if(canonical||!panel||!targetKey||!targetElement?.isConnected||targetElement.dataset.guideKey!==targetKey||handled.current===navigationKey)return
    handled.current=navigationKey
    targetElement.focus({preventScroll:true})
    panel.scrollTo({top:Math.max(0,panel.scrollTop+targetElement.getBoundingClientRect().top-panel.getBoundingClientRect().top-12),behavior:'auto'})
    targetElement.setAttribute('data-guide-target','active')
  },[canonical,targetElement,targetKey,navigationKey])
  return <div className="explorer-guide">
    <div className="guide-mobile-tools"><Link to="/" className="guide-wordmark">wcEcoli</Link>
      <details ref={mobileMenu} className="guide-site-menu" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();mobileMenu.current?.removeAttribute('open');mobileMenu.current?.querySelector('summary')?.focus()}}}>
        <summary>Navigate</summary><nav aria-label="Guide site navigation" onClickCapture={event=>{if((event.target as HTMLElement).closest('a'))mobileMenu.current?.removeAttribute('open')}}>
          {[['/','Home'],['/explore','Workspace'],['/genome','Genome Map'],['/network','Network'],['/pathways','Pathways'],['/environment-builder','Conditions Builder'],['/experiments','Experiments and drafts'],['/results','Results'],['/design','Genome Design']].map(([to,label])=><Link key={to} to={to}>{label}</Link>)}
        </nav>
      </details><ThemeToggle/>
    </div>
    <header className="guide-header"><h1>Explorer guide</h1><p>Reference documentation for published results and personal experiment plans.</p></header>
    <nav ref={navigation} className="guide-nav" aria-label="Guide sections">{GUIDE_SECTIONS.map(([id,label])=><Link key={id} to={'/guide?section='+id} aria-current={section===id?'page':undefined}>{label}</Link>)}</nav>
    <div ref={scroll} className="guide-content" role="region" aria-label="Guide section content" tabIndex={0}>
      <article aria-labelledby="guide-section-heading" key={navigationKey}>
        {notice&&<p role="status" className="guide-notice">{notice}</p>}
        <h2 id="guide-section-heading">{title}</h2><p className="guide-intro">{article.intro}</p>
        {section==='overview'&&<nav className="guide-links" aria-label="Model context topics">{(Object.keys(GUIDE_TOPICS) as GuideTopicId[]).map(id=><Link className="guide-action" key={id} to={guideTopicHref(id)}>{GUIDE_TOPICS[id].heading}</Link>)}</nav>}
        {article.blocks.map(block=><section className="guide-block" key={block.heading}><h3 id={block.topic?'guide-topic-'+block.topic:undefined} className={block.topic?'guide-topic-heading':undefined} tabIndex={block.topic?-1:undefined} data-guide-key={block.topic?'topic:'+block.topic:undefined} ref={target?.kind==='topic'&&target.id===block.topic?setTargetElement:undefined} onAnimationEnd={event=>event.currentTarget.removeAttribute('data-guide-target')} onBlur={event=>event.currentTarget.removeAttribute('data-guide-target')}>{block.heading}</h3>{block.paragraphs.map(p=><p key={p}>{p}</p>)}</section>)}
        {section==='variants'&&<VariantReference targetVariant={target?.kind==='variant'?target.name:undefined} onReady={setTargetElement}/>} {section==='conditions'&&<ConditionReference/>}{section==='timelines'&&<TimelineReference/>}
        {section==='shortcuts'&&<ReferenceTable label="Explorer workspace shortcuts" headings={['Shortcut','Action']}>{GUIDE_SHORTCUTS.map(([keys,action])=><tr key={keys}><th scope="row"><kbd>{keys}</kbd></th><td>{action}</td></tr>)}</ReferenceTable>}
        {article.links&&<nav className="guide-links" aria-label={title+' next steps'}>{article.links.map(link=><Link key={link.to} className="guide-action" to={link.to}>{link.label} →</Link>)}</nav>}
        <footer className="guide-source">Reference values come from this release’s published catalogs. Personal drafts remain unrun plans.</footer>
      </article>
    </div>
  </div>
}
