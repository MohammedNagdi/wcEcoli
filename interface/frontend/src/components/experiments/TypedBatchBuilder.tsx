import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createBatchExperiments, getConditions, getGenes, getMediaRecipes, getVariantDetail, getVariants } from '../../api/client'
import type { Condition, Gene, MediaRecipe, Variant, VariantDetail } from '../../types'
import { HelpTip } from '../common/HelpTip'
import { categoryLabel, variantLabel } from '../../utils/labels'
import { TimelineComposer } from './TimelineComposer'

type TimelineChoice = {
  id: string
  label: string
  value: string
  definition: string
  custom: boolean
}

type PreviewRecord = {
  row_id: string
  variant_index: number
  gene_symbol?: string
  gene_symbols?: string[]
  timeline?: string
  timeline_label?: string
  seed: number
  generations: number
  sim_params: string
  index_hint?: string
}

type RowOverride = Partial<Pick<PreviewRecord, 'timeline' | 'timeline_label' | 'seed'>>

type ParseResult = {
  values: number[]
  error: string
}

type IndexGuide = {
  current: string
  invalid: boolean
  items: string[]
}

type VariationItem = {
  variant_index: number
  gene_symbol?: string
  gene_symbols?: string[]
  index_hint?: string
}

type VariantGroupId = 'core' | 'nutrient' | 'regulation' | 'advanced'

type VariantGroup = {
  id: VariantGroupId
  label: string
  description: string
  variants: string[]
  advanced?: boolean
}

const INTERNAL_VARIANTS = new Set([
  'apply_variant',
  'template',
  'template_internal_shift',
])

const VARIANT_GROUPS: VariantGroup[] = [
  {
    id: 'core',
    label: 'Core workflows',
    description: 'Controls, gene knockouts, static growth conditions, and user-composed media timelines.',
    variants: ['wildtype', 'gene_knockout', 'multi_gene_knockout', 'condition', 'timelines'],
  },
  {
    id: 'nutrient',
    label: 'Nutrient and media changes',
    description: 'Amino-acid additions/removals and dynamic media protocols with clear nutrient-level interpretation.',
    variants: [
      'add_one_aa',
      'remove_one_aa',
      'add_one_aa_shift',
      'remove_one_aa_shift',
      'remove_aas_shift',
      'sinusoidal_media',
    ],
  },
  {
    id: 'regulation',
    label: 'Regulatory state probes',
    description: 'Model-level regulatory state overrides, including TF active/inactive states and fixed ppGpp concentration.',
    variants: ['tf_activity', 'ppgpp_conc'],
  },
  {
    id: 'advanced',
    label: 'Advanced model studies',
    description: 'Parameter sweeps, rRNA architecture tests, and paper-specific model-analysis variants.',
    advanced: true,
    variants: [
      'aa_synthesis_ko',
      'aa_synthesis_ko_shift',
      'aa_synthesis_sensitivity',
      'aa_uptake_sensitivity',
      'remove_aa_inhibition',
      'ppgpp_limitations',
      'ppgpp_limitations_ribosome',
      'rrna_operon_knockout',
      'rrna_location',
      'rrna_orientation',
      'metabolism_kinetic_objective_weight',
      'metabolism_secretion_penalty',
      'mene_params',
      'new_gene_internal_shift',
      'param_sensitivity',
      'time_step',
    ],
  },
]

const VARIANT_TO_GROUP = new Map(
  VARIANT_GROUPS.flatMap((group) => group.variants.map((variant) => [variant, group] as const)),
)

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

function parseIntegerList(input: string, options?: { allowRanges?: boolean; label?: string }): ParseResult {
  const label = options?.label || 'value'
  const text = input.trim()
  if (!text) return { values: [], error: `Enter at least one ${label}.` }

  const values: number[] = []
  const tokens = text.split(',').map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) return { values: [], error: `Enter at least one ${label}.` }

  for (const token of tokens) {
    const rangeMatch = token.match(/^(-?\d+)\s*-\s*(-?\d+)$/)
    if (rangeMatch) {
      if (!options?.allowRanges) {
        return { values: [], error: `Ranges are not supported for ${label}s. Use comma-separated integers.` }
      }

      const start = Number(rangeMatch[1])
      const end = Number(rangeMatch[2])
      if (end < start) return { values: [], error: `Range "${token}" must count upward.` }
      if (end - start > 500) return { values: [], error: `Range "${token}" is too large for preview.` }
      for (let value = start; value <= end; value += 1) values.push(value)
      continue
    }

    if (!/^-?\d+$/.test(token)) {
      return { values: [], error: `"${token}" is not a valid integer ${label}.` }
    }
    values.push(Number(token))
  }

  if (values.some((value) => value < 0)) {
    return { values: [], error: `${label[0].toUpperCase()}${label.slice(1)}s must be zero or greater.` }
  }

  return { values: uniqueSorted(values), error: '' }
}

function findIndexHint(index: number, detail: VariantDetail | null): string | undefined {
  const options = detail?.parameter_hints.index_options || []
  for (const option of options) {
    let match = option.match(/^(-?\d+)\s*:\s*(.+)$/)
    if (match && Number(match[1]) === index) return option

    match = option.match(/^(-?\d+)\s*-\s*(-?\d+)\s*:\s*(.+)$/)
    if (match) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (index >= start && index <= end) return `${index}: ${match[3]}`
    }

    match = option.match(/^(-?\d+)\+\s*:\s*(.+)$/)
    if (match && index >= Number(match[1])) return `${index}: ${match[2]}`
  }

  if (detail?.parameter_hints.index_meaning) {
    return `${index}: ${detail.parameter_hints.index_meaning}`
  }

  return undefined
}

function getMinValidIndex(variantDetail: VariantDetail | null): number | undefined {
  return variantDetail?.parameter_hints.min_valid_index
    ?? variantDetail?.parameter_hints.index_range?.[0]
}

function getMaxValidIndex(variantDetail: VariantDetail | null): number | undefined {
  return variantDetail?.parameter_hints.max_valid_index
    ?? variantDetail?.parameter_hints.index_range?.[1]
}

function getIndexGuide(index: number, variantDetail: VariantDetail | null): IndexGuide | null {
  const items = variantDetail?.parameter_hints.index_options || []
  const minIndex = getMinValidIndex(variantDetail)
  const maxIndex = getMaxValidIndex(variantDetail)
  const outOfRange = (minIndex !== undefined && index < minIndex)
    || (maxIndex !== undefined && index > maxIndex)

  if (outOfRange) {
    const allowedRange = minIndex !== undefined && maxIndex !== undefined
      ? `${minIndex}-${maxIndex}`
      : minIndex !== undefined
        ? `>= ${minIndex}`
        : `<= ${maxIndex}`
    return {
      current: `${index}: not a valid option for this experiment (allowed range ${allowedRange})`,
      invalid: true,
      items,
    }
  }

  const current = findIndexHint(index, variantDetail)
  if (current || items.length > 0 || variantDetail?.parameter_hints.index_meaning) {
    return {
      current: current || `${index}: selected parameter index`,
      invalid: false,
      items: items.length > 0
        ? items
        : variantDetail?.parameter_hints.index_meaning
          ? [variantDetail.parameter_hints.index_meaning]
          : [],
    }
  }

  return null
}

function payloadRecord(record: PreviewRecord) {
  const { row_id, index_hint, timeline_label, ...rest } = record
  return rest
}

function StepBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-[11px] font-semibold text-white">
      {children}
    </span>
  )
}

function StatusChip({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: string
  tone?: 'slate' | 'blue' | 'amber' | 'green'
}) {
  const toneClass = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  }[tone]

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${toneClass}`}>
      <span className="text-slate-500">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  )
}

function TechnicalDetails({
  title = 'Technical details',
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-slate-600 marker:text-slate-400">
        {title}
      </summary>
      <div className="mt-3 text-xs leading-relaxed text-slate-500">
        {children}
      </div>
    </details>
  )
}

export function TypedBatchBuilder() {
  const navigate = useNavigate()
  const [variants, setVariants] = useState<Variant[]>([])
  const [variantDetail, setVariantDetail] = useState<VariantDetail | null>(null)
  const [conditions, setConditions] = useState<Condition[]>([])
  const [mediaRecipes, setMediaRecipes] = useState<MediaRecipe[]>([])
  const [genes, setGenes] = useState<Gene[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('Batch preview')
  const [description, setDescription] = useState('')
  const [variantType, setVariantType] = useState('gene_knockout')
  const [includeWildtype, setIncludeWildtype] = useState(false)
  const [showAdvancedVariants, setShowAdvancedVariants] = useState(false)

  const [geneSearch, setGeneSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [selectedGenes, setSelectedGenes] = useState<Gene[]>([])

  const [variantIndex, setVariantIndex] = useState(0)
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([0])
  const [composedTimelineName, setComposedTimelineName] = useState('timeline_1')
  const [composedTimelineEvents, setComposedTimelineEvents] = useState('')
  const [loadedPresetTimelineName, setLoadedPresetTimelineName] = useState<string | null>(null)
  const [batchTimelines, setBatchTimelines] = useState<TimelineChoice[]>([])
  const [selectedTimelineIds, setSelectedTimelineIds] = useState<string[]>([])

  const [seedText, setSeedText] = useState('0')
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)

  const [removedRows, setRemovedRows] = useState<Set<string>>(new Set())
  const [rowOverrides, setRowOverrides] = useState<Record<string, RowOverride>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      getVariants(),
      getConditions(),
      getMediaRecipes(),
      getGenes({ page_size: 5000 }),
    ]).then(([variantData, conditionData, mediaRecipeData, geneData]) => {
      setVariants(variantData)
      setConditions(conditionData)
      setMediaRecipes(mediaRecipeData)
      setGenes(geneData.genes)
      if (variantData.length > 0 && !variantData.some((variant) => variant.name === variantType)) {
        setVariantType(variantData[0].name)
      }
    }).catch((error) => {
      setLoadError(error instanceof Error ? error.message : 'Failed to load typed batch data')
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!variantType) {
      setVariantDetail(null)
      return
    }
    getVariantDetail(variantType).then(setVariantDetail).catch(() => setVariantDetail(null))
  }, [variantType])

  useEffect(() => {
    setRemovedRows(new Set())
    setRowOverrides({})
  }, [variantType, selectedGenes, selectedIndexes, selectedTimelineIds, batchTimelines, seedText, generations, lengthSec])

  useEffect(() => {
    if (!['gene_knockout', 'multi_gene_knockout'].includes(variantType)) setIncludeWildtype(false)
  }, [variantType])

  useEffect(() => {
    if (!submitError) return
    const timer = setTimeout(() => setSubmitError(null), 5000)
    return () => clearTimeout(timer)
  }, [submitError])

  const categories = useMemo(() => {
    return Array.from(new Set(genes.map((gene) => gene.category))).sort()
  }, [genes])

  const visibleVariantGroups = useMemo(() => {
    return VARIANT_GROUPS
      .filter((group) => showAdvancedVariants || !group.advanced)
      .map((group) => ({
        ...group,
        options: group.variants
          .map((name) => variants.find((variant) => variant.name === name))
          .filter((variant): variant is Variant => variant !== undefined && !INTERNAL_VARIANTS.has(variant.name)),
      }))
      .filter((group) => group.options.length > 0)
  }, [showAdvancedVariants, variants])

  const selectedVariantGroup = variantType ? VARIANT_TO_GROUP.get(variantType) : null

  const filteredGenes = useMemo(() => {
    const term = geneSearch.trim().toLowerCase()
    return genes
      .filter((gene) => gene.ko_index > 0)
      .filter((gene) => !categoryFilter || gene.category === categoryFilter)
      .filter((gene) =>
        !term
        || gene.symbol.toLowerCase().includes(term)
        || gene.ecoli_id.toLowerCase().includes(term)
        || categoryLabel(gene.category).toLowerCase().includes(term)
      )
      .slice(0, 500)
  }, [categoryFilter, geneSearch, genes])

  const selectedGeneSymbols = useMemo(
    () => new Set(selectedGenes.map((gene) => gene.symbol)),
    [selectedGenes],
  )

  const timelineOptions = batchTimelines

  const selectedTimelineChoices = useMemo(() => {
    const byId = new Map(timelineOptions.map((timeline) => [timeline.id, timeline]))
    return selectedTimelineIds
      .map((id) => byId.get(id))
      .filter((timeline): timeline is TimelineChoice => Boolean(timeline))
  }, [selectedTimelineIds, timelineOptions])

  const timelineChoicesForExpansion = selectedTimelineChoices.length > 0
    ? selectedTimelineChoices
    : [{ id: 'no-explicit-timeline', label: 'No explicit timeline', value: '', definition: '', custom: false }]

  const mediaProtocolSummary = selectedTimelineChoices.length === 0
    ? {
        label: 'Static default',
        detail: 'No explicit media protocol is added to generated records.',
        tone: 'slate' as const,
      }
    : selectedTimelineChoices.length === 1
      ? {
          label: '1 protocol',
          detail: selectedTimelineChoices[0].label,
          tone: 'blue' as const,
        }
      : {
          label: `${selectedTimelineChoices.length} protocols`,
          detail: selectedTimelineChoices.map((timeline) => timeline.label).join(', '),
          tone: 'blue' as const,
        }

  const seedParse = useMemo(
    () => parseIntegerList(seedText, { allowRanges: false, label: 'seed' }),
    [seedText],
  )

  const minVariantIndex = getMinValidIndex(variantDetail)
  const maxVariantIndex = getMaxValidIndex(variantDetail)
  const indexGuide = getIndexGuide(variantIndex, variantDetail)

  const generatedRecords = useMemo<PreviewRecord[]>(() => {
    if (!variantType || seedParse.error) return []

    const variationItems: VariationItem[] = variantType === 'gene_knockout'
      ? selectedGenes.map((gene) => ({
          variant_index: gene.ko_index,
          gene_symbol: gene.symbol,
          index_hint: `KO #${gene.ko_index}`,
        }))
      : variantType === 'multi_gene_knockout'
        ? selectedGenes.length >= 2
          ? [{
              variant_index: 0,
              gene_symbols: selectedGenes.map((gene) => gene.symbol),
              index_hint: selectedGenes.map((gene) => `${gene.symbol} KO #${gene.ko_index}`).join(', '),
            }]
          : []
        : selectedIndexes.map((index) => ({
            variant_index: index,
            index_hint: findIndexHint(index, variantDetail),
          }))

    const records: PreviewRecord[] = []
    for (const variation of variationItems) {
      for (const timeline of timelineChoicesForExpansion) {
        for (const seed of seedParse.values) {
          const rowId = [
            variantType,
            variation.variant_index,
            variation.gene_symbols?.join(',') || variation.gene_symbol || '',
            timeline.id,
            seed,
            generations,
            lengthSec,
          ].join('|')

          records.push({
            row_id: rowId,
            variant_index: variation.variant_index,
            gene_symbol: variation.gene_symbol,
            gene_symbols: variation.gene_symbols,
            timeline: timeline.value || undefined,
            timeline_label: timeline.value ? timeline.label : undefined,
            seed,
            generations,
            sim_params: JSON.stringify({ seed, generations, length_sec: lengthSec }),
            index_hint: variation.index_hint,
          })
        }
      }
    }

    return records
  }, [
    generations,
    lengthSec,
    seedParse.error,
    seedParse.values,
    selectedIndexes,
    selectedGenes,
    timelineChoicesForExpansion,
    variantDetail,
    variantType,
  ])

  const previewRecords = useMemo(() => generatedRecords
    .filter((record) => !removedRows.has(record.row_id))
    .map((record) => {
      const override = rowOverrides[record.row_id] || {}
      const seed = override.seed ?? record.seed
      return {
        ...record,
        ...override,
        seed,
        sim_params: JSON.stringify({ seed, generations: record.generations, length_sec: lengthSec }),
      }
    }), [generatedRecords, lengthSec, removedRows, rowOverrides])

  const payload = useMemo(() => ({
    name: name.trim(),
    description: description.trim(),
    variant_type: variantType,
    include_wildtype: ['gene_knockout', 'multi_gene_knockout'].includes(variantType) ? includeWildtype : false,
    records: previewRecords.map(payloadRecord),
  }), [description, includeWildtype, name, previewRecords, variantType])

  const formErrors = useMemo(() => {
    const errors: string[] = []
    if (!name.trim()) errors.push('Enter a batch name.')
    if (!variantType) errors.push('Select one experiment type.')
    if (variantType === 'gene_knockout' && selectedGenes.length === 0) {
      errors.push('Add at least one gene.')
    }
    if (variantType === 'multi_gene_knockout' && selectedGenes.length < 2) {
      errors.push('Add at least two genes.')
    }
    if (!['gene_knockout', 'multi_gene_knockout'].includes(variantType) && selectedIndexes.length === 0) errors.push('Add at least one parameter index.')
    if (seedParse.error) errors.push(seedParse.error)
    if (previewRecords.length === 0) errors.push('Generate at least one preview record.')
    return errors
  }, [name, previewRecords.length, seedParse.error, selectedGenes.length, selectedIndexes.length, variantType])

  function toggleGene(gene: Gene) {
    if (gene.ko_index < 1) return
    setSelectedGenes((current) => {
      if (current.some((item) => item.symbol === gene.symbol)) {
        return current.filter((item) => item.symbol !== gene.symbol)
      }
      return [...current, gene].sort((a, b) => a.symbol.localeCompare(b.symbol))
    })
  }

  function toggleFilteredGenes() {
    const allSelected = filteredGenes.length > 0 && filteredGenes.every((gene) => selectedGeneSymbols.has(gene.symbol))
    setSelectedGenes((current) => {
      const bySymbol = new Map(current.map((gene) => [gene.symbol, gene]))
      for (const gene of filteredGenes) {
        if (allSelected) bySymbol.delete(gene.symbol)
        else bySymbol.set(gene.symbol, gene)
      }
      return Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol))
    })
  }

  function addVariantIndex() {
    setSelectedIndexes((current) => {
      if (current.includes(variantIndex)) return current
      return [...current, variantIndex].sort((a, b) => a - b)
    })
  }

  function removeVariantIndex(index: number) {
    setSelectedIndexes((current) => current.filter((item) => item !== index))
  }

  function addComposedTimeline() {
    const events = composedTimelineEvents.trim()
    if (!events) return
    const name = composedTimelineName.trim() || `timeline_${batchTimelines.length + 1}`
    const id = `composed:${Date.now()}:${batchTimelines.length}`
    const timeline = {
      id,
      label: name,
      value: events,
      definition: events,
      custom: false,
    }
    setBatchTimelines((current) => [...current, timeline])
    setSelectedTimelineIds((current) => [...current, id])
    if (!loadedPresetTimelineName) {
      setComposedTimelineName(`timeline_${batchTimelines.length + 2}`)
    }
  }

  function removeTimeline(id: string) {
    setSelectedTimelineIds((current) => current.filter((item) => item !== id))
  }

  function updateRow(rowId: string, patch: RowOverride) {
    setRowOverrides((current) => ({
      ...current,
      [rowId]: {
        ...current[rowId],
        ...patch,
      },
    }))
  }

  async function submitBatch() {
    if (formErrors.length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await createBatchExperiments(payload)
      const params = new URLSearchParams({
        view: 'batches',
        batch: response.batch_id,
        createdBatchName: name.trim(),
        createdBatchCount: String(response.created),
      })
      navigate(`/experiments?${params.toString()}`)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to create batch')
    } finally {
      setSubmitting(false)
    }
  }

  const variationCount = variantType === 'gene_knockout'
    ? selectedGenes.length
    : variantType === 'multi_gene_knockout'
      ? (selectedGenes.length >= 2 ? 1 : 0)
      : selectedIndexes.length
  const timelineCount = timelineChoicesForExpansion.length
  const seedCount = seedParse.values.length
  const removedCount = generatedRecords.length - previewRecords.length
  const editedCount = Object.keys(rowOverrides).length

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-brand-600" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1260px] px-1 pb-10">
      <Link
        to="/experiments"
        className="mb-4 inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-800"
      >
        ← Back to experiments
      </Link>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Batch builder</h1>
          <p className="mt-1 text-sm text-gray-500">
            Choose one experiment type, define record variations, media protocols, and run size.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Experiment" value={variantType ? variantLabel(variantType) : 'Select type'} tone={variantType ? 'green' : 'amber'} />
          <StatusChip label="Media protocol" value={mediaProtocolSummary.label} tone={mediaProtocolSummary.tone} />
          <StatusChip label="Records" value={String(previewRecords.length)} tone={previewRecords.length > 0 ? 'green' : 'amber'} />
        </div>
      </header>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {submitError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {submitError}
        </div>
      )}

      {formErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {formErrors[0]}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
      <div className="space-y-4">
        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <StepBadge>1</StepBadge>
            Batch details
            <HelpTip text="These values are submitted with the generated batch records." />
          </h2>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Batch name</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Description</label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                placeholder="Screen purpose or notes"
                className="w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
          </div>
          {['gene_knockout', 'multi_gene_knockout'].includes(variantType) && (
            <label className="mt-4 flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm">
              <input
                type="checkbox"
                checked={includeWildtype}
                onChange={(event) => setIncludeWildtype(event.target.checked)}
                className="mt-0.5 rounded border-gray-300"
              />
              <span>
                <span className="block font-medium text-gray-800">Include wildtype controls</span>
                <span className="block text-xs text-gray-500">
                  Creates matching wildtype records for each unique timeline and seed combination.
                </span>
              </span>
            </label>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <StepBadge>2</StepBadge>
            Experiment type
            <HelpTip text="A typed batch is homogeneous: all records use this one variant type." />
          </h2>
          <select
            value={variantType}
            onChange={(event) => {
              setVariantType(event.target.value)
              setSelectedGenes([])
              setVariantIndex(0)
              setSelectedIndexes([0])
            }}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          >
            {visibleVariantGroups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.options.map((variant) => (
                  <option key={variant.name} value={variant.name}>{variantLabel(variant.name)}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="mt-3 flex items-start justify-between gap-3">
            <div>
              {selectedVariantGroup ? (
                <>
                  <p className="text-xs font-medium text-gray-700">{selectedVariantGroup.label}</p>
                  <p className="mt-1 text-xs text-gray-500">{selectedVariantGroup.description}</p>
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  Choose a user-facing workflow. Internal helpers and empty template variants are hidden.
                </p>
              )}
            </div>
            <label className="inline-flex shrink-0 items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={showAdvancedVariants}
                onChange={(event) => setShowAdvancedVariants(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              Advanced studies
            </label>
          </div>
          {variantDetail && (
            <div className="mt-3">
              <TechnicalDetails title="Model notes">
                <p className="whitespace-pre-line">
                {variantDetail.docstring || 'No variant documentation available.'}
              </p>
              {variantDetail.parameter_hints.index_meaning && (
                <p className="mt-2 border-t border-slate-200 pt-2">
                  Index: {variantDetail.parameter_hints.index_meaning}
                </p>
              )}
              </TechnicalDetails>
            </div>
          )}
        </section>

        {['gene_knockout', 'multi_gene_knockout'].includes(variantType) ? (
          <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <StepBadge>3</StepBadge>
              {variantType === 'multi_gene_knockout' ? 'Target gene set' : 'Gene variations'}
              <HelpTip text={variantType === 'multi_gene_knockout'
                ? 'Add genes that resolve to at least two unique wcEcoli knockout targets. The selected targets run together as one combined knockout.'
                : 'Add one or more genes. Each selected gene is expanded against the selected timelines and seeds.'} />
            </h2>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={geneSearch}
                onChange={(event) => setGeneSearch(event.target.value)}
                placeholder="Search gene..."
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category} value={category}>{categoryLabel(category)}</option>
                ))}
              </select>
            </div>
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={toggleFilteredGenes}
                className="text-xs font-medium text-brand-600 hover:text-brand-800"
              >
                {filteredGenes.length > 0 && filteredGenes.every((gene) => selectedGeneSymbols.has(gene.symbol))
                  ? 'Deselect shown'
                  : 'Select shown'}
              </button>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-400">{selectedGenes.length} selected · {filteredGenes.length} shown</span>
                <button
                  type="button"
                  onClick={() => setSelectedGenes([])}
                  className="text-gray-500 hover:text-gray-700"
                >
                  Clear all
                </button>
              </div>
            </div>
            <div className="mb-3 rounded-lg border border-brand-100 bg-brand-50/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-gray-600">Selected genes</p>
                {selectedGenes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedGenes([])}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Clear selected
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedGenes.map((gene) => (
                  <button
                    key={gene.symbol}
                    type="button"
                    onClick={() => toggleGene(gene)}
                    className="rounded-md border border-brand-200 bg-white px-2.5 py-1 text-xs font-medium text-brand-700 shadow-sm hover:bg-brand-50"
                    title="Remove gene"
                  >
                    <span className="font-mono">{gene.symbol}</span>
                    <span className="ml-1 text-brand-400">KO #{gene.ko_index} x</span>
                  </button>
                ))}
                {selectedGenes.length === 0 && (
                  <span className="text-sm text-gray-400">No genes selected.</span>
                )}
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-gray-200 shadow-sm">
              <table className="w-full table-fixed text-sm">
                <thead className="sticky top-0 z-20 border-b border-gray-200 bg-gray-100 shadow-sm">
                  <tr>
                    <th className="w-10 bg-gray-100 px-3 py-2"></th>
                    <th className="w-44 bg-gray-100 px-3 py-2 text-left text-xs font-medium text-gray-500">Gene</th>
                    <th className="bg-gray-100 px-3 py-2 text-left text-xs font-medium text-gray-500">Category</th>
                    <th className="w-28 bg-gray-100 px-3 py-2 text-left text-xs font-medium text-gray-500">KO idx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredGenes.map((gene) => (
                    <tr
                      key={gene.symbol}
                      onClick={() => toggleGene(gene)}
                      className={`cursor-pointer transition-colors ${selectedGeneSymbols.has(gene.symbol) ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="h-10 px-3 py-1 align-middle">
                        <input
                          type="checkbox"
                          checked={selectedGeneSymbols.has(gene.symbol)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleGene(gene)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="h-10 truncate whitespace-nowrap px-3 py-1 align-middle font-mono text-xs font-medium leading-none text-brand-700">{gene.symbol}</td>
                      <td className="h-10 truncate whitespace-nowrap px-3 py-1 align-middle text-xs leading-none text-gray-500">{categoryLabel(gene.category)}</td>
                      <td className="h-10 whitespace-nowrap px-3 py-1 align-middle font-mono text-xs leading-none text-gray-400">{gene.ko_index}</td>
                    </tr>
                  ))}
                  {filteredGenes.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-sm text-gray-400">
                        No genes match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <StepBadge>3</StepBadge>
              Index variations
              <HelpTip text="Use the same parameter index control as the single experiment designer, then add each index to this batch." />
            </h2>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs text-gray-400">Parameter index</label>
                <input
                  type="number"
                  value={variantIndex}
                  min={minVariantIndex}
                  max={maxVariantIndex}
                  onChange={(event) => setVariantIndex(Number(event.target.value))}
                  className="w-32 rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                />
              </div>
              <button
                type="button"
                onClick={addVariantIndex}
                className="rounded-lg bg-brand-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
              >
                Add index
              </button>
            </div>
            {indexGuide && (
              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <p className="text-xs font-medium text-gray-700">Index guide</p>
                <p className={`mt-1 text-xs ${indexGuide.invalid ? 'text-amber-700' : 'text-gray-600'}`}>
                  Current selection: <span className="font-mono">{indexGuide.current}</span>
                </p>
                {indexGuide.items.length > 0 && (
                  <details className="group mt-2">
                    <summary className="cursor-pointer select-none text-xs font-medium text-brand-700 marker:text-brand-600">
                      Show index options ({indexGuide.items.length})
                    </summary>
                    <div className="mt-2 grid gap-1 md:grid-cols-2">
                      {indexGuide.items.map((item) => (
                        <p key={item} className="text-xs leading-relaxed text-gray-500">
                          {item}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedIndexes.map((index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => removeVariantIndex(index)}
                  className="rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 shadow-sm hover:bg-brand-100"
                  title="Remove index"
                >
                  index {index} <span className="text-brand-400">x</span>
                </button>
              ))}
              {selectedIndexes.length === 0 && (
                <span className="text-sm text-gray-400">No parameter indexes added.</span>
              )}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <StepBadge>4</StepBadge>
              Media protocol
              <HelpTip text="Compose a media protocol, then add it to the batch. Add multiple protocols to create all combinations across variations and seeds." />
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip label="Source" value="Batch records" tone="green" />
              <StatusChip label="Protocol" value={mediaProtocolSummary.label} tone={mediaProtocolSummary.tone} />
            </div>
          </div>
          <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">{mediaProtocolSummary.label}</p>
            <p className="mt-1 break-words">{mediaProtocolSummary.detail}</p>
          </div>
          <div className="space-y-3">
            <TimelineComposer
              mediaRecipes={mediaRecipes}
              conditions={conditions}
              onChange={setComposedTimelineEvents}
              onPresetLoad={(preset) => {
                const presetName = preset.label || preset.name
                setComposedTimelineName(presetName)
                setLoadedPresetTimelineName(presetName)
              }}
              onPresetClear={() => {
                setLoadedPresetTimelineName(null)
                setComposedTimelineName(`timeline_${batchTimelines.length + 1}`)
              }}
              maxSec={lengthSec}
              showLibrarySave={false}
              entryNounSingular="batch media protocol"
              entryNounPlural="batch media protocols"
            />
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <label className="mb-1 block text-xs font-medium text-gray-600">Protocol name</label>
              <input
                value={composedTimelineName}
                onChange={(event) => setComposedTimelineName(event.target.value)}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                placeholder="timeline_1"
              />
              <p className="mt-2 break-all font-mono text-xs text-gray-500">
                {composedTimelineEvents || 'Media protocol composer has not emitted events yet.'}
              </p>
              <button
                type="button"
                onClick={addComposedTimeline}
                disabled={!composedTimelineEvents.trim()}
                className={`mt-3 rounded-md px-3 py-2 text-sm font-medium shadow-sm ${
                  composedTimelineEvents.trim()
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'bg-gray-200 text-gray-400'
                }`}
              >
                Add media protocol
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {selectedTimelineChoices.map((timeline) => (
                <button
                  key={timeline.id}
                  type="button"
                  onClick={() => removeTimeline(timeline.id)}
                  className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 shadow-sm hover:border-red-200 hover:text-red-600"
                  title={timeline.definition}
                >
                  {timeline.label} x
                </button>
              ))}
              {selectedTimelineChoices.length === 0 && (
                <span className="text-sm text-gray-400">No batch media protocols added yet. Preview records will have no explicit timeline.</span>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <StepBadge>5</StepBadge>
            Simulation parameters
            <HelpTip text="Seeds are explicit values, not a count. Enter multiple seeds with commas." />
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Seeds</label>
              <input
                value={seedText}
                onChange={(event) => setSeedText(event.target.value)}
                placeholder="0, 7, 42"
                className={`w-full rounded-lg border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 ${
                  seedParse.error ? 'border-red-300 bg-red-50 focus:ring-red-200' : 'border-gray-200 bg-white shadow-sm focus:border-brand-500 focus:ring-brand-500/30'
                }`}
              />
              <p className={`mt-1 text-xs ${seedParse.error ? 'text-red-600' : 'text-gray-400'}`}>
                {seedParse.error || `${seedParse.values.join(', ') || 'none'}`}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Generations</label>
              <input
                type="number"
                min={1}
                value={generations}
                onChange={(event) => setGenerations(Math.max(1, Number(event.target.value) || 1))}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Max duration (s)</label>
              <input
                type="number"
                min={60}
                step={60}
                value={lengthSec}
                onChange={(event) => setLengthSec(Math.max(60, Number(event.target.value) || 60))}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <StepBadge>6</StepBadge>
                Preview records
              </h2>
              <p className="text-xs text-gray-400">
                {variationCount} variation{variationCount === 1 ? '' : 's'} x {timelineCount} timeline option{timelineCount === 1 ? '' : 's'} x {seedCount} seed{seedCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="text-right text-xs text-gray-500">
              <p>{previewRecords.length} active record{previewRecords.length === 1 ? '' : 's'}</p>
              {removedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setRemovedRows(new Set())}
                  className="text-brand-600 hover:text-brand-800"
                >
                  Restore {removedCount}
                </button>
              )}
              {editedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setRowOverrides({})}
                  className="ml-2 text-brand-600 hover:text-brand-800"
                >
                  Reset edits
                </button>
              )}
            </div>
          </div>

          {formErrors.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {formErrors[0]}
            </div>
          ) : previewRecords.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-400">
              No preview records yet.
            </div>
          ) : (
            <div className="max-h-[460px] overflow-auto rounded-lg border border-gray-200 shadow-sm">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-gray-200 bg-gray-50/95">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Variation</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Timeline</th>
                    <th className="w-20 px-3 py-2 text-left text-xs font-medium text-gray-500">Seed</th>
                    <th className="w-16 px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {previewRecords.map((record) => (
                    <tr key={record.row_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        {record.gene_symbols && record.gene_symbols.length > 0 ? (
                          <>
                            <span className="rounded-md bg-brand-50 px-2 py-1 font-mono text-xs font-medium text-brand-700">
                              {record.gene_symbols.length} genes
                            </span>
                            <p className="mt-1 max-w-xs truncate text-xs text-gray-400">{record.index_hint}</p>
                          </>
                        ) : record.gene_symbol ? (
                          <>
                            <span className="rounded-md bg-brand-50 px-2 py-1 font-mono text-xs font-medium text-brand-700">{record.gene_symbol}</span>
                            <span className="ml-2 text-xs text-gray-400">KO #{record.variant_index}</span>
                          </>
                        ) : (
                          <>
                            <span className="rounded-md bg-gray-100 px-2 py-1 font-mono text-xs font-medium text-gray-700">index {record.variant_index}</span>
                            {record.index_hint && (
                              <p className="mt-0.5 max-w-xs truncate text-xs text-gray-400">{record.index_hint}</p>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={record.timeline || ''}
                          onChange={(event) => {
                            const choice = timelineOptions.find((timeline) => timeline.value === event.target.value)
                            updateRow(record.row_id, {
                              timeline: event.target.value || undefined,
                              timeline_label: choice?.label,
                            })
                          }}
                          className="w-44 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        >
                          <option value="">No explicit timeline</option>
                          {timelineOptions.map((timeline) => (
                            <option key={timeline.id} value={timeline.value}>{timeline.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={record.seed}
                          onChange={(event) => updateRow(record.row_id, { seed: Math.max(0, Number(event.target.value) || 0) })}
                          className="w-16 rounded-md border border-gray-200 bg-white px-2 py-1 font-mono text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setRemovedRows((current) => new Set(current).add(record.row_id))}
                          className="text-xs text-gray-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>

      <aside className="xl:sticky xl:top-4">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Batch summary</h2>
            <StatusChip label="Create" value={formErrors.length === 0 ? 'ready' : 'incomplete'} tone={formErrors.length === 0 ? 'green' : 'amber'} />
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Batch</dt>
              <dd className="mt-1 font-medium text-slate-900">{name.trim() || 'Untitled batch'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Experiment</dt>
              <dd className="mt-1 font-medium text-slate-900">{variantType ? variantLabel(variantType) : 'Select a type'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Media protocol</dt>
              <dd className="mt-1 flex flex-wrap gap-2">
                <StatusChip label="Protocol" value={mediaProtocolSummary.label} tone={mediaProtocolSummary.tone} />
              </dd>
              <dd className="mt-1 break-words text-xs text-slate-500">{mediaProtocolSummary.detail}</dd>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Variations</dt>
                <dd className="mt-1 text-slate-900">{variationCount}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Records</dt>
                <dd className="mt-1 text-slate-900">{previewRecords.length}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Seeds</dt>
                <dd className="mt-1 break-words text-slate-900">{seedParse.error ? '-' : seedParse.values.join(', ')}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Max cell time</dt>
                <dd className="mt-1 text-slate-900">{(lengthSec / 3600).toFixed(1)} hr</dd>
                <dd className="mt-0.5 text-xs text-slate-400">{generations} gen</dd>
              </div>
            </div>
            {['gene_knockout', 'multi_gene_knockout'].includes(variantType) && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Wildtype controls</dt>
                <dd className="mt-1 text-slate-900">{includeWildtype ? 'Included' : 'Not included'}</dd>
              </div>
            )}
            {formErrors.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {formErrors[0]}
              </div>
            )}
          </dl>

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={submitBatch}
              disabled={submitting || formErrors.length > 0}
              className="w-full rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              title={formErrors[0] || 'Create batch experiments'}
            >
              {submitting ? 'Creating...' : 'Create batch'}
            </button>
            <Link
              to="/experiments"
              className="w-full rounded-lg px-4 py-2 text-center text-sm text-gray-600 transition-colors hover:bg-gray-100"
            >
              Cancel
            </Link>
          </div>
        </section>
      </aside>
      </div>
    </div>
  )
}
