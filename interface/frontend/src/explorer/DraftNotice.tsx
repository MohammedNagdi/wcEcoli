import {useEffect,useRef,useState} from 'react'
import {useNavigationGuard} from '../components/common/NavigationGuard'
import {ConfirmDialog} from '../components/common/ConfirmDialog'
import {downloadDrafts,makeDraft,getDraft,type DraftKind} from './drafts'

export function DraftNotice({kind,name,payload,saved,draftId,warnings=[],onError}:{kind:DraftKind;name:string;payload:Record<string,any>;saved?:string;draftId?:string;warnings?:string[];onError?:(message:string)=>void}) {
  const snapshot=JSON.stringify(payload), initial=useRef(snapshot), savedRef=useRef(saved)
  if(saved!==savedRef.current){initial.current=snapshot;savedRef.current=saved}
  const dirty=snapshot!==initial.current
  const guard=useNavigationGuard(()=>dirty)
  const [error,setError]=useState('')
  useEffect(()=>{
    const block=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue=''}}
    window.addEventListener('beforeunload',block);return()=>window.removeEventListener('beforeunload',block)
  },[dirty])
  return <section className="rounded-lg border border-brand-200 bg-brand-50 p-3 mb-4 text-sm" aria-label="Personal draft notice">
    <p><strong>Personal browser draft.</strong> Planning checks use this release’s reference catalogs. This design is unrun; runtime readiness is unverified.</p>
    <p className="mt-1">Save keeps your design on this browser only. Download/import works in the explorer; it does not submit work to the local platform.</p>
    <button type="button" className="mt-2 rounded border px-3 py-1" onClick={()=>{
      const record=makeDraft(kind,name.trim()||'Untitled draft',payload)
      void (async()=>{if(draftId){const old=await getDraft(draftId).catch(()=>null);if(old){record.binding=old.binding;record.warnings=old.warnings}}await downloadDrafts([record])})().catch(e=>{setError(String(e.message));onError?.(String(e.message))})
    }}>Download current draft</button>
    <span className="ml-3 text-gray-600">{dirty?'Unsaved changes':saved?'Saved in this browser':'Not saved in this browser'}</span>
    {error&&<p role="alert">{error}</p>}
    {warnings.map(warning=><p key={warning} role="status" className="mt-2 text-amber-800">{warning}</p>)}
    <ConfirmDialog open={guard.state==='blocked'} title="Leave unsaved personal draft?" message="Save or download your edits before leaving to keep them." confirmLabel="Leave without saving" cancelLabel="Stay" onCancel={guard.reset} onConfirm={()=>guard.proceed()}/>
  </section>
}
