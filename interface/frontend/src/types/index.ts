export interface Gene {
  id: number
  ecoli_id: string
  symbol: string
  synonyms: string
  left_end_pos: number | null
  right_end_pos: number | null
  direction: string | null
  category: string
  ko_index: number
  is_mechanistic: boolean
}

export interface GeneDetail extends Gene {
  rna_ids: string
  regulated_by: TFRegulation[]
  regulates: TFRegulation[]
}

export interface TFRegulation {
  tf?: string
  target?: string
  log2fc: number
  type: string
}

export interface GeneSearchResult {
  genes: Gene[]
  total: number
  page: number
  page_size: number
}

export interface CategoryCount {
  category: string
  count: number
}

export interface TFNode {
  symbol: string
  target_count: number
  targets: { target: string; log2fc: number; type: string }[]
}

export interface TFNetwork {
  tfs: TFNode[]
  total_edges: number
}

export interface AAPathway {
  amino_acid: string
  enzymes: string
  reverse_enzymes: string
  kcat: number | null
  ki_lower: number | null
  ki_upper: number | null
  upstream_aas: string
  downstream_aas: string
  notes: string
}

export interface Condition {
  name: string
  nutrients: string
  doubling_time: number | null
}

export interface Timeline {
  name: string
  definition: string
}

export interface Variant {
  name: string
  docstring: string
  filename: string
}

export interface VariantDetail extends Variant {
  parameter_count: number | null
  parameter_hints: {
    index_meaning?: string
    index_range?: [number, number]
    supports_gene_lookup?: boolean
  }
}

export interface Experiment {
  id: number
  name: string
  description: string
  variant_type: string
  variant_index: number
  condition: string
  timeline: string
  sim_params: string
  status: string
  created_at: string
  updated_at: string
  gene_symbol: string
  batch_id: string
}

export interface ExperimentCreate {
  name: string
  description?: string
  variant_type: string
  variant_index?: number
  condition?: string
  timeline?: string
  sim_params?: string
  gene_symbol?: string
}

// --- Batch experiment creation ---

export interface BatchExperimentItem {
  name?: string
  description?: string
  variant_type?: string
  variant_index?: number
  condition?: string
  timeline?: string
  sim_params?: string
  gene_symbol?: string
}

export interface BatchRequest {
  experiments?: BatchExperimentItem[]
  screen?: string
  condition?: string
  timeline?: string
  sim_params?: string
  description?: string
}

export interface BatchResponse {
  batch_id: string
  created: number
  experiment_ids: number[]
  skipped: number
  skipped_genes: string[]
}

export interface BatchSummary {
  batch_id: string
  name: string
  created_at: string
  total: number
  draft: number
  queued: number
  running: number
  done: number
  failed: number
}

export interface BatchDetail extends BatchSummary {
  experiments: Experiment[]
}

export interface BatchRunResponse {
  batch_id: string
  queued: number
  skipped: number
  total_jobs: number
  message: string
}

// --- Simulation jobs ---

export interface SimulationJob {
  id: number
  experiment_id: number
  status: string
  phase: string
  sim_dir: string
  log_tail: string
  started_at: string
  finished_at: string
  error_message: string
  created_at: string
  variant_type: string
  variant_index: number
  condition: string
  seed: number
  generations: number
  timeline: string
}

export interface FailedJobSummary {
  id: number
  experiment_id: number
  experiment_name: string
  gene_symbol: string
  variant_type: string
  variant_index: number
  condition: string
  seed: number
  phase: string
  error_message: string
  started_at: string
  finished_at: string
  created_at: string
}

export interface SimulationResult {
  id: number
  job_id: number
  experiment_id: number
  seed: number
  generation: number
  division_time_sec: number | null
  final_mass_fg: number | null
  growth_rate: number | null
  doubling_time_min: number | null
  divided: boolean
  created_at: string
}

export interface RunResponse {
  job_ids: number[]
  message: string
}

export interface RunJobRequest {
  condition?: string
  seeds?: number
  generations?: number
}

// --- Results visualization ---

export interface TimeseriesPoint {
  time: number
  value: number
}

export interface TimeseriesData {
  label: string
  unit: string
  points: TimeseriesPoint[]
}

export interface ResultsSummary {
  job_id: number
  seed: number
  generation: number
  division_time_sec: number | null
  final_mass_fg: number | null
  growth_rate: number | null
  doubling_time_min: number | null
}

export interface ResultsResponse {
  summary: ResultsSummary[]
  timeseries: Record<string, TimeseriesData[]>
}

// --- Experiment aggregation ---

export interface AggregatedMetric {
  mean: number | null
  std: number | null
  ci_lower: number | null
  ci_upper: number | null
  n: number
  values: (number | null)[]
}

export interface SeedJobSummary {
  job_id: number
  seed: number
  status: string
  division_time_sec: number | null
  final_mass_fg: number | null
  growth_rate: number | null
  doubling_time_min: number | null
}

export interface ExperimentAggregation {
  experiment_id: number
  experiment_name: string
  variant_type: string
  variant_index: number
  condition: string
  gene_symbol: string
  total_seeds: number
  completed_seeds: number
  failed_seeds: number
  division_rate: string
  division_time: AggregatedMetric
  final_mass: AggregatedMetric
  growth_rate: AggregatedMetric
  doubling_time: AggregatedMetric
  seeds: SeedJobSummary[]
}

// --- ML Feature extraction ---

export interface FeatureRow {
  experiment_id: number
  experiment_name: string
  job_id: number
  gene_symbol: string
  ko_index: number
  category: string
  is_mechanistic: boolean
  variant_type: string
  variant_index: number
  condition: string
  seed: number
  divided: boolean
  division_time_sec: number | null
  final_mass_fg: number | null
  growth_rate: number | null
  doubling_time_min: number | null
}

export interface FeatureExtractionResponse {
  total_rows: number
  total_experiments: number
  total_genes: number
  columns: string[]
  rows: FeatureRow[]
}

// --- Machine Learning ---

export interface TrainRequest {
  algorithm: string
  target: string
  condition: string
  variant_type: string
  mechanistic_only: boolean
  test_fraction: number
  n_estimators: number
  max_depth: number | null
  random_state: number
}

export interface ConfusionMatrix {
  tp: number
  fp: number
  tn: number
  fn: number
}

export interface FeatureImportanceItem {
  feature: string
  importance: number
  gene_symbol: string
  category: string
}

export interface ClassificationMetrics {
  accuracy: number
  precision: number
  recall: number
  f1: number
  auc_roc: number | null
  confusion: ConfusionMatrix
}

export interface RegressionMetrics {
  r2: number
  rmse: number
  mae: number
  mape: number | null
}

export interface TrainResponse {
  model_id: string
  algorithm: string
  target: string
  task_type: string
  n_samples: number
  n_train: number
  n_test: number
  n_features: number
  training_time_sec: number
  classification: ClassificationMetrics | null
  regression: RegressionMetrics | null
  feature_importances: FeatureImportanceItem[]
  cross_val_scores: number[]
  cross_val_mean: number | null
  cross_val_std: number | null
}

export interface DataSummary {
  total_experiments: number
  total_completed_jobs: number
  total_genes: number
  mechanistic_genes: number
  divided_count: number
  not_divided_count: number
  conditions: string[]
  variant_types: string[]
}

// --- Genome Design ---

export interface GeneKOSummary {
  gene_symbol: string
  ko_index: number
  category: string
  is_mechanistic: boolean
  experiment_id: number | null
  n_seeds: number
  n_completed: number
  divided: boolean | null
  division_rate: string | null
  mean_division_time_min: number | null
  mean_growth_rate: number | null
  mean_doubling_time_min: number | null
  mean_final_mass_fg: number | null
  phenotype: 'essential' | 'growth_defect' | 'neutral' | 'unknown'
}

export interface DesignOverview {
  total_genes: number
  mechanistic_genes: number
  simulated_genes: number
  essential_genes: number
  growth_defect_genes: number
  neutral_genes: number
  unknown_genes: number
  genes: GeneKOSummary[]
}

export interface EssentialityStats {
  category: string
  total: number
  essential: number
  growth_defect: number
  neutral: number
  unknown: number
  essential_pct: number
}

// --- Multi-experiment comparison ---

export interface ComparisonMetric {
  mean: number | null
  std: number | null
  n: number
}

export interface ComparisonExperiment {
  experiment_id: number
  experiment_name: string
  gene_symbol: string
  variant_type: string
  variant_index: number
  condition: string
  is_wildtype: boolean
  total_seeds: number
  completed_seeds: number
  divided_seeds: number
  division_time_min: ComparisonMetric
  final_mass_fg: ComparisonMetric
  growth_rate: ComparisonMetric
  doubling_time_min: ComparisonMetric
}

export interface ComparisonDelta {
  experiment_id: number
  gene_symbol: string
  division_time_pct: number | null
  final_mass_pct: number | null
  growth_rate_pct: number | null
  doubling_time_pct: number | null
}

export interface WildtypeSuggestion {
  condition: string
  variant_type: string
  variant_index: number
  message: string
  recommended_seeds: number
}

export interface ComparisonResponse {
  experiments: ComparisonExperiment[]
  wildtype: ComparisonExperiment | null
  wildtype_suggestion: WildtypeSuggestion | null
  deltas: ComparisonDelta[]
}

// --- Molecule explorer ---

export interface MoleculeTypeInfo {
  molecule_type: string
  count: number
  total_ids: number
  ids: string[]
  columns: string[]
}

export interface MoleculeListResponse {
  job_id: number
  available_types: MoleculeTypeInfo[]
}

export interface MoleculeIdsResponse {
  molecule_type: string
  count: number
  ids: string[]
}

export interface MoleculeTimeseriesPoint {
  time: number
  value: number
}

export interface MoleculeTimeseries {
  molecule_id: string
  molecule_type: string
  unit: string
  generation: number
  seed: number
  points: MoleculeTimeseriesPoint[]
}

export interface MoleculeTimeseriesResponse {
  job_id: number
  molecule_type: string
  molecules: MoleculeTimeseries[]
}
