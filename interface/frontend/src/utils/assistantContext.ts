import type { AAPathway, Gene, GeneDetail, GeneKOSummary, TFRegulation } from '../types'

export const ASSISTANT_TEXT_LIMIT = 500
export const ASSISTANT_GENE_SAMPLE_LIMIT = 25
export const ASSISTANT_EDGE_SAMPLE_LIMIT = 20
export const ASSISTANT_PATHWAY_SAMPLE_LIMIT = 20
export const ASSISTANT_SMALL_SAMPLE_LIMIT = 20

export function truncateText(value: string | null | undefined, limit = ASSISTANT_TEXT_LIMIT): string {
  if (!value) return ''
  return value.length > limit ? value.slice(0, limit) : value
}

export function isTruncated(value: string | null | undefined, limit = ASSISTANT_TEXT_LIMIT): boolean {
  return Boolean(value && value.length > limit)
}

export function summarizeSample<T, U = T>(
  values: readonly T[],
  limit = ASSISTANT_SMALL_SAMPLE_LIMIT,
  mapper?: (value: T) => U,
) {
  const sampleValues = values.slice(0, limit)
  return {
    count: values.length,
    sample: mapper ? sampleValues.map(mapper) : sampleValues,
    truncated: values.length > sampleValues.length,
  }
}

export function summarizeText(value: string | null | undefined, limit = ASSISTANT_TEXT_LIMIT) {
  return {
    text: truncateText(value, limit),
    truncated: isTruncated(value, limit),
  }
}

export function makeAssistantContextKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .map((part) => {
      if (part == null || part === '') return '-'
      return String(part)
    })
    .join('|')
}

export function summarizeGene(gene: Gene | null | undefined) {
  if (!gene) return null
  const lengthBp = gene.left_end_pos != null && gene.right_end_pos != null
    ? Math.abs(gene.right_end_pos - gene.left_end_pos) + 1
    : null
  return {
    id: gene.id,
    symbol: gene.symbol,
    ecoli_id: gene.ecoli_id,
    category: gene.category,
    ko_index: gene.ko_index,
    is_mechanistic: gene.is_mechanistic,
    position: gene.left_end_pos != null && gene.right_end_pos != null
      ? { left: gene.left_end_pos, right: gene.right_end_pos, direction: gene.direction, length_bp: lengthBp }
      : null,
  }
}

export function summarizeGeneDetail(gene: GeneDetail | null | undefined) {
  if (!gene) return null
  const rnaIds = parseJsonList(gene.rna_ids).slice(0, 12)
  const complexIds = parseJsonList(gene.complex_ids).slice(0, 12)
  return {
    ...summarizeGene(gene),
    model_state_ids: {
      rna_ids: rnaIds,
      rna_ids_truncated: parseJsonList(gene.rna_ids).length > rnaIds.length,
      monomer_id: gene.monomer_id,
      monomer_name: gene.monomer_name,
      complex_ids: complexIds,
      complex_ids_truncated: parseJsonList(gene.complex_ids).length > complexIds.length,
    },
    regulation: {
      regulated_by_count: gene.regulated_by.length,
      regulates_count: gene.regulates.length,
      regulated_by_sample: gene.regulated_by.slice(0, ASSISTANT_EDGE_SAMPLE_LIMIT).map(summarizeRegulation),
      regulates_sample: gene.regulates.slice(0, ASSISTANT_EDGE_SAMPLE_LIMIT).map(summarizeRegulation),
    },
  }
}

export function summarizeKOSummary(summary: GeneKOSummary | null | undefined) {
  if (!summary) return null
  return {
    gene_symbol: summary.gene_symbol,
    ko_index: summary.ko_index,
    category: summary.category,
    is_mechanistic: summary.is_mechanistic,
    phenotype: summary.phenotype,
    experiment_id: summary.experiment_id,
    n_completed: summary.n_completed,
    n_seeds: summary.n_seeds,
    divided: summary.divided,
    division_rate: summary.division_rate,
    mean_growth_rate: summary.mean_growth_rate,
    mean_doubling_time_min: summary.mean_doubling_time_min,
  }
}

export function summarizeAAPathway(pathway: AAPathway | null | undefined) {
  if (!pathway) return null
  const enzymes = parseList(pathway.enzymes).slice(0, 12)
  const reverseEnzymes = parseList(pathway.reverse_enzymes).slice(0, 12)
  return {
    amino_acid: pathway.amino_acid,
    enzymes,
    enzymes_truncated: parseList(pathway.enzymes).length > enzymes.length,
    reverse_enzymes: reverseEnzymes,
    reverse_enzymes_truncated: parseList(pathway.reverse_enzymes).length > reverseEnzymes.length,
    kcat: pathway.kcat,
    ki_lower: pathway.ki_lower,
    ki_upper: pathway.ki_upper,
    upstream_aas: parseObjectKeys(pathway.upstream_aas).slice(0, 12),
    downstream_aas: parseObjectKeys(pathway.downstream_aas).slice(0, 12),
    notes: truncateText(pathway.notes),
    notes_truncated: isTruncated(pathway.notes),
  }
}

export function summarizeRegulation(edge: TFRegulation) {
  return {
    tf: edge.tf ?? null,
    target: edge.target ?? null,
    log2fc: edge.log2fc,
    type: edge.type,
  }
}

export function parseJsonList(value: string): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => (typeof item === 'string' ? [item] : []))
    }
  } catch {
    // Fall through to tolerant flat-file parsing.
  }
  return parseList(value)
}

export function parseList(value: string): string[] {
  return value
    .replace(/[\[\]"']/g, '')
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !['none', 'nan', 'null', '{}'].includes(item.toLowerCase()))
}

export function parseObjectKeys(value: string): string[] {
  if (!value || value.trim() === '{}') return []
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed)
    }
  } catch {
    return []
  }
  return []
}

export function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}
