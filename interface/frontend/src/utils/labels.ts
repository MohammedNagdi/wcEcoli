/**
 * Human-readable labels and formatting utilities used across the UI.
 */

// --- Gene categories ---

export const CATEGORY_LABELS: Record<string, string> = {
  amino_acid_biosynthesis: 'Amino acid biosynthesis',
  cell_division: 'Cell division',
  cell_envelope: 'Cell envelope',
  central_carbon: 'Central carbon metabolism',
  cofactor_biosynthesis: 'Cofactor biosynthesis',
  dna_replication: 'DNA replication & repair',
  energy: 'Energy metabolism',
  lipid_metabolism: 'Lipid metabolism',
  mobile_element: 'Mobile genetic elements',
  motility: 'Motility & chemotaxis',
  nucleotide_metabolism: 'Nucleotide metabolism',
  other: 'Other',
  regulation: 'Transcriptional regulation',
  rrna: 'Ribosomal RNA',
  stress_response: 'Stress response',
  transcription: 'Transcription machinery',
  translation: 'Translation & ribosome',
  transport: 'Membrane transport',
  trna: 'Transfer RNA',
  uncharacterized: 'Uncharacterized',
}

export function categoryLabel(raw: string): string {
  return CATEGORY_LABELS[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// --- Variant types ---

export const VARIANT_LABELS: Record<string, string> = {
  gene_knockout: 'Gene knockout',
  multi_gene_knockout: 'Multi-gene knockout',
  condition: 'Growth condition',
  timelines: 'Timeline shift',
  wildtype: 'Wildtype (control)',
  ppgpp_conc: 'ppGpp concentration',
  ppgpp_limitations: 'ppGpp limitations',
  ppgpp_limitations_ribosome: 'ppGpp limitations (ribosome)',
  add_one_aa: 'Add amino acid',
  remove_one_aa: 'Remove amino acid',
  add_one_aa_shift: 'Add AA (shift)',
  remove_one_aa_shift: 'Remove AA (shift)',
  remove_aas_shift: 'Remove AAs (shift)',
  aa_synthesis_ko: 'AA synthesis KO',
  aa_synthesis_ko_shift: 'AA synthesis KO (shift)',
  aa_synthesis_sensitivity: 'AA synthesis sensitivity',
  aa_uptake_sensitivity: 'AA uptake sensitivity',
  remove_aa_inhibition: 'Remove AA inhibition',
  rrna_operon_knockout: 'rRNA operon KO',
  rrna_location: 'rRNA location',
  rrna_orientation: 'rRNA orientation',
  metabolism_kinetic_objective_weight: 'Metabolism kinetic weight',
  metabolism_secretion_penalty: 'Metabolism secretion penalty',
  tf_activity: 'TF activity',
  time_step: 'Time step',
  mene_params: 'menE parameters',
  new_gene_internal_shift: 'New gene (internal shift)',
  sinusoidal_media: 'Sinusoidal media',
  param_sensitivity: 'Parameter sensitivity',
  apply_variant: 'Apply variant',
  template: 'Template',
  template_internal_shift: 'Template (internal shift)',
}

export function variantLabel(raw: string): string {
  return VARIANT_LABELS[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// --- Experiment status ---

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  claimed: 'Claimed',
  waiting_parca: 'Waiting for Parca',
  running_parca: 'Running (Parca)',
  running_sim: 'Running (Sim)',
  ingesting: 'Ingesting results',
  cancelling: 'Stopping',
  recovering: 'Recovering',
  done: 'Complete',
  failed: 'Failed',
  cancelled: 'Stopped',
}

export function statusLabel(raw: string): string {
  return STATUS_LABELS[raw] ?? raw
}
