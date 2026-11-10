import {useEffect,useState} from 'react'
import {fetchJSON} from '../api/transport'
import {beginExplorerReadiness,acceptExplorerCapabilities,clearExplorerCapabilities} from './readiness'
export function useExplorerReadiness(){
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
 useEffect(()=>{
  const controller=new AbortController(),generation=beginExplorerReadiness()
  setReady(false);setError('')
  void fetchJSON<unknown>('/capabilities',{signal:controller.signal}).then(value=>{
   if(!controller.signal.aborted&&acceptExplorerCapabilities(generation,value))setReady(true)
  }).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Published configuration is unavailable')})
  return()=>{controller.abort();clearExplorerCapabilities(generation)}
 },[attempt])
 return {ready,error,retry:()=>{setReady(false);setError('');setAttempt(n=>n+1)}}
}
