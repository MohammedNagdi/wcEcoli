import type { GeneKOSummary, EssentialityStats } from '../../types'

export const phenotypes = ['essential', 'growth_defect', 'neutral', 'unknown'] as const
export const phenotypeLabels: Record<GeneKOSummary['phenotype'], string> = {
  essential: 'No division observed', growth_defect: 'Reduced growth', neutral: 'Growth maintained', unknown: 'Unclassified',
}
export const evidenceLabels: Record<string, string> = {
  no_experiment: 'No experiment', no_completed_jobs: 'No completed jobs', missing_results: 'Missing results',
  unavailable_metrics: 'Unavailable metrics', partial: 'Partial results', usable: 'Usable results',
}
export type SortKey = 'gene_symbol' | 'category' | 'evidence_status' | 'phenotype' | 'n_completed' | 'mean_growth_rate' | 'mean_doubling_time_min' | 'division_fraction'
const sortKeys: SortKey[] = ['gene_symbol', 'category', 'evidence_status', 'phenotype', 'n_completed', 'mean_growth_rate', 'mean_doubling_time_min', 'division_fraction']
export function readDesignState(params: URLSearchParams) {
  const size = Number(params.get('pageSize'))
  const sort = params.get('sort') as SortKey
  const experiment = Number(params.get('experiment'))
  const page = Number(params.get('page'))
  const phenotype = params.get('phenotype') || ''
  const evidence = params.get('evidence') || ''
  return {
    condition: params.get('condition') || 'basal', view: params.get('view') === 'essentiality' ? 'essentiality' as const : 'table' as const,
    search: params.get('q') || '', category: params.get('category') || '', phenotype: phenotypes.some(p => p === phenotype) ? phenotype : '',
    evidence: ['usable', 'none', 'partial', 'missing_results'].includes(evidence) ? evidence : '', sort: sortKeys.includes(sort) ? sort : 'gene_symbol' as SortKey,
    direction: params.get('dir') === 'desc' ? 'desc' as const : 'asc' as const,
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page || 1)) : 1, pageSize: [25, 50, 100].includes(size) ? size : 50,
    gene: params.get('gene') || '', experimentId: Number.isInteger(experiment) && experiment > 0 ? experiment : undefined,
  }
}
export type DesignState = ReturnType<typeof readDesignState>
export function evidenceStatus(gene: GeneKOSummary) {
  return gene.evidence_status ?? (gene.experiment_id == null ? 'no_experiment' : gene.n_completed ? 'usable' : 'no_completed_jobs')
}
export function divisionFraction(gene: GeneKOSummary) {
  return gene.division_sample_count > 0 ? gene.divided_count / gene.division_sample_count : null
}
export function matchingGenes(genes: GeneKOSummary[], state: DesignState) {
  const q = state.search.trim().toLocaleLowerCase()
  return genes.filter(g => (!q || g.gene_symbol.toLocaleLowerCase().includes(q))
    && (!state.category || g.category === state.category)
    && (!state.phenotype || g.phenotype === state.phenotype)
    && (!state.evidence || (state.evidence === 'usable' ? g.usable_result_count > 0 : state.evidence === 'none' ? !g.usable_result_count : evidenceStatus(g) === state.evidence)))
}
export function sortGenes(genes: GeneKOSummary[], key: SortKey, direction: 'asc' | 'desc') {
  const value = (g: GeneKOSummary) => key === 'division_fraction' ? divisionFraction(g) : key === 'evidence_status' ? evidenceStatus(g) : g[key]
  return [...genes].sort((a, b) => {
    const av = value(a), bv = value(b)
    if (av == null && bv != null) return 1
    if (av != null && bv == null) return -1
    const order = av == null || bv == null ? 0 : typeof av === 'string' ? av.localeCompare(String(bv)) : Number(av) - Number(bv)
    return order * (direction === 'asc' ? 1 : -1) || a.gene_symbol.localeCompare(b.gene_symbol)
  })
}
export function categoryStats(genes: GeneKOSummary[]): EssentialityStats[] {
  const groups = new Map<string, EssentialityStats>()
  for (const g of genes) {
    const row = groups.get(g.category) ?? { category: g.category, total: 0, essential: 0, growth_defect: 0, neutral: 0, unknown: 0, essential_pct: 0 }
    row.total++; row[g.phenotype]++
    row.essential_pct = row.essential / row.total * 100
    groups.set(g.category, row)
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category))
}
export function metric(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}
export function geneLink(path: string, gene: string, condition: string) {
  return `${path}?${new URLSearchParams({ gene, condition })}`
}
