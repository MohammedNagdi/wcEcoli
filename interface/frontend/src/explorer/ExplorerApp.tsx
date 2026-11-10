import {useEffect,useRef,useState} from 'react'
import {Link,Navigate,Outlet,Route,Routes,useLocation,useParams,useSearchParams} from 'react-router-dom'
import {NavigationGuardProvider} from '../components/common/NavigationGuard'
import {WorkspaceUrlSync} from '../hooks/useUrlWorkspaceState'
import {Shell} from '../components/layout/Shell'
import {ExploreWorkspacePage} from '../components/explore/ExploreWorkspacePage'
import {GeneCatalogPage} from '../components/genes/GeneCatalogPage'
import {TFNetworkPage} from '../components/network/TFNetworkPage'
import {GenomeViewerPage} from '../components/genome/GenomeViewerPage'
import {PathwaysPage} from '../components/pathways/PathwaysPage'
import {ExperimentDesigner} from '../components/experiments/ExperimentDesigner'
import {TypedBatchBuilder} from '../components/experiments/TypedBatchBuilder'
import {EnvironmentBuilderPage} from '../components/experiments/EnvironmentBuilderPage'
import {ResultsPage,TimeseriesChart} from '../components/results/ResultsPage'
import {useTheme} from '../components/theme/ThemeProvider'
import {ThemeToggle} from '../components/theme/ThemeToggle'
import {ExplorerGuide} from './ExplorerGuide'
import {ConfirmDialog} from '../components/common/ConfirmDialog'
import {setExplorerCapabilities,type ExplorerCapabilities} from './mode'
import {allDrafts,downloadDrafts,duplicateDraft,getDraft,importDocument,removeDraft,saveDraft,type PersonalDraft} from './drafts'
import '../styles/home.css'
import './explorer.css'

export async function read<T=any>(path:string):Promise<T> {
  const response=await fetch('/api'+path)
  const data=await response.json()
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'Published data is unavailable')
  return data
}
export type Published={id:number;job_id:number;name:string;description:string;condition:string;outcome:string;reason:string;
  actual_generations:number[];variant_type:string;gene_symbol:string;transcription_unit_id:string|null;co_targeted_genes:string[]|null;controls:{key:string;role:string}[]}
function ErrorNotice({message}:{message:string}){const ref=useRef<HTMLParagraphElement>(null);useEffect(()=>{if(message)ref.current?.focus()},[message]);return message?<p ref={ref} role="alert" tabIndex={-1} className="my-3 rounded border border-red-200 bg-red-50 p-3 text-red-800">{message}</p>:null}
function PublicShell(){
  const location=useLocation()
  const content=<><div className="explorer-mode-note" role="note">Published data · personal designs stay in this browser · execution unavailable</div><Outlet/></>
  return <Shell>{location.pathname==='/guide'?<div className="explorer-guide-layout">{content}</div>:content}</Shell>
}

export default function ExplorerApp(){
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useEffect(()=>{let alive=true;void read<ExplorerCapabilities>('/capabilities').then(c=>{
    if(c.schema_version!=='explorer-capabilities-v1'||c.browser_drafts!==true||!['mRNA','protein','reaction_flux','exchange_flux'].every(v=>c.molecular_views?.includes(v))||[c.campaign_sha256,c.reference_sha256,c.model_sha256,c.source_sha256].some(v=>!v||!/^[a-f0-9]{64}$/.test(v))||c.mode!=='explorer'||!c.read_only||c.execution!==false||c.shared_persistence!==false||c.assistant!==false||c.training!==false||!c.references_available)throw new Error('Explorer configuration mismatch or reference metadata missing. The local platform was not loaded.')
    setExplorerCapabilities(c);if(alive){setReady(true);setError('')}
  }).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[attempt])
  if(!ready)return <main className="max-w-xl mx-auto p-8"><h1 className="text-xl font-semibold">Public explorer</h1><ErrorNotice message={error}/>{error?<button className="explorer-button" onClick={()=>setAttempt(n=>n+1)}>Retry configuration</button>:<p role="status">Checking the published release…</p>}</main>
  return <NavigationGuardProvider><WorkspaceUrlSync/><Routes>
    <Route path="/" element={<ExplorerHome/>}/>
    <Route element={<PublicShell/>}>
      <Route path="/explore" element={<ExploreWorkspacePage/>}/><Route path="/genes" element={<GeneCatalogPage/>}/>
      <Route path="/network" element={<TFNetworkPage/>}/><Route path="/genome" element={<GenomeViewerPage/>}/><Route path="/pathways" element={<PathwaysPage/>}/>
      <Route path="/experiments" element={<PublishedAndDrafts/>}/><Route path="/experiments/new" element={<ExperimentDesigner/>}/>
      <Route path="/experiments/batch" element={<TypedBatchBuilder/>}/><Route path="/environment-builder" element={<EnvironmentBuilderPage/>}/>
      <Route path="/experiments/environment-builder" element={<EnvironmentBuilderPage/>}/>
      <Route path="/results" element={<PublishedAndDrafts resultsOnly/>}/><Route path="/results/compare" element={<ExplorerComparison/>}/>
      <Route path="/results/:jobId" element={<PublishedResult/>}/><Route path="/design" element={<ExplorerEvidence/>}/>
      <Route path="/guide" element={<ExplorerGuide/>}/><Route path="/assistant" element={<Unavailable subject="Assistant"/>}/><Route path="/ml" element={<Unavailable subject="ML training and model metrics"/>}/>
      <Route path="*" element={<Unavailable subject="This page"/>}/>
    </Route>
  </Routes></NavigationGuardProvider>
}
function ExplorerHome(){
  const {resolvedTheme}=useTheme()
  const location=useLocation()
  if(['gene','q','category','condition','view'].some(k=>new URLSearchParams(location.search).has(k)))return <Navigate replace to={'/explore'+location.search}/>
  return <main className="home-page explorer-home">
    <header className="home-header"><Link className="font-semibold text-lg" to="/">wcEcoli</Link><nav className="flex items-center gap-5" aria-label="Main navigation"><Link to="/explore">Explore</Link><Link to="/results">Results</Link><Link to="/experiments/new">Design</Link><Link to="/guide">Guide</Link><ThemeToggle/></nav></header>
    <section className="explorer-home-hero"><p className="home-eyebrow">Whole-cell model explorer</p><h1>Explore the cell.<br/>Design the next question.</h1><p>Browse twelve real model experiments and their molecular trajectories. Build your own experiment plans using the reference catalogs, then keep or download them from your browser.</p>
      <div className="flex flex-wrap gap-3 mt-6"><Link className="explorer-button primary" to="/results">Explore published results</Link><Link className="explorer-button" to="/experiments/new">Design an experiment</Link></div>
    </section>
    <section className="explorer-home-evidence"><div><h2 className="text-2xl font-semibold">A result you can inspect.</h2><p>Follow measured mass and growth across generations, inspect recorded molecular series, and compare the published controls. Questions and model limitations stay beside the data.</p><Link to="/results" className="text-brand-600">Open the campaign →</Link></div><picture><img src={resolvedTheme==='dark'?'/previews/results-dark.webp':'/previews/results.webp'} alt="Real published wcEcoli experiment charts" width="1440" height="1100"/></picture></section>
    <section className="explorer-home-evidence"><picture><img src={resolvedTheme==='dark'?'/previews/designer-dark.webp':'/previews/designer.webp'} alt="Personal experiment draft designer" width="1440" height="1100" loading="lazy"/></picture><div><h2 className="text-2xl font-semibold">Turn a hypothesis into a plan.</h2><p>Use the existing single, batch and environment builders. Reference checks explain the configuration; they do not promise a phenotype or establish runtime readiness.</p><Link to="/experiments" className="text-brand-600">Published experiments and my drafts →</Link></div></section>
    <footer className="home-footer"><Link to="/guide">Explorer guide</Link><p>Save drafts in this browser, or download a JSON copy to keep or share.</p></footer>
  </main>
}
function draftRoute(d:PersonalDraft){return d.kind==='experiment'?`/experiments/new?draft=${d.id}`:d.kind==='batch'?`/experiments/batch?draft=${d.id}`:`/environment-builder?draft=${d.id}`}
function PublishedAndDrafts({resultsOnly=false}:{resultsOnly?:boolean}){
  const [published,setPublished]=useState<Published[]>([]),[drafts,setDrafts]=useState<PersonalDraft[]>([]),[query,setQuery]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [params,setParams]=useSearchParams(),[remove,setRemove]=useState<PersonalDraft|null>(null),[rename,setRename]=useState<PersonalDraft|null>(null),[newName,setNewName]=useState('')
  const [selection,setSelection]=useState<string[]>([])
  const [renameBusy,setRenameBusy]=useState(false),[renameError,setRenameError]=useState('')
  const personal=!resultsOnly&&params.get('view')==='drafts', file=useRef<HTMLInputElement>(null)
  const reload=()=>allDrafts().then(records=>{setDrafts(records);setSelection(ids=>ids.filter(id=>records.some(r=>r.id===id)))}).catch(e=>setError(e.message))
  useEffect(()=>{void read<Published[]>('/experiments').then(setPublished).catch(e=>setError(e.message));void reload();window.addEventListener('explorer-drafts-changed',reload);return()=>window.removeEventListener('explorer-drafts-changed',reload)},[])
  const action=(promise:Promise<unknown>)=>void promise.then(()=>reload()).catch(e=>setError(e.message))
  return <div className="explorer-page"><header className="explorer-heading"><div><h1>{resultsOnly?'Published results':'Experiments'}</h1><p>{personal?'Personal unrun designs saved on this browser.':'The hf-demo-v1 campaign: one seed per design; generations are a sequential lineage.'}</p></div><div className="flex flex-wrap gap-2"><Link className="explorer-button primary" to="/experiments/new">New personal draft</Link><Link className="explorer-button" to="/experiments/batch">Batch builder</Link><Link className="explorer-button" to="/results/compare">Compare results</Link></div></header>
    {!resultsOnly&&<nav className="flex gap-4 border-b mb-5" aria-label="Experiment collections"><button className="p-3" aria-pressed={!personal} onClick={()=>setParams({})}>Published experiments ({published.length})</button><button className="p-3" aria-pressed={personal} onClick={()=>setParams({view:'drafts'})}>My drafts ({drafts.length})</button></nav>}
    <ErrorNotice message={error}/>{notice&&<p role="status" className="my-3">{notice}</p>}
    <label className="block my-4">Search <input className="border rounded p-2 ml-2" value={query} onChange={e=>setQuery(e.target.value)} aria-label={personal?'Search my drafts':'Search published experiments'}/></label>
    {personal?<><div className="flex gap-2 mb-4"><button className="explorer-button" onClick={()=>file.current?.click()}>Import draft JSON</button><button className="explorer-button" disabled={!drafts.length} onClick={()=>action(downloadDrafts(drafts))}>Download all drafts</button><button className="explorer-button" disabled={!selection.length} onClick={()=>action(downloadDrafts(drafts.filter(d=>selection.includes(d.id))))}>Download selected drafts</button><input ref={file} type="file" accept=".json,application/json" className="hidden" aria-label="Draft JSON file" onChange={e=>{const f=e.target.files?.[0];if(!f)return;setError('');void (async()=>{if(f.size>5*1024*1024)throw new Error('Draft files must be at most 5 MiB');const records=await importDocument(await f.text());setNotice(`Imported ${records.length} personal copies. Existing drafts and published data were preserved.`);await reload()})().catch(e=>setError(e.message));e.target.value=''}}/></div>
      <div className="explorer-table-wrap"><table className="explorer-table"><thead><tr><th>Select</th><th>Name</th><th>Design</th><th>Status</th><th>Actions</th></tr></thead><tbody>{drafts.filter(d=>d.name.toLowerCase().includes(query.toLowerCase())).map(d=><tr key={d.id}><td><input type="checkbox" aria-label={`Select ${d.name}`} checked={selection.includes(d.id)} onChange={()=>setSelection(ids=>ids.includes(d.id)?ids.filter(id=>id!==d.id):[...ids,d.id])}/></td><td><Link to={draftRoute(d)}>{d.name}</Link>{d.warnings.map(w=><p key={w} className="text-amber-700 text-xs">{w}</p>)}</td><td>{d.kind}</td><td>Unrun · {d.applied?'personal overlay applied':'draft'}</td><td className="flex flex-wrap gap-3"><Link to={draftRoute(d)}>Open</Link><button onClick={()=>{setRenameError('');setRename(d);setNewName(d.name)}}>Rename</button><button onClick={()=>action(duplicateDraft(d.id))}>Duplicate</button><button onClick={()=>action(downloadDrafts([d]))}>Download</button><button onClick={()=>setRemove(d)}>Delete</button></td></tr>)}</tbody></table></div>{!drafts.length&&<p className="py-6">No personal drafts saved in this browser. Create a draft or import an explorer JSON file.</p>}
    </>:<div className="explorer-table-wrap"><table className="explorer-table"><thead><tr><th>Experiment</th><th>Initial condition</th><th>Actual generations</th><th>Lineage outcome</th><th>Actions</th></tr></thead><tbody>{published.filter(e=>(e.name+' '+e.description+' '+e.condition).toLowerCase().includes(query.toLowerCase())).map(e=><tr key={e.id}><td><Link to={`/results/${e.job_id}`}>{e.name}</Link><p className="text-xs text-gray-500 mt-1">{e.description}</p></td><td>{e.condition}</td><td>{e.actual_generations.join(', ')}</td><td>{e.outcome}<p className="text-xs text-gray-500">{e.reason}</p></td><td><div className="flex flex-col gap-2"><Link to={`/results/${e.job_id}`}>View result</Link><Link to={`/experiments/new?duplicate=${e.id}`}>Design from this experiment</Link></div></td></tr>)}</tbody></table></div>}
    <ConfirmDialog open={Boolean(remove)} title="Delete personal draft?" message="This removes only the draft on this browser. Other personal designs may need dependency review. Published data is unchanged." confirmLabel="Delete draft" onCancel={()=>setRemove(null)} onConfirm={()=>{if(remove)action(removeDraft(remove.id));setRemove(null)}}/>
    <ConfirmDialog open={Boolean(rename)} title="Rename personal draft" message="Names are personal to this browser." confirmLabel="Save name" busy={renameBusy} onCancel={()=>setRename(null)} onConfirm={()=>{
      if(!rename)return;setRenameBusy(true);setRenameError('');void saveDraft(rename.kind,newName,rename.payload,rename.id).then(()=>reload()).then(()=>setRename(null)).catch(e=>setRenameError(e.message)).finally(()=>setRenameBusy(false))
    }}><label className="block mt-3">Draft name <input required value={newName} onChange={e=>setNewName(e.target.value)} className="border rounded p-2 w-full"/></label>{renameError&&<p role="alert">{renameError}</p>}</ConfirmDialog>
  </div>
}
function PublishedResult(){
  const {jobId}=useParams(),[exp,setExp]=useState<Published|null>(null)
  useEffect(()=>{setExp(null);void read(`/jobs/${jobId}`).then(j=>read(`/experiments/${j.experiment_id}`)).then(setExp).catch(()=>{})},[jobId])
  return <><section className="mx-auto max-w-7xl p-3 border-b text-sm" aria-label="Published result context">{exp&&<><strong>{exp.name}</strong> · seed 0 · actual generations {exp.actual_generations.join(', ')} · lineage outcome: {exp.outcome}. {exp.reason}<div className="mt-2 flex gap-4"><Link to={`/experiments/new?duplicate=${exp.id}`}>Design from this experiment</Link><Link to={`/results/compare?ids=${[exp.id].join(',')}`}>Compare published references</Link></div><p className="mt-2">Molecular context summaries use generation 0; trajectory charts retain all actual generations. Missing channels have no fabricated curves.</p>{exp.transcription_unit_id&&<p>Expression perturbation targets {exp.transcription_unit_id}. Co-targeted genes: {exp.co_targeted_genes?.join(', ')||'none'}.</p>}</>}</section><ResultsPage/></>
}
function ExplorerComparison(){
  const [params]=useSearchParams(),[all,setAll]=useState<Published[]>([]),[ids,setIds]=useState<number[]>((params.get('ids')||'').split(',').filter(Boolean).map(Number)),[generation,setGeneration]=useState(0),[basis,setBasis]=useState('lineage'),[report,setReport]=useState<any>(null),[series,setSeries]=useState<any[]>([]),[error,setError]=useState('')
  useEffect(()=>{void read<Published[]>('/experiments').then(data=>{setAll(data);if(!ids.length)setIds(data.filter(e=>['wt-basal','hisG-basal'].includes(e.name)).map(e=>e.id))}).catch(e=>setError(e.message))},[])
  useEffect(()=>{if(!ids.length){setReport(null);setSeries([]);return}let active=true;setError('');void Promise.all([read(`/explorer/comparison?ids=${ids.join(',')}&generation=${generation}`),Promise.all(ids.map(id=>all.find(e=>e.id===id)).filter(Boolean).map(e=>read(`/jobs/${e!.job_id}/timeseries`)))]).then(([r,data])=>{if(active){setReport(r);setSeries(data)}}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[ids.join(','),generation,all])
  return <div className="explorer-page"><h1 className="text-xl font-semibold">Compare published results</h1><p className="my-3">Compare one actual generation at a time. There is one seed per design; confidence intervals are unavailable.</p><div className="flex flex-wrap gap-4 my-4"><label>Generation <select aria-label="Comparison generation" className="border rounded p-2" value={generation} onChange={e=>setGeneration(Number(e.target.value))}>{[0,1,2,3].map(g=><option key={g} value={g}>{g}</option>)}</select></label><label>Time axis <select aria-label="Comparison time axis" value={basis} onChange={e=>setBasis(e.target.value)} className="border rounded p-2"><option value="lineage">Elapsed lineage time</option><option value="generation">Time since generation start</option></select></label></div>
    <fieldset className="grid sm:grid-cols-3 gap-2 my-4"><legend>Choose up to four experiments</legend>{all.map(e=><label key={e.id}><input type="checkbox" checked={ids.includes(e.id)} disabled={!ids.includes(e.id)&&ids.length>=4} onChange={()=>setIds(current=>current.includes(e.id)?current.filter(x=>x!==e.id):[...current,e.id])}/> {e.name}</label>)}</fieldset><ErrorNotice message={error}/>
    <p className="my-3 font-medium">Time axis: {basis==='lineage'?'elapsed lineage minutes':'minutes since generation start'}. Units and generation identity are retained.</p>
    <div className="grid md:grid-cols-2 gap-4">{['cell_mass','growth_rate'].map(channel=>{const values=series.flatMap(r=>(r.timeseries[channel]||[]).filter((s:any)=>s.generation===generation).map((s:any)=>({...s,points:s.points.map((p:any)=>({...p,time:basis==='generation'?p.time-s.generation_start_sec:p.time}))})));return values.length?<TimeseriesChart key={channel} channel={channel} series={values} timeAxisLabel={basis==='lineage'?'Elapsed lineage time (min)':'Time since generation start (min)'}/>:<p key={channel}>{channel}: no selected saved generation</p>})}</div>
    <div className="explorer-table-wrap mt-5"><table className="explorer-table"><thead><tr><th>Experiment</th><th>Final saved mass (fg)</th><th>Final saved growth (1/s)</th><th>Recorded division duration (s)</th><th>References</th></tr></thead><tbody>{report?.experiments.map((e:any)=><tr key={e.id}><td>{e.name}{!e.metrics.available&&<p role="status">{e.metrics.reason}</p>}</td><td>{e.metrics.final_saved_mass_fg??'Unavailable'}</td><td>{e.metrics.final_saved_growth_rate_per_sec??'Unavailable'}</td><td>{e.metrics.division_duration_sec??'Unavailable'}</td><td>{e.controls.map((c:any)=><p key={c.key}>{c.role}: {c.key} {c.metrics.available?'':`— ${c.metrics.reason}`}</p>)}</td></tr>)}</tbody></table></div><p className="text-sm mt-3 text-gray-500">Final saved measurements are not means. A cell that did not divide has no division duration. Shift experiments retain separate initial and endpoint references.</p>
  </div>
}
function ExplorerEvidence(){
  const [symbol,setSymbol]=useState(''),[data,setData]=useState<any>(null),[error,setError]=useState('')
  useEffect(()=>{let alive=true;const timer=setTimeout(()=>{void read('/explorer/evidence?symbol='+encodeURIComponent(symbol)).then(d=>{if(alive){setData(d);setError('')}}).catch(e=>{if(alive)setError(e.message)})},200);return()=>{alive=false;clearTimeout(timer)}},[symbol])
  return <div className="explorer-page"><h1 className="text-xl font-semibold">Genome Design</h1><p className="my-3">Published expression-perturbation evidence and catalog context. This single-seed campaign cannot establish genome-wide essentiality; unmeasured genes remain unclassified.</p><label>Gene symbol <input className="border rounded p-2 ml-2" aria-label="Evidence gene symbol" value={symbol} onChange={e=>setSymbol(e.target.value)}/></label><ErrorNotice message={error}/>{symbol&&<p className="my-3"><Link to={'/explore?gene='+encodeURIComponent(symbol)}>Open gene catalog context</Link> · <Link to={'/experiments/new?gene='+encodeURIComponent(symbol)}>Design a personal perturbation</Link></p>}
    {data&&!data.experiments.length&&<p role="status" className="my-5">No published perturbation evidence for this gene in this campaign. Classification: unmeasured / unclassified.</p>}
    <div className="explorer-table-wrap mt-4"><table className="explorer-table"><thead><tr><th>Experiment</th><th>Requested gene / TU</th><th>All targeted genes</th><th>Recorded lineage outcome</th></tr></thead><tbody>{data?.experiments.map((e:any)=><tr key={e.id}><td><Link to={`/results/${e.job_id}`}>{e.name}</Link></td><td>{e.requested_gene}<p>{e.transcription_unit_id}</p></td><td>{e.targets.join(', ')}</td><td>{e.outcome} {e.reason}</td></tr>)}</tbody></table></div>
  </div>
}
function Unavailable({subject}:{subject:string}){return <div className="explorer-page"><h1 className="text-xl font-semibold">{subject} is unavailable in this explorer</h1><p className="my-4">The public release provides published scientific results and personal browser design tools. Execution, assistant providers and ML training are not initialized.</p><Link to="/results">Published results</Link> · <Link to="/experiments/new">Design an experiment</Link></div>}
