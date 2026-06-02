import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  getVariants, getVariantDetail, getConditions, getMediaRecipes,
  createExperiment, searchGenes, getGene,
} from '../../api/client'
import type {
  Variant, VariantDetail, Condition, MediaRecipe, Gene, GeneDetail, ExperimentCreate,
} from '../../types'
import { SearchInput } from '../common/SearchInput'
import { HelpTip } from '../common/HelpTip'
import { variantLabel } from '../../utils/labels'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { TimelineComposer } from './TimelineComposer'

type TimelineBehavior = 'composer' | 'internal_override' | 'internal_conditional_override'

type IndexGuide = {
  current: string | null
  invalid: boolean
  items: string[]
}

const AMINO_ACID_INDEX_LABELS = [
  'L-ALPHA-ALANINE',
  'ARG',
  'ASN',
  'L-ASPARTATE',
  'CYS',
  'GLT',
  'GLN',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'L-SELENOCYSTEINE',
  'VAL',
]

const REMOVE_AAS_SHIFT_SINGLE_AAS = AMINO_ACID_INDEX_LABELS.filter(
  (aminoAcid) => aminoAcid !== 'CYS' && aminoAcid !== 'L-SELENOCYSTEINE',
)

const PPGPP_FACTORS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]
const PPGPP_CONDITION_INDICES = [0, 2]
const NEW_GENE_EXPRESSION_FACTORS = [0, 7, 8, 9, 10]
const NEW_GENE_TRANSLATION_EFFICIENCIES = [10, 5, 1, 0.1, 0]

function getMinValidIndex(variantDetail: VariantDetail | null): number | undefined {
  return variantDetail?.parameter_hints.min_valid_index
    ?? variantDetail?.parameter_hints.index_range?.[0]
}

function getMaxValidIndex(variantDetail: VariantDetail | null): number | undefined {
  return variantDetail?.parameter_hints.max_valid_index
    ?? variantDetail?.parameter_hints.index_range?.[1]
}

function formatConditionLabel(condition: Condition | undefined, index: number): string {
  if (!condition) return `${index}: condition index ${index}`
  if (condition.nutrients) return `${index}: ${condition.name} (${condition.nutrients})`
  return `${index}: ${condition.name}`
}

function describeAminoAcidIndex(variantType: string, index: number): string | null {
  const aminoAcid = AMINO_ACID_INDEX_LABELS[index]
  if (!aminoAcid) return null

  switch (variantType) {
    case 'add_one_aa':
      return index === 19
        ? `${index}: control (${aminoAcid} is already present in minimal media)`
        : `${index}: add ${aminoAcid} to minimal media`
    case 'remove_one_aa':
      return index === 19
        ? `${index}: control (${aminoAcid} must remain available in rich media)`
        : `${index}: remove ${aminoAcid} from rich media`
    case 'add_one_aa_shift':
      return index === 19
        ? `${index}: control (${aminoAcid} is already present before and after the shift)`
        : `${index}: shift from minimal media to minimal media plus ${aminoAcid}`
    case 'remove_one_aa_shift':
      return index === 19
        ? `${index}: control (${aminoAcid} must remain available in rich media)`
        : `${index}: shift from rich media to rich media without ${aminoAcid}`
    default:
      return null
  }
}

function findMatchingIndexOption(index: number, items: string[]): string | null {
  for (const item of items) {
    let match = item.match(/^(\-?\d+)\s*:\s*(.+)$/)
    if (match) {
      const exactIndex = Number(match[1])
      if (index === exactIndex) {
        return item
      }
      continue
    }

    match = item.match(/^(\-?\d+)\s*-\s*(\-?\d+)\s*:\s*(.+)$/)
    if (match) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (index >= start && index <= end) {
        return `${index}: ${match[3]}`
      }
      continue
    }

    match = item.match(/^(\-?\d+)\+\s*:\s*(.+)$/)
    if (match) {
      const start = Number(match[1])
      if (index >= start) {
        return `${index}: ${match[2]}`
      }
      continue
    }

    match = item.match(/^(\-?\d+)\s*\/\s*(\-?\d+)\s*:\s*(.+)$/)
    if (match) {
      const first = Number(match[1])
      const second = Number(match[2])
      if (index === first || index === second) {
        return `${index}: ${match[3]}`
      }
      continue
    }

    match = item.match(/^(\-?\d+).*?\-\s*(\-?\d+)(?:\s|$)/)
    if (match) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (index >= start && index <= end) {
        return `${index}: valid documented option in range ${start}-${end}`
      }
    }
  }

  return null
}

function getFallbackCurrentSelection(
  index: number,
  variantDetail: VariantDetail | null,
  items: string[],
): { current: string; invalid: boolean } {
  const matchedOption = findMatchingIndexOption(index, items)
  if (matchedOption) {
    return { current: matchedOption, invalid: false }
  }

  const minIndex = getMinValidIndex(variantDetail)
  const maxIndex = getMaxValidIndex(variantDetail)
  if (minIndex !== undefined || maxIndex !== undefined) {
    if ((minIndex !== undefined && index < minIndex) || (maxIndex !== undefined && index > maxIndex)) {
      const allowedRange = minIndex !== undefined && maxIndex !== undefined
        ? `${minIndex}-${maxIndex}`
        : minIndex !== undefined
          ? `>= ${minIndex}`
          : `<= ${maxIndex}`
      return {
        current: `${index}: not a valid option for this experiment (allowed range ${allowedRange})`,
        invalid: true,
      }
    }

    return {
      current: variantDetail?.parameter_hints.index_meaning
        ? `${index}: ${variantDetail.parameter_hints.index_meaning}`
        : `${index}: valid parameter index`,
      invalid: false,
    }
  }

  if (items.length > 0) {
    return {
      current: `${index}: not one of the documented options below`,
      invalid: true,
    }
  }

  return {
    current: variantDetail?.parameter_hints.index_meaning
      ? `${index}: ${variantDetail.parameter_hints.index_meaning}`
      : `${index}: selected parameter index`,
    invalid: false,
  }
}

function decodeNewGeneRemainder(remainder: number): { expressionLabel: string; translationLabel: string } | null {
  if (remainder === 0) {
    return {
      expressionLabel: 'control remainder (no induced new-gene expression)',
      translationLabel: 'runtime keeps the control translation setting',
    }
  }

  if (remainder < 0) return null

  const translationIndex = remainder % NEW_GENE_TRANSLATION_EFFICIENCIES.length
  const expressionIndex = translationIndex === 0
    ? Math.floor(remainder / NEW_GENE_TRANSLATION_EFFICIENCIES.length)
    : Math.floor(remainder / NEW_GENE_TRANSLATION_EFFICIENCIES.length) + 1

  if (expressionIndex <= 0 || expressionIndex >= NEW_GENE_EXPRESSION_FACTORS.length) {
    return null
  }

  const expressionFactor = 10 ** (NEW_GENE_EXPRESSION_FACTORS[expressionIndex] - 1)
  return {
    expressionLabel: `expression ${expressionFactor.toExponential(0)}x`,
    translationLabel: `translation efficiency ${NEW_GENE_TRANSLATION_EFFICIENCIES[translationIndex]}`,
  }
}

function getParameterIndexGuide(
  variantType: string,
  variantIndex: number,
  conditions: Condition[],
  variantDetail: VariantDetail | null,
): IndexGuide | null {
  switch (variantType) {
    case 'wildtype':
      return {
        current: '0: control run with no variant changes',
        invalid: false,
        items: ['0: control run with no variant changes'],
      }
    case 'condition':
      if (!conditions[variantIndex]) {
        return {
          current: `${variantIndex}: not a valid condition index`,
          invalid: true,
          items: conditions.map((condition, index) => formatConditionLabel(condition, index)),
        }
      }
      return {
        current: formatConditionLabel(conditions[variantIndex], variantIndex),
        invalid: false,
        items: conditions.map((condition, index) => formatConditionLabel(condition, index)),
      }
    case 'ppgpp_conc': {
      const items = PPGPP_CONDITION_INDICES.flatMap((conditionIndex) => {
        const conditionLabel = conditions[conditionIndex]?.name || `condition ${conditionIndex}`
        return PPGPP_FACTORS.map((factor, factorIndex) => {
          const index = conditionIndex === PPGPP_CONDITION_INDICES[0]
            ? factorIndex
            : PPGPP_FACTORS.length + factorIndex
          return `${index}: ${conditionLabel}, ${factor}x baseline ppGpp`
        })
      })

      return {
        current: items[variantIndex] || `${variantIndex}: not a valid ppGpp index`,
        invalid: !items[variantIndex],
        items,
      }
    }
    case 'add_one_aa':
    case 'remove_one_aa':
    case 'add_one_aa_shift':
    case 'remove_one_aa_shift': {
      const items = AMINO_ACID_INDEX_LABELS.map((_, index) => describeAminoAcidIndex(variantType, index) || `${index}: amino acid index ${index}`)
      return {
        current: items[variantIndex] || `${variantIndex}: not a valid amino acid index`,
        invalid: !items[variantIndex],
        items,
      }
    }
    case 'remove_aas_shift': {
      const items = [
        '0: rich-media control (all amino acids remain available)',
        '1: shift to the 12-amino-acid media set',
        '2: shift to the 6-amino-acid media set',
        '3: minimal-media control branch (no internal shift timeline; composer or selected condition remains in control)',
        ...REMOVE_AAS_SHIFT_SINGLE_AAS.map((aminoAcid, offset) => `${offset + 4}: shift to media with only ${aminoAcid}`),
        '23: shift to no amino acids',
      ]
      return {
        current: items[variantIndex] || `${variantIndex}: not a valid remove_aas_shift option`,
        invalid: !items[variantIndex],
        items,
      }
    }
    case 'tf_activity': {
      const tfNames = variantDetail?.parameter_hints.tf_names || []
      const controlPeriod = variantDetail?.parameter_hints.control_period
      const maxExactIndex = variantDetail?.parameter_hints.max_exact_index ?? tfNames.length * 2
      const items = variantDetail?.parameter_hints.index_options || [
        '0: control',
        'Odd indices activate a TF; even indices inactivate that same TF.',
      ]

      if (variantIndex < 0) {
        return {
          current: `${variantIndex}: not a valid tf_activity option`,
          invalid: true,
          items,
        }
      }

      if (variantIndex === 0) {
        return {
          current: '0: control',
          invalid: false,
          items,
        }
      }

      if (controlPeriod && variantIndex > maxExactIndex && variantIndex % controlPeriod === 0) {
        return {
          current: `${variantIndex}: control (equivalent to index 0 because tf_activity repeats every ${controlPeriod} steps)`,
          invalid: false,
          items,
        }
      }

      if (tfNames.length > 0 && variantIndex > 0 && variantIndex <= maxExactIndex) {
        const tfName = tfNames[Math.ceil(variantIndex / 2) - 1]
        const tfStatus = variantIndex % 2 === 1 ? 'active' : 'inactive'
        return {
          current: `${variantIndex}: ${tfName} ${tfStatus}`,
          invalid: false,
          items,
        }
      }

      const validityHint = controlPeriod
        ? `use 1-${maxExactIndex} for explicit TF states or multiples of ${controlPeriod} for control`
        : 'use the documented TF activity indices below'
      return {
        current: `${variantIndex}: not a valid tf_activity option (${validityHint})`,
        invalid: true,
        items,
      }
    }
    case 'sinusoidal_media': {
      const minValidIndex = variantDetail?.parameter_hints.min_valid_index ?? 1
      return {
        current: variantIndex < minValidIndex
          ? `${variantIndex}: not a valid sinusoidal period (must be >= ${minValidIndex} minute)`
          : `${variantIndex}: oscillation period of ${variantIndex} minute(s)`,
        invalid: variantIndex < minValidIndex,
        items: variantDetail?.parameter_hints.index_options || ['1+: oscillation period in minutes'],
      }
    }
    case 'new_gene_internal_shift': {
      const conditionStride = variantDetail?.parameter_hints.condition_stride ?? 1000
      const conditionNames = variantDetail?.parameter_hints.condition_names || conditions.map((condition) => condition.name)
      const [minRemainder, maxRemainder] = variantDetail?.parameter_hints.valid_remainder_range || [0, 20]
      const maxValidIndex = variantDetail?.parameter_hints.max_valid_index
      const conditionIndex = Math.floor(variantIndex / conditionStride)
      const remainder = variantIndex % conditionStride

      if (variantIndex < 0) {
        return {
          current: `${variantIndex}: not a valid new_gene_internal_shift option`,
          invalid: true,
          items: variantDetail?.parameter_hints.index_options || [],
        }
      }

      if (maxValidIndex !== undefined && variantIndex > maxValidIndex) {
        return {
          current: `${variantIndex}: not a valid new_gene_internal_shift option (maximum supported index is ${maxValidIndex})`,
          invalid: true,
          items: variantDetail?.parameter_hints.index_options || [],
        }
      }

      if (conditionIndex >= conditionNames.length) {
        return {
          current: `${variantIndex}: not a valid new_gene_internal_shift option (condition block ${conditionIndex} is not defined)`,
          invalid: true,
          items: variantDetail?.parameter_hints.index_options || [],
        }
      }

      if (remainder < minRemainder || remainder > maxRemainder) {
        return {
          current: `${variantIndex}: not a valid new_gene_internal_shift option (valid remainders are ${minRemainder}-${maxRemainder} within each condition block)`,
          invalid: true,
          items: variantDetail?.parameter_hints.index_options || [],
        }
      }

      const decodedRemainder = decodeNewGeneRemainder(remainder)
      return {
        current: variantIndex === 0
          ? '0: control (new gene expression knocked out)'
          : `${variantIndex}: ${conditionNames[conditionIndex]}, ${decodedRemainder?.expressionLabel || `remainder ${remainder}`}, ${decodedRemainder?.translationLabel || 'encoded translation setting'}`,
        invalid: false,
        items: variantDetail?.parameter_hints.index_options || [
          '0: control (new gene expression knocked out)',
          'For positive values, floor(index / 1000) selects the condition block in runtime order.',
          'Valid remainders are 0-20 within each condition block.',
        ],
      }
    }
    default:
      if (variantDetail?.parameter_hints.index_options?.length) {
        const fallback = getFallbackCurrentSelection(
          variantIndex,
          variantDetail,
          variantDetail.parameter_hints.index_options,
        )
        return {
          current: fallback.current,
          invalid: fallback.invalid,
          items: variantDetail.parameter_hints.index_options,
        }
      }
      if (variantDetail?.parameter_hints.index_meaning) {
        const items = [variantDetail.parameter_hints.index_meaning]
        if (variantDetail.parameter_hints.index_range) {
          items.push(
            `Allowed range: ${variantDetail.parameter_hints.index_range[0]}-${variantDetail.parameter_hints.index_range[1]}`,
          )
        }
        const fallback = getFallbackCurrentSelection(variantIndex, variantDetail, items)
        return {
          current: fallback.current,
          invalid: fallback.invalid,
          items,
        }
      }
      return null
  }
}

function getTimelineBehavior(variantDetail: VariantDetail | null): TimelineBehavior {
  return variantDetail?.parameter_hints.timeline_behavior || 'composer'
}

function isConditionalOverrideActive(variantType: string, variantIndex: number): boolean | null {
  switch (variantType) {
    case 'remove_aas_shift':
      return variantIndex !== 3
    case 'tf_activity':
      return variantIndex !== 0
    default:
      return null
  }
}

function getConditionTimelinePreview(index: number, conditions: Condition[]): string | null {
  const condition = conditions[index]
  return condition?.nutrients ? `0 ${condition.nutrients}` : null
}

function getEffectiveTimelinePreview(
  variantType: string,
  variantIndex: number,
  conditions: Condition[],
  composedTimeline: string,
): string | null {
  switch (variantType) {
    case 'timelines':
      return composedTimeline || null
    case 'condition':
      return getConditionTimelinePreview(variantIndex, conditions)
    case 'remove_one_aa':
      return '0 minimal_plus_amino_acids'
    case 'add_one_aa_shift':
      return '0 minimal, 600 minimal_plus_<selected amino acid>'
    case 'remove_one_aa_shift':
      return '0 minimal_plus_amino_acids, 600 variant_specific_media'
    case 'remove_aas_shift':
      if (variantIndex === 3) return composedTimeline || null
      if (variantIndex === 0) return '0 minimal_plus_amino_acids'
      if (variantIndex === 1) return '0 minimal_plus_amino_acids, 600 minimal_plus_12_amino_acids'
      if (variantIndex === 2) return '0 minimal_plus_amino_acids, 600 minimal_plus_6_amino_acids'
      if (variantIndex === 23) return '0 minimal_plus_amino_acids, 600 minimal'
      return '0 minimal_plus_amino_acids, 600 variant_specific_media'
    case 'tf_activity':
      return variantIndex === 0 ? (composedTimeline || null) : '0 <TF-specific nutrient condition>'
    case 'sinusoidal_media':
      return 'Initialization: 0 minimal_GLC_2mM; runtime environment then follows sinusoidal mixing between the configured media.'
    case 'new_gene_internal_shift':
      return getConditionTimelinePreview(Math.floor(variantIndex / 1000), conditions)
    default:
      return null
  }
}

export function ExperimentDesigner() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    selectedGene,
    selectedCondition,
    setWorkspaceUrlState,
    setSelectedCondition,
  } = useUrlWorkspaceState()

  // Pre-fill from URL params or the shared workspace selection.
  const prefillVariant = searchParams.get('variant') || ''
  const prefillGene = searchParams.get('gene') || selectedGene || ''
  const prefillCondition = searchParams.get('condition') || selectedCondition || 'basal'
  const inferredVariant = prefillVariant || (prefillGene ? 'gene_knockout' : '')

  // Reference data
  const [variants, setVariants] = useState<Variant[]>([])
  const [conditions, setConditions] = useState<Condition[]>([])
  const [mediaRecipes, setMediaRecipes] = useState<MediaRecipe[]>([])

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [variantType, setVariantType] = useState(inferredVariant)
  const [variantDetail, setVariantDetail] = useState<VariantDetail | null>(null)
  const [variantIndex, setVariantIndex] = useState(0)
  const [condition, setCondition] = useState(prefillCondition)
  const [timeline, setTimeline] = useState('')
  const [geneSymbol, setGeneSymbol] = useState(prefillGene)
  const [seeds, setSeeds] = useState(1)
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)

  // Gene search
  const [geneQuery, setGeneQuery] = useState(prefillGene)
  const [geneResults, setGeneResults] = useState<Gene[]>([])
  const [showGenePicker, setShowGenePicker] = useState(false)

  // Gene impact preview
  const [geneDetail, setGeneDetail] = useState<GeneDetail | null>(null)

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const timelineBehavior = getTimelineBehavior(variantDetail)
  const hideVariantIndex = Boolean(variantDetail?.parameter_hints.hide_index)
  const timelineNotice = variantDetail?.parameter_hints.timeline_notice || ''
  const conditionalOverrideActive = isConditionalOverrideActive(variantType, variantIndex)
  const effectiveTimelinePreview = getEffectiveTimelinePreview(
    variantType,
    variantIndex,
    conditions,
    timeline,
  )
  const minVariantIndex = getMinValidIndex(variantDetail)
  const maxVariantIndex = getMaxValidIndex(variantDetail)
  const parameterIndexGuide = getParameterIndexGuide(
    variantType,
    variantIndex,
    conditions,
    variantDetail,
  )

  // Load reference data
  useEffect(() => {
    getVariants().then(setVariants)
    getConditions().then(setConditions)
    getMediaRecipes().then(setMediaRecipes)
  }, [])

  // Auto-select variant if prefilled
  useEffect(() => {
    if (prefillVariant) {
      setVariantType(prefillVariant)
    }
  }, [prefillVariant])

  useEffect(() => {
    if (!selectedGene || geneSymbol) return
    setVariantType((current) => current || 'gene_knockout')
    setGeneSymbol(selectedGene)
    setGeneQuery(selectedGene)
  }, [geneSymbol, selectedGene])

  useEffect(() => {
    const nextCondition = searchParams.get('condition') || selectedCondition
    if (nextCondition && nextCondition !== condition) {
      setCondition(nextCondition)
    }
  }, [condition, searchParams, selectedCondition])

  // Load variant detail when type changes
  useEffect(() => {
    if (!variantType) { setVariantDetail(null); return }
    getVariantDetail(variantType)
      .then(setVariantDetail)
      .catch(() => setVariantDetail(null))
  }, [variantType])

  // Auto-generate name
  useEffect(() => {
    if (variantType === 'gene_knockout' && geneSymbol) {
      setName(`${geneSymbol} knockout`)
    } else if (variantType) {
      setName(`${variantType} experiment`)
    }
  }, [variantType, geneSymbol])

  // Auto-resolve prefilled gene -> ko_index on mount
  useEffect(() => {
    if (!prefillGene) return
    searchGenes(prefillGene, 5).then((genes) => {
      const exact = genes.find((g) => g.symbol.toLowerCase() === prefillGene.toLowerCase())
      if (exact) {
        setVariantIndex(exact.ko_index)
        setGeneSymbol(exact.symbol)
        setGeneQuery(exact.symbol)
      }
    })
  }, [prefillGene])

  // Fetch gene detail for impact preview
  useEffect(() => {
    if (!geneSymbol) { setGeneDetail(null); return }
    getGene(geneSymbol).then(setGeneDetail).catch(() => setGeneDetail(null))
  }, [geneSymbol])

  // Gene search
  useEffect(() => {
    if (geneQuery.length < 1) { setGeneResults([]); return }
    const timer = setTimeout(() => {
      searchGenes(geneQuery, 8).then(setGeneResults)
    }, 200)
    return () => clearTimeout(timer)
  }, [geneQuery])

  const selectGene = (gene: Gene) => {
    setGeneSymbol(gene.symbol)
    setGeneQuery(gene.symbol)
    setVariantIndex(gene.ko_index)
    setShowGenePicker(false)
    setWorkspaceUrlState({ selectedGene: gene.symbol }, { replace: true })
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!variantType) { setError('Select an experiment type'); return }

    setSaving(true)
    setError(null)
    try {
      const data: ExperimentCreate = {
        name: name.trim(),
        description: description.trim(),
        variant_type: variantType,
        variant_index: variantIndex,
        condition,
        timeline,
        gene_symbol: geneSymbol,
        sim_params: JSON.stringify({ seeds, generations, length_sec: lengthSec }),
      }
      const experiment = await createExperiment(data)
      const nextParams = new URLSearchParams({
        created: String(experiment.id),
        experiment: String(experiment.id),
        condition,
      })
      if (geneSymbol) nextParams.set('gene', geneSymbol)
      navigate(`/experiments?${nextParams.toString()}`)
    } catch (e: any) {
      setError(e.message || 'Failed to save experiment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Design experiment</h1>
      <p className="text-sm text-gray-400 mb-6">
        Configure an experiment type, growth condition, and simulation parameters.
        {' '}<Link to="/guide" className="text-brand-600 hover:text-brand-700 hover:underline">View full documentation &rarr;</Link>
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* --- Experiment type --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Experiment type
            <HelpTip text="Each experiment type modifies the simulation in a specific way. 'Gene knockout' sets a gene's RNA expression to zero — the cell must grow without the protein it encodes. Other variants alter media composition, kinetic parameters, or regulatory logic." />
          </h2>
          <select
            value={variantType}
            onChange={(e) => {
              setVariantType(e.target.value)
              setVariantIndex(0)
              setGeneSymbol('')
              setGeneQuery('')
            }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
          >
            <option value="">Select experiment type...</option>
            {variants.map((v) => (
              <option key={v.name} value={v.name}>{variantLabel(v.name)}</option>
            ))}
          </select>

          {variantDetail && (
            <div className="mt-3 bg-gray-50 rounded-md p-3">
              <p className="text-xs text-gray-500 whitespace-pre-line leading-relaxed">
                {variantDetail.docstring.slice(0, 300)}
                {variantDetail.docstring.length > 300 ? '...' : ''}
              </p>
              {variantDetail.parameter_hints.index_meaning && (
                <p className="text-xs text-gray-400 mt-2 border-t border-gray-200 pt-2">
                  Index: {variantDetail.parameter_hints.index_meaning}
                </p>
              )}
            </div>
          )}
        </section>

        {/* --- Gene picker (for gene_knockout) --- */}
        {variantType === 'gene_knockout' && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
              Target gene
              <HelpTip text="The knockout sets this gene's RNA expression to zero. The model tracks all 4,749 genes, but only ~1,500 have mechanistic downstream effects (metabolic enzymes, transcription factors, ribosomal proteins). Knocking out a 'passenger' gene will show its protein declining to zero, but may not affect growth." />
            </h2>
            <div className="relative">
              <SearchInput
                value={geneQuery}
                onChange={(v) => { setGeneQuery(v); setShowGenePicker(true) }}
                placeholder="Search gene to knock out..."
              />
              {showGenePicker && geneResults.length > 0 && (
                <div className="absolute z-10 top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {geneResults.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => selectGene(g)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-center justify-between"
                    >
                      <span>
                        <span className="font-mono font-medium text-bio-gene">{g.symbol}</span>
                        <span className="text-gray-400 ml-2">{g.ecoli_id}</span>
                      </span>
                      <span className="text-xs text-gray-400">KO #{g.ko_index}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {geneSymbol && (
              <p className="text-sm mt-2 text-gray-600">
                Selected: <span className="font-mono font-medium text-bio-gene">{geneSymbol}</span>
                {' '}&rarr; KO index <span className="font-mono">{variantIndex}</span>
              </p>
            )}
          </section>
        )}

        {/* --- Parameter index (for non-gene-knockout) --- */}
        {variantType && variantType !== 'gene_knockout' && variantDetail && !hideVariantIndex && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Parameter index</h2>
            <input
              type="number"
              value={variantIndex}
              onChange={(e) => setVariantIndex(Number(e.target.value))}
              min={minVariantIndex}
              max={maxVariantIndex}
              className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                         focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
            {variantDetail.parameter_hints.index_meaning && (
              <p className="text-xs text-gray-400 mt-1">
                {variantDetail.parameter_hints.index_meaning}
              </p>
            )}
            {parameterIndexGuide && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs font-medium text-gray-700">Index guide</p>
                {parameterIndexGuide.current && (
                  <p className={`text-xs mt-1 ${parameterIndexGuide.invalid ? 'text-amber-700' : 'text-gray-600'}`}>
                    Current selection: <span className="font-mono">{parameterIndexGuide.current}</span>
                  </p>
                )}
                <details className="mt-2 group">
                  <summary className="cursor-pointer select-none text-xs font-medium text-brand-700 marker:text-brand-600">
                    Show index options ({parameterIndexGuide.items.length})
                  </summary>
                  <div className="mt-2 grid gap-1 md:grid-cols-2">
                    {parameterIndexGuide.items.map((item) => (
                      <p key={item} className="text-xs text-gray-500 leading-relaxed">
                        {item}
                      </p>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </section>
        )}

        {/* --- Simulation parameters --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Simulation parameters
            <HelpTip text="Seeds are independent random replicates — each starts from a different initial state. Generations control how many cell divisions are simulated sequentially. More seeds give statistical power; more generations reveal long-term dynamics and potential lethality." />
          </h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Seeds (replicates)</label>
              <input
                type="number"
                value={seeds}
                onChange={(e) => setSeeds(Math.max(1, Number(e.target.value)))}
                min={1}
                max={64}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Generations</label>
              <input
                type="number"
                value={generations}
                onChange={(e) => setGenerations(Math.max(1, Number(e.target.value)))}
                min={1}
                max={10}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">~30 min/gen</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Max duration (s)</label>
              <input
                type="number"
                value={lengthSec}
                onChange={(e) => setLengthSec(Math.max(60, Number(e.target.value)))}
                min={60}
                step={60}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">{(lengthSec / 3600).toFixed(1)} hr</p>
            </div>
          </div>
        </section>

        {/* --- Growth environment / Timeline composer --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-4 flex items-center gap-1.5">
            Timeline composer
            <HelpTip text="Select a media vial from the palette, then click on the time axis to schedule environment shifts. Events are sorted by time and passed directly to the simulation as a raw event string. At least one event (the starting media) is required." />
          </h2>
          {variantType === 'timelines' && (
            <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              <p className="font-medium">This experiment uses the composed timeline directly.</p>
              <p className="mt-1 text-blue-800">{timelineNotice}</p>
            </div>
          )}
          {timelineBehavior === 'internal_override' && timelineNotice && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">This experiment presets its timeline internally.</p>
              <p className="mt-1 text-amber-800">{timelineNotice}</p>
              {effectiveTimelinePreview && (
                <p className="mt-2 font-mono text-xs text-amber-900 break-all">
                  Effective timeline: {effectiveTimelinePreview}
                </p>
              )}
            </div>
          )}
          {timelineBehavior === 'internal_conditional_override' && timelineNotice && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">
                {conditionalOverrideActive === false
                  ? 'This selected branch can use the composed timeline.'
                  : 'This experiment can override the composed timeline internally.'}
              </p>
              <p className="mt-1 text-amber-800">{timelineNotice}</p>
              {effectiveTimelinePreview && conditionalOverrideActive !== false && (
                <p className="mt-2 font-mono text-xs text-amber-900 break-all">
                  Expected internal timeline: {effectiveTimelinePreview}
                </p>
              )}
            </div>
          )}
          <TimelineComposer
            mediaRecipes={mediaRecipes}
            conditions={conditions}
            onChange={setTimeline}
            maxSec={lengthSec}
          />
        </section>

        {/* --- Name & description --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Experiment details</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. rpoB knockout in minimal media"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What do you expect to observe?"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
          </div>
        </section>

        {/* --- Summary + save --- */}
        <section className="bg-brand-50 rounded-lg border border-brand-200 p-5">
          <h2 className="text-sm font-medium text-brand-800 mb-2">Experiment summary</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-brand-700">
            <span className="text-brand-500">Type:</span>
            <span>{variantType ? variantLabel(variantType) : '—'}</span>
            {geneSymbol && (
              <>
                <span className="text-brand-500">Gene:</span>
                <span className="font-mono">{geneSymbol}</span>
              </>
            )}
            {timeline && (
              <>
                <span className="text-brand-500">Timeline:</span>
                <span className="font-mono text-xs break-all">
                  {timeline.length > 60 ? timeline.slice(0, 60) + '…' : timeline}
                </span>
              </>
            )}
            {effectiveTimelinePreview && timelineBehavior !== 'composer' && (
              <>
                <span className="text-brand-500">Effective timeline:</span>
                <span className="font-mono text-xs break-all">{effectiveTimelinePreview}</span>
              </>
            )}
            <span className="text-brand-500">Replicates:</span>
            <span>{seeds} seed{seeds > 1 ? 's' : ''} &times; {generations} gen</span>
            <span className="text-brand-500">Max duration:</span>
            <span>{lengthSec}s ({(lengthSec / 3600).toFixed(1)} hr)</span>
          </div>
        </section>

        <div className="flex gap-3 justify-end pb-8">
          <button
            onClick={() => navigate('/experiments')}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !variantType || !name.trim()}
            className="px-5 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700
                       rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save experiment'}
          </button>
        </div>
      </div>
    </div>
  )
}
