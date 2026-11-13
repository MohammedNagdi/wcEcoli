export type ExplorerCapabilities = {
  schema_version:'explorer-capabilities-v1'; molecular_views:string[];
  mode: 'explorer'; read_only: true; execution: false; shared_persistence: false;
  assistant: false; training: false; browser_drafts: true; references_available: boolean;
  campaign_sha256: string; reference_sha256: string; model_sha256: string; source_sha256: string;
}

let current:ExplorerCapabilities|null=null
let generation=0
export function validateExplorerCapabilities(value:unknown):ExplorerCapabilities {
 const c=value as Partial<ExplorerCapabilities>|null
 if(!c||typeof c!=='object'||c.schema_version!=='explorer-capabilities-v1'||c.browser_drafts!==true||!Array.isArray(c.molecular_views)||!['mRNA','protein','reaction_flux','exchange_flux'].every(v=>c.molecular_views?.includes(v))||[c.campaign_sha256,c.reference_sha256,c.model_sha256,c.source_sha256].some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))||c.mode!=='explorer'||c.read_only!==true||c.execution!==false||c.shared_persistence!==false||c.assistant!==false||c.training!==false||c.references_available!==true)throw new Error('Explorer configuration mismatch or reference metadata missing. The local platform was not loaded.')
 return c as ExplorerCapabilities
}
export function beginExplorerReadiness(){current=null;return ++generation}
export function acceptExplorerCapabilities(attempt:number,value:unknown){
 if(attempt!==generation)return false
 current=validateExplorerCapabilities(value);return true
}
export function clearExplorerCapabilities(attempt:number){if(attempt===generation){current=null;++generation}}
export function explorerReferenceFingerprint(){return current?.reference_sha256 ?? null}
export function draftBinding(){
 if(!current)throw new Error('Explorer reference metadata has not loaded')
 return {campaign_sha256:current.campaign_sha256,reference_sha256:current.reference_sha256,model_sha256:current.model_sha256,source_sha256:current.source_sha256}
}
