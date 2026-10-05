import type { Page, Route } from '@playwright/test'
import type { DesignGeneEvidence, DesignOverview, DesignSource, GeneKOSummary } from '../../src/types'
import { mockAssistantApi } from './assistantApi'

export const source: DesignSource = {
  experiment_id: 101, name: 'dnaA knockout', status: 'done', created_at: '2026-01-01', condition: 'basal', timeline: '', resolved_protocol: '',
  duration_sec: 10800, generations: 2, configured_seed_count: 2, total_jobs: 3, completed_jobs: 2, usable_results: 2, experiment_url: '/experiments?experiment=101',
}
export function gene(symbol: string, changes: Partial<GeneKOSummary> = {}): GeneKOSummary {
  return { gene_symbol: symbol, ko_index: 42, category: 'dna_replication', is_mechanistic: true, experiment_id: 101, n_seeds: 3, n_completed: 2,
    divided: true, division_rate: '2/2 divided', mean_division_time_min: 60, mean_growth_rate: 0.0008, mean_doubling_time_min: 45.5, mean_final_mass_fg: 1234.5,
    phenotype: 'neutral', evidence_status: 'usable', evidence_reason: 'Usable completed results.', evidence_gaps: [], usable_result_count: 2, recorded_result_count: 2,
    divided_count: 2, division_sample_count: 2, metric_sample_counts: { growth_rate: 2, doubling_time_min: 1, final_mass_fg: 2, division_time_min: 2 }, source,
    baseline: { status: 'available', reason: 'Matched condition, resolved protocol, duration and generations; seed sets may differ.',
      source: { ...source, experiment_id: 100, name: 'Wildtype', configured_seed_count: 3, experiment_url: '/experiments?experiment=100' }, mean_growth_rate: 0.001, growth_rate_samples: 3 },
    aggregation_scope: 'Earliest recorded generation per completed job; experiments are never merged.', ...changes }
}
export const genes = [gene('dnaA'), gene('crp', { category: 'regulation', phenotype: 'growth_defect', mean_growth_rate: 0.0006 }),
  gene('leuA', { category: 'dna_replication', phenotype: 'essential', divided: false, divided_count: 0, division_rate: '0/2 divided' }),
  gene('rpoB', { category: 'regulation', phenotype: 'unknown', experiment_id: null, evidence_status: 'no_experiment', evidence_reason: 'No knockout experiment for this condition.',
    usable_result_count: 0, recorded_result_count: 0, division_sample_count: 0, divided: null, n_completed: 0, n_seeds: 0, division_rate: null,
    mean_growth_rate: null, mean_doubling_time_min: null, mean_division_time_min: null, mean_final_mass_fg: null, source: null, evidence_gaps: ['No knockout experiment for this condition.'] })]
export function overview(rows = genes, condition = 'basal'): DesignOverview {
  const count = (p: string) => rows.filter(g => g.phenotype === p).length
  return { total_genes: rows.length, mechanistic_genes: rows.length, simulated_genes: rows.filter(g => g.usable_result_count > 0).length,
    essential_genes: count('essential'), growth_defect_genes: count('growth_defect'), neutral_genes: count('neutral'), unknown_genes: count('unknown'), genes: rows,
    condition, genes_with_experiments: rows.filter(g => g.experiment_id != null).length, genes_with_usable_results: rows.filter(g => g.usable_result_count > 0).length,
    unclassified_genes: count('unknown'), result_coverage_fraction: rows.filter(g => g.usable_result_count > 0).length / rows.length, aggregation_scope: genes[0].aggregation_scope }
}
export function detail(symbol = 'dnaA', experiment = 101, condition = 'basal'): DesignGeneEvidence {
  const summary = gene(symbol, { experiment_id: experiment, source: { ...source, experiment_id: experiment, condition }, ...(experiment === 99 ? { phenotype: 'unknown', evidence_status: 'no_completed_jobs', evidence_gaps: ['No completed jobs in the selected experiment.'] } : {}) })
  return { gene: { id: 1, symbol, ecoli_id: 'EG10001', synonyms: '["geneAlias"]', left_end_pos: 1234, right_end_pos: 5678, direction: '+', rna_ids: '["RNA-1"]',
    category: 'dna_replication', ko_index: 42, is_mechanistic: true, monomer_id: 'MONOMER-1', monomer_name: 'Chromosomal replication initiator', complex_ids: '[]' }, condition, summary,
    experiments: [source, { ...source, experiment_id: 99, name: 'Older draft', usable_results: 0, status: 'draft', experiment_url: '/experiments?experiment=99' }],
    jobs: [{ job_id: 501, seed: 0, status: 'done', termination_reason: '', lineage_terminated: false, result_url: '/results/501', earliest_result_id: 901,
      results: [{ id: 901, job_id: 501, experiment_id: 101, seed: 0, generation: 0, divided: true, division_time_sec: 3600, final_mass_fg: 1234.5,
        growth_rate: 0.0008, doubling_time_min: 45.5, created_at: '', terminated: false, termination_reason: '' }] }], baseline_jobs: [] }
}
export async function mockDesignApi(page: Page, options: { rows?: GeneKOSummary[]; overviewHandler?: (route: Route) => Promise<void>; detailHandler?: (route: Route) => Promise<void> } = {}) {
  await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ json: [] }))
  await mockAssistantApi(page, {})
  await page.route('**/api/conditions', route => route.fulfill({ json: [{ name: 'basal', nutrients: 'minimal' }, { name: 'acetate', nutrients: 'acetate' }] }))
  await page.route('**/api/design/overview*', options.overviewHandler ?? (route => route.fulfill({ json: overview(options.rows) })))
  await page.route('**/api/design/genes/*', options.detailHandler ?? (route => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: detail(decodeURIComponent(url.pathname.split('/').pop()!), Number(url.searchParams.get('experiment_id')) || 101, url.searchParams.get('condition') || 'basal') })
  }))
}
