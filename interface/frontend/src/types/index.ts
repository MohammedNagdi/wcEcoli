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
  monomer_id: string | null
  monomer_name: string | null
  complex_ids: string             // JSON array of complex IDs
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
  targets: { target: string; log2fc: number; log2fc_std?: number | null; type: string }[]
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

export interface MediaRecipe {
  id: number
  media_id: string          // key used in timeline event strings, e.g. "minimal_acetate"
  base_media: string        // base stock, e.g. "MIX0-57"
  added_media: string       // supplemental stock, e.g. "5X_supplement_EZ"
  ingredients: string       // raw string like '["ACETATE"]'
}

export interface UserTimeline {
  id: number
  name: string
  definition: string        // raw event string e.g. "0 minimal, 1200 minimal_acetate"
  created_at: string
}

export type BuilderDraftSection = 'media' | 'mediaRecipe' | 'condition' | 'tfCondition' | 'timeline'

export interface BuilderDraft {
  id: number
  section: BuilderDraftSection
  name: string
  payload: Record<string, unknown>
  status: string
  created_at: string
  updated_at: string
  published_at: string
  published_name: string
}

export interface BuilderDraftCollection {
  media: BuilderDraft[]
  mediaRecipe: BuilderDraft[]
  condition: BuilderDraft[]
  tfCondition: BuilderDraft[]
  timeline: BuilderDraft[]
}

export interface BuilderPublishPreviewChange {
  file: string
  action: string
  rows: string[]
}

export interface BuilderPublishPreview {
  section: BuilderDraftSection
  draft_id: number
  draft_name: string
  changes: BuilderPublishPreviewChange[]
  warnings: string[]
}

export interface MediaStockRow {
  molecule_id: string
  concentration: string
}

export interface MediaStock {
  name: string
  rows: MediaStockRow[]
}

export interface EnvironmentMolecule {
  molecule_id: string
  exchange_molecule_location: string
  formula_weight: string
}

export interface MediaRecipeRecord {
  media_id: string
  base_media: string
  base_media_volume: string
  added_media: string
  added_media_volume: string
  ingredients: string
  ingredients_weight: string
  ingredients_counts: string
  ingredients_volume: string
}

export interface ConditionRecord {
  condition: string
  nutrients: string
  genotype_perturbations: string
  doubling_time: string
  active_tfs: string
  inactive_tfs: string
}

export interface TfConditionRecord {
  tf: string
  active_tf: string
  active_nutrients: string
  active_genotype_perturbations: string
  inactive_nutrients: string
  inactive_genotype_perturbations: string
  tf_type: string
}

export interface TimelineRecord {
  timeline: string
  events: string
}

export interface ConditionCatalog {
  media_stocks: MediaStock[]
  environment_molecules: EnvironmentMolecule[]
  media_recipes: MediaRecipeRecord[]
  conditions: ConditionRecord[]
  tf_conditions: TfConditionRecord[]
  timelines: TimelineRecord[]
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
    min_valid_index?: number
    max_valid_index?: number
    max_exact_index?: number
    index_options?: string[]
    control_period?: number
    condition_stride?: number
    condition_count?: number
    valid_remainder_range?: [number, number]
    tf_names?: string[]
    tf_state_details?: Record<string, {
      active_molecule?: string
      active_nutrients?: string
      active_perturbations?: string
      inactive_nutrients?: string
      inactive_perturbations?: string
      tf_type?: string
    }>
    condition_names?: string[]
    supports_gene_lookup?: boolean
    hide_index?: boolean
    timeline_behavior?: 'composer' | 'internal_override' | 'internal_conditional_override'
    timeline_notice?: string
    environment_lock?: 'fixed' | 'conditional' | 'tf_state'
    fixed_condition?: string
    fixed_timeline?: string
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
  gene_symbols?: string[]
  include_wildtype?: boolean
}

// --- Batch experiment creation ---

export interface BatchRecord {
  variant_index?: number
  gene_symbol?: string
  gene_symbols?: string[]
  timeline?: string
  seed: number
  generations: number
  sim_params?: string
}

export interface BatchRequest {
  name: string
  description?: string
  variant_type: string
  include_wildtype?: boolean
  records: BatchRecord[]
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
  targets: string[]
  variant_types: string[]
  conditions: string[]
  timelines: string[]
  draft: number
  queued: number
  running: number
  done: number
  failed: number
  cancelled: number
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

export interface BatchControlResponse {
  batch_id: string
  cancelled: number
  resumed: number
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
  seeds?: number | number[]
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

// --- Wildtype delta (single experiment) ---

export interface WildtypeDelta {
  has_wildtype: boolean
  wt_experiment_id: number | null
  wt_status: string | null
  division_time_pct: number | null
  final_mass_pct: number | null
  growth_rate_pct: number | null
  doubling_time_pct: number | null
  wt_division_time_min: number | null
  wt_final_mass_fg: number | null
  wt_growth_rate: number | null
  wt_doubling_time_min: number | null
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

export interface ResultStateVariable {
  id: string
  molecule_type: string
  display_type: string
  role: string
  gene_symbol: string
  gene_name: string | null
  available: boolean
  final_value: number | null
  wt_final_value: number | null
  delta: number | null
  delta_pct: number | null
  rank_score: number | null
}

export interface ResultStateNode {
  id: string
  label: string
  node_type: string
  role: string
  available: boolean
}

export interface ResultStateEdge {
  source: string
  target: string
  edge_type: string
  label: string
  log2fc: number | null
  regulation: string
}

export interface ResultStateExplorerResponse {
  job_id: number
  wt_job_id: number | null
  focus_gene: string
  variables: ResultStateVariable[]
  nodes: ResultStateNode[]
  edges: ResultStateEdge[]
  unavailable_count: number
}

export interface StoichiometryMolecule {
  id: string
  coefficient: number
  role: 'reactant' | 'product'
  available_types: string[]
}

export interface StoichiometryReaction {
  id: string
  direction: string
  catalysts: string[]
  reactants: StoichiometryMolecule[]
  products: StoichiometryMolecule[]
  reaction_flux_available: boolean
}

export interface StoichiometryNeighborhoodResponse {
  job_id: number
  focus_gene: string
  enzyme_ids: string[]
  reactions: StoichiometryReaction[]
  note: string
}

// --- Local platform and assistant scaffolding ---

export interface ArtifactBootstrapStatus {
  enabled: boolean
  source: string | null
  repository: string | null
  role: string
}

export interface DistributionStatus {
  mode: string
  runtime: string
  requires_hosted_backend: boolean
  artifact_bootstrap: ArtifactBootstrapStatus
  paths: Record<string, string>
  notes: string[]
}

export interface ProviderStatus {
  provider_id: string
  label: string
  category: string
  configured: boolean
  health: string
  configuration_hint: string
  endpoint_configured: boolean
  secret_configured: boolean
  runtime_supported: boolean
  default_model: string
  selected_for_runtime: boolean
}

export interface ProviderLayerStatus {
  mode: string
  configured_provider_count: number
  selected_provider_id: string
  active_runtime_provider_id: string
  active_runtime_model: string
  runtime_ready: boolean
  runtime_issue: string
  providers: ProviderStatus[]
  notes: string[]
}

export interface AssistantProviderConfig {
  provider_id: string
  label: string
  category: string
  configured: boolean
  secret_configured: boolean
  endpoint_configured: boolean
  endpoint_url: string
  model: string
  is_active: boolean
  runtime_supported: boolean
  default_model: string
  requires_secret: boolean
  requires_endpoint: boolean
  configuration_hint: string
  updated_at: string
}

export interface AssistantProviderConfigUpdate {
  api_key?: string
  endpoint_url?: string
  model?: string
  label?: string
  make_active?: boolean
}

export interface OllamaModel {
  name: string
  model: string
  family: string
  parameter_size: string
  quantization_level: string
  size: number | null
  modified_at: string
}

export interface OllamaModelList {
  endpoint_url: string
  reachable: boolean
  models: OllamaModel[]
  error: string
}

export interface AssistantHarnessStatus {
  state: string
  provider_required: boolean
  provider_configured: boolean
  tool_execution_enabled: boolean
  tool_preview_enabled: boolean
  execution_enabled_tools: string[]
  side_effect_execution_enabled: boolean
  db_persistence_enabled: boolean
  confirmation_required_for: string[]
  context_contract: string[]
  visible_artifacts: string[]
  tool_registry: AssistantToolSpec[]
  notes: string[]
}

export interface PlatformStatus {
  distribution: DistributionStatus
  providers: ProviderLayerStatus
  assistant: AssistantHarnessStatus
}

export interface AssistantToolSpec {
  name: string
  label: string
  description: string
  status: string
  requires_confirmation: boolean
  side_effect: boolean
  permission_tier?: 'read_only' | 'draft' | 'queue' | 'publish_destructive'
  argument_schema: Record<string, unknown>
  result_schema: Record<string, unknown>
}

export interface AssistantContext {
  route: string
  selected_gene: string | null
  selected_experiment: number | null
  selected_job: number | null
  selected_result: number | null
  selected_condition: string | null
  selected_variant_type: string | null
  selected_builder_section: string | null
  assistant_surface: string
}

export interface AssistantConversation {
  id: number
  title: string
  assistant_surface: string
  status: string
  created_at: string
  updated_at: string
}

export interface AssistantMessage {
  id: number
  conversation_id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  context: AssistantContext
  status: string
  created_at: string
}

export interface AssistantExchange {
  conversation: AssistantConversation
  user_message: AssistantMessage
  assistant_message: AssistantMessage
  provenance_id: number
  pending_confirmations: number[]
  tool_calls: number[]
  proposals: AssistantToolCall[]
}

export interface AssistantConfirmation {
  id: number
  conversation_id: number | null
  tool_call_id: number | null
  action: string
  status: string
  payload: Record<string, unknown>
  note: string
  created_at: string
  resolved_at: string
}

export interface AssistantToolCall {
  id: number
  conversation_id: number | null
  message_id: number | null
  tool_name: string
  status: string
  arguments: Record<string, unknown>
  result: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AssistantProvenance {
  id: number
  conversation_id: number | null
  message_id: number | null
  provider_id: string
  model: string
  prompt_hash: string
  request: Record<string, unknown>
  response: Record<string, unknown>
  created_at: string
}

export interface AssistantToolPreview {
  tool_name: string
  valid: boolean
  requires_confirmation: boolean
  side_effect: boolean
  execution_enabled: boolean
  normalized_arguments: Record<string, unknown>
  preview: Record<string, unknown>
  warnings: string[]
  errors: string[]
}

export interface AssistantToolExecution {
  tool_name: string
  executed: boolean
  status: string
  requires_confirmation: boolean
  confirmation_id: number | null
  tool_call_id: number | null
  provenance_id: number | null
  normalized_arguments: Record<string, unknown>
  result: Record<string, unknown>
  warnings: string[]
  errors: string[]
}
