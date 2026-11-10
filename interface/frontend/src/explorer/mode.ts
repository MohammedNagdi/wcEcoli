export const IS_EXPLORER = import.meta.env.VITE_DEPLOYMENT_MODE === 'explorer'
export type ExplorerCapabilities = {
  schema_version:'explorer-capabilities-v1'; molecular_views:string[];
  mode: 'explorer'; read_only: true; execution: false; shared_persistence: false;
  assistant: false; training: false; browser_drafts: true; references_available: boolean;
  campaign_sha256: string; reference_sha256: string; model_sha256: string; source_sha256: string;
}
let current: ExplorerCapabilities | null = null
export function setExplorerCapabilities(value: ExplorerCapabilities) { current = value }
export function draftBinding() {
  if (!current) throw new Error('Explorer reference metadata has not loaded')
  return {campaign_sha256:current.campaign_sha256, reference_sha256:current.reference_sha256, model_sha256:current.model_sha256, source_sha256:current.source_sha256}
}
