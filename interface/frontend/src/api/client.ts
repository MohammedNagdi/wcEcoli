/**
 * Typed API client for the wcEcoli backend.
 * All calls go through /api which Vite proxies to the FastAPI backend.
 */

import type {
  Gene, GeneDetail, GeneSearchResult, CategoryCount,
  TFNetwork, TFNode, AAPathway, Condition, Timeline, MediaRecipe, UserTimeline, Variant,
  VariantDetail, Experiment, ExperimentCreate,
  BatchRequest, BatchResponse, BatchSummary, BatchDetail, BatchRunResponse,
  SimulationJob, SimulationResult, RunJobRequest, RunResponse, ResultsResponse,
  ExperimentAggregation,
  FeatureExtractionResponse,
  MoleculeListResponse, MoleculeIdsResponse, MoleculeTimeseriesResponse,
  TrainRequest, TrainResponse, DataSummary,
  DesignOverview, EssentialityStats,
  ComparisonResponse, FailedJobSummary,
  WildtypeDelta,
} from '../types'

const BASE = '/api'

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

// --- Genes ---

export async function getGenes(params?: {
  q?: string
  category?: string
  mechanistic?: boolean
  page?: number
  page_size?: number
}, signal?: AbortSignal): Promise<GeneSearchResult> {
  const qs = new URLSearchParams()
  if (params?.q) qs.set('q', params.q)
  if (params?.category) qs.set('category', params.category)
  if (params?.mechanistic !== undefined) qs.set('mechanistic', String(params.mechanistic))
  if (params?.page) qs.set('page', String(params.page))
  if (params?.page_size) qs.set('page_size', String(params.page_size))
  const query = qs.toString()
  return fetchJSON(`/genes${query ? '?' + query : ''}`, { signal })
}

export async function getAllGenes(
  onBatch: (genes: Gene[]) => void,
  signal?: AbortSignal
): Promise<void> {
  let page = 1
  const PAGE = 500
  while (true) {
    const data = await getGenes({ page, page_size: PAGE }, signal)
    onBatch(data.genes)
    if (data.genes.length < PAGE) break
    page += 1
  }
}

export async function searchGenes(q: string, limit = 20): Promise<Gene[]> {
  return fetchJSON(`/genes/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export async function getGene(symbol: string): Promise<GeneDetail> {
  return fetchJSON(`/genes/${encodeURIComponent(symbol)}`)
}

export async function getGeneNeighbors(symbol: string, window = 5000): Promise<Gene[]> {
  return fetchJSON(`/genes/neighbors?symbol=${encodeURIComponent(symbol)}&window=${window}`)
}

export async function getCategories(): Promise<CategoryCount[]> {
  return fetchJSON('/genes/categories')
}

export async function getGeneByKoIndex(koIndex: number): Promise<Gene> {
  return fetchJSON(`/genes/by-ko-index/${koIndex}`)
}

export async function getGeneNeighbors(symbol: string, window = 5000): Promise<Gene[]> {
  const focalGene = await getGene(symbol)
  if (focalGene.left_end_pos == null || focalGene.right_end_pos == null) {
    return []
  }

  const focalLeft = Math.min(focalGene.left_end_pos, focalGene.right_end_pos)
  const focalRight = Math.max(focalGene.left_end_pos, focalGene.right_end_pos)
  const minPosition = focalLeft - window
  const maxPosition = focalRight + window

  const data = await getGenes({ page_size: 5000 })
  return data.genes
    .filter((gene) => gene.left_end_pos != null && gene.right_end_pos != null)
    .filter((gene) => {
      const geneLeft = Math.min(gene.left_end_pos ?? 0, gene.right_end_pos ?? 0)
      const geneRight = Math.max(gene.left_end_pos ?? 0, gene.right_end_pos ?? 0)
      return geneRight >= minPosition && geneLeft <= maxPosition
    })
    .sort((leftGene, rightGene) => (leftGene.left_end_pos ?? 0) - (rightGene.left_end_pos ?? 0))
}

// --- TF Network ---

export async function getTFNetwork(): Promise<TFNetwork> {
  return fetchJSON('/tf-network')
}

export async function getTFSubnetwork(tf: string): Promise<TFNode> {
  return fetchJSON(`/tf-network/${encodeURIComponent(tf)}`)
}

// --- Pathways ---

export async function getAAPathways(): Promise<AAPathway[]> {
  return fetchJSON('/pathways/amino-acids')
}

// --- Conditions, Timelines, Variants ---

export async function getConditions(): Promise<Condition[]> {
  return fetchJSON('/conditions')
}

export async function getTimelines(): Promise<Timeline[]> {
  return fetchJSON('/timelines')
}

export async function getMediaRecipes(): Promise<MediaRecipe[]> {
  return fetchJSON('/media-recipes')
}

export async function getUserTimelines(): Promise<UserTimeline[]> {
  return fetchJSON('/user-timelines')
}

export async function saveUserTimeline(name: string, definition: string): Promise<UserTimeline> {
  return fetchJSON('/user-timelines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, definition }),
  })
}

export async function getVariants(): Promise<Variant[]> {
  return fetchJSON('/variants')
}

// --- Experiments ---

export async function getVariantDetail(name: string): Promise<VariantDetail> {
  return fetchJSON(`/experiments/variants/${encodeURIComponent(name)}`)
}

export async function getExperiments(status?: string): Promise<Experiment[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return fetchJSON(`/experiments${qs}`)
}

export async function createExperiment(data: ExperimentCreate): Promise<Experiment> {
  return fetchJSON('/experiments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getExperiment(id: number): Promise<Experiment> {
  return fetchJSON(`/experiments/${id}`)
}

export async function updateExperiment(id: number, data: Partial<ExperimentCreate>): Promise<Experiment> {
  return fetchJSON(`/experiments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteExperiment(id: number): Promise<void> {
  const res = await fetch(`${BASE}/experiments/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`Delete failed: ${res.status}`)
  }
}

export async function createBatchExperiments(data: BatchRequest): Promise<BatchResponse> {
  return fetchJSON('/experiments/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getBatches(): Promise<BatchSummary[]> {
  return fetchJSON('/experiments/batches')
}

export async function getBatchDetail(batchId: string): Promise<BatchDetail> {
  return fetchJSON(`/experiments/batches/${batchId}`)
}

export async function runBatch(batchId: string): Promise<BatchRunResponse> {
  return fetchJSON(`/experiments/batches/${batchId}/run`, { method: 'POST' })
}

// --- Simulation Jobs ---

export async function runExperiment(
  experimentId: number,
  data?: RunJobRequest
): Promise<RunResponse> {
  return fetchJSON(`/experiments/${experimentId}/run`, {
    method: 'POST',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function getJobs(params?: {
  experiment_id?: number
  status?: string
}): Promise<SimulationJob[]> {
  const qs = new URLSearchParams()
  if (params?.experiment_id != null) qs.set('experiment_id', String(params.experiment_id))
  if (params?.status) qs.set('status', params.status)
  const query = qs.toString()
  return fetchJSON(`/jobs${query ? '?' + query : ''}`)
}

export async function getJob(id: number): Promise<SimulationJob> {
  return fetchJSON(`/jobs/${id}`)
}

export async function getJobResults(id: number): Promise<SimulationResult[]> {
  return fetchJSON(`/jobs/${id}/results`)
}

export async function getExperimentResults(experimentId: number): Promise<ExperimentAggregation> {
  return fetchJSON(`/experiments/${experimentId}/results`)
}

export async function cancelJob(id: number): Promise<void> {
  await fetch(`${BASE}/jobs/${id}`, { method: 'DELETE' })
}

export async function retryJob(id: number): Promise<SimulationJob> {
  return fetchJSON(`/jobs/${id}/retry`, { method: 'POST' })
}

export async function deleteJobPermanent(id: number): Promise<void> {
  await fetch(`${BASE}/jobs/${id}/permanent`, { method: 'DELETE' })
}

export async function getFailedJobs(): Promise<FailedJobSummary[]> {
  return fetchJSON('/jobs/failed')
}

// --- Results / Timeseries ---

export async function getJobTimeseries(jobId: number): Promise<ResultsResponse> {
  return fetchJSON(`/jobs/${jobId}/timeseries`)
}

// --- Molecules ---

export async function getMoleculeTypes(jobId: number): Promise<MoleculeListResponse> {
  return fetchJSON(`/jobs/${jobId}/molecules`)
}

export async function getMoleculeIds(
  jobId: number,
  moleculeType: string,
  params?: { search?: string; limit?: number; offset?: number }
): Promise<MoleculeIdsResponse> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set('search', params.search)
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  const query = qs.toString()
  return fetchJSON(`/jobs/${jobId}/molecules/${moleculeType}/ids${query ? '?' + query : ''}`)
}

export async function getMoleculeTimeseries(
  jobId: number,
  moleculeType: string,
  ids: string[]
): Promise<MoleculeTimeseriesResponse> {
  const idsParam = ids.map(encodeURIComponent).join(',')
  return fetchJSON(`/jobs/${jobId}/molecules/${moleculeType}/timeseries?ids=${idsParam}`)
}

export async function searchMolecules(
  jobId: number,
  query: string
): Promise<{ query: string; results: Record<string, string[]>; total_matches: number }> {
  return fetchJSON(`/jobs/${jobId}/molecules/search?q=${encodeURIComponent(query)}`)
}

// --- Features (ML) ---

export async function getFeatures(params?: {
  condition?: string
  variant_type?: string
  mechanistic_only?: boolean
}): Promise<FeatureExtractionResponse> {
  const qs = new URLSearchParams()
  if (params?.condition) qs.set('condition', params.condition)
  if (params?.variant_type) qs.set('variant_type', params.variant_type)
  if (params?.mechanistic_only) qs.set('mechanistic_only', 'true')
  const query = qs.toString()
  return fetchJSON(`/features${query ? '?' + query : ''}`)
}

export function getFeaturesCSVUrl(params?: {
  condition?: string
  variant_type?: string
  mechanistic_only?: boolean
}): string {
  const qs = new URLSearchParams()
  if (params?.condition) qs.set('condition', params.condition)
  if (params?.variant_type) qs.set('variant_type', params.variant_type)
  if (params?.mechanistic_only) qs.set('mechanistic_only', 'true')
  const query = qs.toString()
  return `${BASE}/features/csv${query ? '?' + query : ''}`
}

// --- Machine Learning ---

export async function getDataSummary(): Promise<DataSummary> {
  return fetchJSON('/ml/data-summary')
}

export async function trainModel(data: TrainRequest): Promise<TrainResponse> {
  return fetchJSON('/ml/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

// --- Genome Design ---

export async function getDesignOverview(params?: {
  category?: string
  phenotype?: string
  condition?: string
}): Promise<DesignOverview> {
  const qs = new URLSearchParams()
  if (params?.category) qs.set('category', params.category)
  if (params?.phenotype) qs.set('phenotype', params.phenotype)
  if (params?.condition) qs.set('condition', params.condition || 'basal')
  const query = qs.toString()
  return fetchJSON(`/design/overview${query ? '?' + query : ''}`)
}

export async function getEssentiality(
  condition?: string
): Promise<EssentialityStats[]> {
  const qs = new URLSearchParams()
  if (condition) qs.set('condition', condition)
  const query = qs.toString()
  return fetchJSON(`/design/essentiality${query ? '?' + query : ''}`)
}

// --- Wildtype delta ---

export async function getWtDelta(experimentId: number): Promise<WildtypeDelta> {
  return fetchJSON(`/experiments/wt-delta/${experimentId}`)
}

// --- Comparison ---

export async function compareExperiments(
  ids: number[],
  includeWildtype = true
): Promise<ComparisonResponse> {
  const qs = new URLSearchParams()
  qs.set('ids', ids.join(','))
  if (!includeWildtype) qs.set('include_wildtype', 'false')
  return fetchJSON(`/experiments/compare?${qs.toString()}`)
}

export async function compareBatch(
  batchId: string,
  includeWildtype = true
): Promise<ComparisonResponse> {
  const qs = includeWildtype ? '' : '?include_wildtype=false'
  return fetchJSON(`/experiments/compare/batch/${batchId}${qs}`)
}

// --- Health ---

export async function getHealth(): Promise<{ status: string; version: string }> {
  return fetchJSON('/health')
}
