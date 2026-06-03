import { useState, useEffect, useMemo, type ReactNode } from 'react'
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
    variants: ['wildtype', 'gene_knockout', 'condition', 'timelines'],
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

const OVERRIDE_EXAMPLES: Record<string, string> = {
  remove_one_aa: 'Runs in minimal_plus_amino_acids and removes the selected amino acid, regardless of the selected starting condition.',
  add_one_aa_shift: 'Creates an internal 10-minute shift from minimal media to minimal media plus the selected amino acid.',
  tf_activity: 'Sets a TF-specific active/inactive condition and nutrient timeline from reconstruction metadata.',
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
const PPGPP_CONDITION_NAMES = ['basal', 'with_aa']
const NEW_GENE_EXPRESSION_FACTORS = [0, 7, 8, 9, 10]
const NEW_GENE_TRANSLATION_EFFICIENCIES = [10, 5, 1, 0.1, 0]

function getRemoveAasShiftOptions(): { index: number; label: string; description: string }[] {
  return [
    {
      index: 0,
      label: 'Rich-media control',
      description: 'All amino acids remain available.',
    },
    {
      index: 1,
      label: 'Shift to 12 amino acids',
      description: 'After 10 min, only the model-defined 12-AA set remains supplemented.',
    },
    {
      index: 2,
      label: 'Shift to 6 amino acids',
      description: 'After 10 min, only the model-defined 6-AA set remains supplemented.',
    },
    {
      index: 3,
      label: 'Minimal-media control',
      description: 'No amino-acid supplementation branch.',
    },
    ...REMOVE_AAS_SHIFT_SINGLE_AAS.map((aminoAcid, offset) => ({
      index: offset + 4,
      label: `Shift to only ${aminoAcid}`,
      description: `After 10 min, ${aminoAcid} is the only supplemented amino acid.`,
    })),
    {
      index: 23,
      label: 'Shift to no amino acids',
      description: 'After 10 min, all amino-acid supplementation is removed.',
    },
  ]
}

function getTfActivitySelection(
  variantIndex: number,
  variantDetail: VariantDetail | null,
): { mode: 'control' | 'state'; tfIndex: number; status: 'active' | 'inactive' } {
  const tfNames = variantDetail?.parameter_hints.tf_names || []
  if (variantIndex <= 0 || tfNames.length === 0) {
    return { mode: 'control', tfIndex: 0, status: 'active' }
  }

  const maxExactIndex = variantDetail?.parameter_hints.max_exact_index ?? tfNames.length * 2
  if (variantIndex > maxExactIndex) {
    return { mode: 'control', tfIndex: 0, status: 'active' }
  }

  return {
    mode: 'state',
    tfIndex: Math.max(0, Math.ceil(variantIndex / 2) - 1),
    status: variantIndex % 2 === 1 ? 'active' : 'inactive',
  }
}

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
      const conditionNames = variantDetail?.parameter_hints.condition_names || PPGPP_CONDITION_NAMES
      const items = conditionNames.flatMap((conditionName, conditionBlock) => {
        const condition = conditions.find((item) => item.name === conditionName)
        const conditionLabel = condition?.name || conditionName
        return PPGPP_FACTORS.map((factor, factorIndex) => {
          const index = conditionBlock * PPGPP_FACTORS.length + factorIndex
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

type SemanticParameterControlsProps = {
  variantType: string
  variantIndex: number
  conditions: Condition[]
  variantDetail: VariantDetail | null
  setVariantIndex: (index: number) => void
  setCondition: (condition: string) => void
}

function SemanticParameterControls({
  variantType,
  variantIndex,
  conditions,
  variantDetail,
  setVariantIndex,
  setCondition,
}: SemanticParameterControlsProps) {
  if (variantType === 'condition') {
    return (
      <div>
        <label className="text-xs text-gray-400 block mb-1">Growth condition encoded by this experiment type</label>
        <select
          value={variantIndex}
          onChange={(event) => {
            const nextIndex = Number(event.target.value)
            setVariantIndex(nextIndex)
            if (conditions[nextIndex]?.name) {
              setCondition(conditions[nextIndex].name)
            }
          }}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
        >
          {conditions.map((condition, index) => (
            <option key={condition.name} value={index}>
              {condition.name}{condition.nutrients ? ` (${condition.nutrients})` : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1">
          This selector drives the runtime condition index and also syncs the regular condition field.
        </p>
      </div>
    )
  }

  if (['add_one_aa', 'remove_one_aa', 'add_one_aa_shift', 'remove_one_aa_shift'].includes(variantType)) {
    return (
      <div>
        <label className="text-xs text-gray-400 block mb-1">Amino acid</label>
        <select
          value={variantIndex}
          onChange={(event) => setVariantIndex(Number(event.target.value))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
        >
          {AMINO_ACID_INDEX_LABELS.map((aminoAcid, index) => (
            <option key={aminoAcid} value={index}>
              {describeAminoAcidIndex(variantType, index) || `${index}: ${aminoAcid}`}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (variantType === 'remove_aas_shift') {
    return (
      <div>
        <label className="text-xs text-gray-400 block mb-1">Amino-acid shift branch</label>
        <select
          value={variantIndex}
          onChange={(event) => setVariantIndex(Number(event.target.value))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
        >
          {getRemoveAasShiftOptions().map((option) => (
            <option key={option.index} value={option.index}>
              {option.index}: {option.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1">
          {getRemoveAasShiftOptions().find((option) => option.index === variantIndex)?.description}
        </p>
      </div>
    )
  }

  if (variantType === 'tf_activity') {
    const tfNames = variantDetail?.parameter_hints.tf_names || []
    const selection = getTfActivitySelection(variantIndex, variantDetail)
    const selectedTfIndex = Math.min(selection.tfIndex, Math.max(0, tfNames.length - 1))
    const selectedStatus = selection.status
    const selectedTfName = selection.mode === 'control' ? '' : tfNames[selectedTfIndex]
    const tfStateDetails = selectedTfName ? variantDetail?.parameter_hints.tf_state_details?.[selectedTfName] : undefined
    const nutrients = selectedStatus === 'active'
      ? tfStateDetails?.active_nutrients
      : tfStateDetails?.inactive_nutrients
    const perturbations = selectedStatus === 'active'
      ? tfStateDetails?.active_perturbations
      : tfStateDetails?.inactive_perturbations

    const setTfSelection = (tfIndex: number, status: 'active' | 'inactive') => {
      setVariantIndex(2 * tfIndex + (status === 'active' ? 1 : 2))
    }

    return (
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_180px]">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Transcription factor</label>
            <select
              value={selection.mode === 'control' ? 'control' : selectedTfIndex}
              onChange={(event) => {
                if (event.target.value === 'control') {
                  setVariantIndex(0)
                  return
                }
                setTfSelection(Number(event.target.value), selectedStatus)
              }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            >
              <option value="control">Control (no forced TF state)</option>
              {tfNames.map((tfName, index) => (
                <option key={tfName} value={index}>{tfName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Forced state</label>
            <select
              value={selectedStatus}
              disabled={selection.mode === 'control'}
              onChange={(event) => setTfSelection(selectedTfIndex, event.target.value as 'active' | 'inactive')}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        {selection.mode !== 'control' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip label="TF" value={selectedTfName || 'n/a'} tone="blue" />
              <StatusChip label="State" value={selectedStatus} tone={selectedStatus === 'active' ? 'green' : 'amber'} />
              <StatusChip label="Class" value={tfStateDetails?.tf_type || 'n/a'} />
            </div>
            <dl className="mt-3 grid gap-3 text-xs md:grid-cols-3">
              <div>
                <dt className="text-slate-400">TF molecule</dt>
                <dd className="mt-1 font-mono text-slate-800">{tfStateDetails?.active_molecule || 'n/a'}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Nutrients</dt>
                <dd className="mt-1 font-mono text-slate-800">{nutrients || 'n/a'}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Genotype perturbations</dt>
                <dd className="mt-1 break-all font-mono text-slate-800">
                  {perturbations && perturbations !== '{}' ? perturbations : 'none'}
                </dd>
              </div>
            </dl>
          </div>
        )}
        <p className="text-xs text-slate-500">
          Forced TF states use reconstruction metadata. Free-form media stacks remain available only for the control branch.
        </p>
      </div>
    )
  }

  if (variantType === 'ppgpp_conc') {
    const conditionNames = variantDetail?.parameter_hints.condition_names || PPGPP_CONDITION_NAMES
    const factorIndex = ((variantIndex % PPGPP_FACTORS.length) + PPGPP_FACTORS.length) % PPGPP_FACTORS.length
    const conditionBlock = Math.floor(variantIndex / PPGPP_FACTORS.length)
    const selectedConditionName = conditionNames[conditionBlock] ?? conditionNames[0]

    const setPpgppSelection = (conditionName: string, nextFactorIndex: number) => {
      const block = Math.max(0, conditionNames.indexOf(conditionName))
      setVariantIndex(block * PPGPP_FACTORS.length + nextFactorIndex)
    }

    return (
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Runtime condition block</label>
          <select
            value={selectedConditionName}
            onChange={(event) => setPpgppSelection(event.target.value, factorIndex)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
          >
            {conditionNames.map((conditionName) => (
              <option key={conditionName} value={conditionName}>
                {conditionName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Fixed ppGpp factor</label>
          <select
            value={factorIndex}
            onChange={(event) => setPpgppSelection(selectedConditionName, Number(event.target.value))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
          >
            {PPGPP_FACTORS.map((factor, index) => (
              <option key={factor} value={index}>{factor}x baseline ppGpp</option>
            ))}
          </select>
        </div>
        <p className="md:col-span-2 text-xs text-slate-500">
          This variant clamps ppGpp and disables normal ppGpp synthesis/degradation dynamics for the selected condition block.
        </p>
      </div>
    )
  }

  if (variantType === 'sinusoidal_media') {
    return (
      <div>
        <label className="text-xs text-gray-400 block mb-1">Oscillation period (minutes)</label>
        <input
          type="number"
          value={variantIndex}
          onChange={(event) => setVariantIndex(Math.max(1, Number(event.target.value)))}
          min={1}
          step={1}
          className="w-40 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
        />
        <p className="text-xs text-gray-400 mt-1">
          Media A/B are still runtime-configured; this control only sets the period.
        </p>
      </div>
    )
  }

  return null
}

function isConditionalOverrideActive(variantType: string, variantIndex: number): boolean | null {
  switch (variantType) {
    case 'remove_aas_shift':
      return true
    case 'tf_activity':
      return variantIndex !== 0
    case 'rrna_location':
    case 'rrna_orientation':
    case 'rrna_operon_knockout':
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
  variantDetail: VariantDetail | null,
): string | null {
  switch (variantType) {
    case 'timelines':
      return composedTimeline || null
    case 'condition':
      return getConditionTimelinePreview(variantIndex, conditions)
    case 'add_one_aa':
      return '0 minimal'
    case 'remove_one_aa':
      return '0 minimal_plus_amino_acids'
    case 'add_one_aa_shift':
      return '0 minimal, 600 minimal_plus_<selected amino acid>'
    case 'remove_one_aa_shift':
      return '0 minimal_plus_amino_acids, 600 variant_specific_media'
    case 'remove_aas_shift':
      if (variantIndex === 3) return '0 minimal'
      if (variantIndex === 0) return '0 minimal_plus_amino_acids'
      if (variantIndex === 1) return '0 minimal_plus_amino_acids, 600 minimal_plus_12_amino_acids'
      if (variantIndex === 2) return '0 minimal_plus_amino_acids, 600 minimal_plus_6_amino_acids'
      if (variantIndex === 23) return '0 minimal_plus_amino_acids, 600 minimal'
      return '0 minimal_plus_amino_acids, 600 variant_specific_media'
    case 'tf_activity':
      if (variantIndex === 0) return composedTimeline || null
      return getTfActivityPreview(variantIndex, variantDetail)
    case 'ppgpp_conc': {
      const conditionNames = variantDetail?.parameter_hints.condition_names || PPGPP_CONDITION_NAMES
      const conditionName = conditionNames[Math.floor(variantIndex / PPGPP_FACTORS.length)] || conditionNames[0]
      const selectedCondition = conditions.find((item) => item.name === conditionName)
      return selectedCondition?.nutrients ? `0 ${selectedCondition.nutrients}` : `0 ${conditionName}`
    }
    case 'sinusoidal_media':
      return 'Initialization: 0 minimal_GLC_2mM; runtime environment then follows sinusoidal mixing between the configured media.'
    case 'new_gene_internal_shift':
      return getConditionTimelinePreview(Math.floor(variantIndex / 1000), conditions)
    case 'rrna_location':
    case 'rrna_orientation':
      if (variantIndex === 1) return '0 minimal'
      if (variantIndex === 2) return '0 minimal_plus_amino_acids'
      if (variantIndex === 3) return '000028_add_aa_long: minimal-to-rich shift'
      return null
    case 'rrna_operon_knockout':
      if (variantIndex >= 1 && variantIndex <= 6) return '0 minimal'
      if (variantIndex >= 7 && variantIndex <= 12) return '0 minimal_plus_amino_acids'
      if (variantIndex >= 13 && variantIndex <= 18) return '000028_add_aa_long: minimal-to-rich shift'
      return null
    default:
      return null
  }
}

function getConditionForNutrients(conditions: Condition[], nutrients: string, fallback = 'basal'): string {
  return conditions.find((condition) => condition.nutrients === nutrients)?.name || fallback
}

function getTfActivityPreview(variantIndex: number, variantDetail: VariantDetail | null): string {
  const selection = getTfActivitySelection(variantIndex, variantDetail)
  const tfNames = variantDetail?.parameter_hints.tf_names || []
  const tfName = tfNames[selection.tfIndex]
  const details = tfName ? variantDetail?.parameter_hints.tf_state_details?.[tfName] : undefined
  const nutrients = selection.status === 'active'
    ? details?.active_nutrients
    : details?.inactive_nutrients
  return nutrients ? `0 ${nutrients}` : '0 <TF-specific nutrient condition>'
}

function getEffectiveExperimentEnvironment(
  variantType: string,
  variantIndex: number,
  conditions: Condition[],
  variantDetail: VariantDetail | null,
  currentCondition: string,
  composedTimeline: string,
): { condition: string; timeline: string } {
  switch (variantType) {
    case 'condition':
      return { condition: conditions[variantIndex]?.name || currentCondition || 'basal', timeline: '' }
    case 'add_one_aa':
    case 'add_one_aa_shift':
      return { condition: 'basal', timeline: '' }
    case 'remove_one_aa':
    case 'remove_one_aa_shift':
      return { condition: 'with_aa', timeline: '' }
    case 'remove_aas_shift':
      return { condition: variantIndex === 3 ? 'basal' : 'with_aa', timeline: '' }
    case 'ppgpp_conc': {
      const conditionNames = variantDetail?.parameter_hints.condition_names || PPGPP_CONDITION_NAMES
      return {
        condition: conditionNames[Math.floor(variantIndex / PPGPP_FACTORS.length)] || currentCondition || 'basal',
        timeline: '',
      }
    }
    case 'tf_activity': {
      if (variantIndex === 0) return { condition: currentCondition || 'basal', timeline: composedTimeline }
      const selection = getTfActivitySelection(variantIndex, variantDetail)
      const tfName = variantDetail?.parameter_hints.tf_names?.[selection.tfIndex]
      const details = tfName ? variantDetail?.parameter_hints.tf_state_details?.[tfName] : undefined
      const nutrients = selection.status === 'active'
        ? details?.active_nutrients
        : details?.inactive_nutrients
      return {
        condition: nutrients ? getConditionForNutrients(conditions, nutrients, currentCondition || 'basal') : currentCondition || 'basal',
        timeline: '',
      }
    }
    case 'sinusoidal_media':
      return { condition: variantDetail?.parameter_hints.fixed_condition || 'glc_2mM', timeline: '' }
    case 'new_gene_internal_shift':
      return {
        condition: conditions[Math.floor(variantIndex / 1000)]?.name || currentCondition || 'basal',
        timeline: '',
      }
    case 'rrna_location':
    case 'rrna_orientation':
      if (variantIndex === 0) return { condition: currentCondition || 'basal', timeline: composedTimeline }
      return { condition: variantIndex === 2 ? 'with_aa' : 'basal', timeline: '' }
    case 'rrna_operon_knockout':
      if (variantIndex === 0) return { condition: currentCondition || 'basal', timeline: composedTimeline }
      return { condition: variantIndex >= 7 && variantIndex <= 12 ? 'with_aa' : 'basal', timeline: '' }
    default:
      return { condition: currentCondition || 'basal', timeline: composedTimeline }
  }
}

function getEnvironmentSourceLabel(
  variantType: string,
  timelineBehavior: TimelineBehavior,
  conditionalOverrideActive: boolean | null,
): string {
  if (variantType === 'timelines') {
    return 'Media protocol below'
  }
  if (timelineBehavior === 'internal_override') {
    return 'Experiment type'
  }
  if (timelineBehavior === 'internal_conditional_override') {
    return conditionalOverrideActive === false ? 'Media protocol below' : 'Experiment type'
  }
  return 'Media protocol below'
}

function getParameterSectionTitle(variantType: string): string {
  switch (variantType) {
    case 'condition':
      return 'Growth condition'
    case 'add_one_aa':
    case 'remove_one_aa':
    case 'add_one_aa_shift':
    case 'remove_one_aa_shift':
      return 'Amino acid'
    case 'remove_aas_shift':
      return 'Amino-acid branch'
    case 'tf_activity':
      return 'TF state'
    case 'ppgpp_conc':
      return 'ppGpp level'
    case 'sinusoidal_media':
      return 'Oscillation'
    default:
      return 'Variant parameter'
  }
}

function getEnvironmentStatusText(
  timelineBehavior: TimelineBehavior,
  conditionalOverrideActive: boolean | null,
  environmentLocked: boolean,
): string {
  if (environmentLocked) return 'Locked by variant'
  if (timelineBehavior === 'internal_conditional_override' && conditionalOverrideActive === false) {
    return 'Editable'
  }
  return 'Editable'
}

type ProtocolSummary = {
  label: string
  detail: string
  eventCount: number
}

function parseProtocolEvents(timeline: string): { timeSec: number; mediaId: string }[] {
  return timeline.trim().split(',').flatMap((part) => {
    const bits = part.trim().split(/\s+/, 2)
    if (bits.length !== 2) return []
    const timeSec = Number(bits[0])
    if (!Number.isFinite(timeSec)) return []
    return [{ timeSec, mediaId: bits[1] }]
  }).sort((a, b) => a.timeSec - b.timeSec)
}

function summarizeProtocol(timeline: string): ProtocolSummary {
  const events = parseProtocolEvents(timeline)
  if (events.length === 0) {
    return {
      label: 'Starting medium pending',
      detail: 'The run needs one starting medium at 0 min before it can be submitted.',
      eventCount: 0,
    }
  }

  const first = events[0]
  if (events.length === 1) {
    return {
      label: 'Static medium',
      detail: `Starts and remains in ${first.mediaId}.`,
      eventCount: events.length,
    }
  }

  return {
    label: `${events.length - 1} scheduled shift${events.length === 2 ? '' : 's'}`,
    detail: events.map((event) => `${Math.round(event.timeSec / 60)} min ${event.mediaId}`).join(', '),
    eventCount: events.length,
  }
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
  const [protocolHorizonSec, setProtocolHorizonSec] = useState(10800)

  // Gene search
  const [geneQuery, setGeneQuery] = useState(prefillGene)
  const [geneResults, setGeneResults] = useState<Gene[]>([])
  const [showGenePicker, setShowGenePicker] = useState(false)

  // Gene impact preview
  const [geneDetail, setGeneDetail] = useState<GeneDetail | null>(null)

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvancedVariants, setShowAdvancedVariants] = useState(false)

  const timelineBehavior = getTimelineBehavior(variantDetail)
  const hideVariantIndex = Boolean(variantDetail?.parameter_hints.hide_index)
  const timelineNotice = variantDetail?.parameter_hints.timeline_notice || ''
  const selectedVariantGroup = variantType ? VARIANT_TO_GROUP.get(variantType) : undefined
  const conditionalOverrideActive = isConditionalOverrideActive(variantType, variantIndex)
  const environmentLocked = timelineBehavior === 'internal_override'
    || (timelineBehavior === 'internal_conditional_override' && conditionalOverrideActive !== false)
  const effectiveTimelinePreview = getEffectiveTimelinePreview(
    variantType,
    variantIndex,
    conditions,
    timeline,
    variantDetail,
  )
  const minVariantIndex = getMinValidIndex(variantDetail)
  const maxVariantIndex = getMaxValidIndex(variantDetail)
  const parameterIndexGuide = getParameterIndexGuide(
    variantType,
    variantIndex,
    conditions,
    variantDetail,
  )
  const effectiveExperimentEnvironment = getEffectiveExperimentEnvironment(
    variantType,
    variantIndex,
    conditions,
    variantDetail,
    condition,
    timeline,
  )
  const environmentSourceLabel = getEnvironmentSourceLabel(
    variantType,
    timelineBehavior,
    conditionalOverrideActive,
  )
  const environmentStatusText = getEnvironmentStatusText(
    timelineBehavior,
    conditionalOverrideActive,
    environmentLocked,
  )
  const effectiveProtocolTimeline = effectiveExperimentEnvironment.timeline || effectiveTimelinePreview || ''
  const mediaProtocolEvents = parseProtocolEvents(effectiveProtocolTimeline)
  const mediaProtocolSummary = summarizeProtocol(effectiveProtocolTimeline)
  const maxProtocolEventSec = Math.max(60, ...mediaProtocolEvents.map((event) => event.timeSec))
  const estimatedLineageLimitHr = (generations * lengthSec / 3600).toFixed(1)
  const parameterSectionTitle = getParameterSectionTitle(variantType)
  const hasSemanticParameterControls = [
    'condition',
    'add_one_aa',
    'remove_one_aa',
    'add_one_aa_shift',
    'remove_one_aa_shift',
    'remove_aas_shift',
    'tf_activity',
    'ppgpp_conc',
    'sinusoidal_media',
  ].includes(variantType)
  const variantsByName = useMemo(() => new Map(variants.map((variant) => [variant.name, variant])), [variants])
  const visibleVariantGroups = useMemo(() => {
    return VARIANT_GROUPS
      .filter((group) => showAdvancedVariants || !group.advanced)
      .map((group) => ({
        ...group,
        options: group.variants
          .map((name) => variantsByName.get(name))
          .filter((variant): variant is Variant => variant !== undefined && !INTERNAL_VARIANTS.has(variant.name)),
      }))
      .filter((group) => group.options.length > 0)
  }, [showAdvancedVariants, variantsByName])

  useEffect(() => {
    if (maxProtocolEventSec > protocolHorizonSec) {
      setProtocolHorizonSec(maxProtocolEventSec)
    }
  }, [maxProtocolEventSec, protocolHorizonSec])

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
      if (VARIANT_TO_GROUP.get(prefillVariant)?.advanced) {
        setShowAdvancedVariants(true)
      }
    }
  }, [prefillVariant])

  useEffect(() => {
    if (variantType && VARIANT_TO_GROUP.get(variantType)?.advanced) {
      setShowAdvancedVariants(true)
    }
  }, [variantType])

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

  useEffect(() => {
    if (variantType === 'sinusoidal_media' && variantIndex < 1) {
      setVariantIndex(1)
    }
  }, [variantIndex, variantType])

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
        condition: effectiveExperimentEnvironment.condition,
        timeline: effectiveExperimentEnvironment.timeline,
        gene_symbol: geneSymbol,
        sim_params: JSON.stringify({ seeds, generations, length_sec: lengthSec }),
      }
      const experiment = await createExperiment(data)
      const nextParams = new URLSearchParams({
        created: String(experiment.id),
        experiment: String(experiment.id),
        condition: effectiveExperimentEnvironment.condition,
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
    <div className="mx-auto max-w-[1260px] px-1">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Design experiment</h1>
          <p className="mt-1 text-sm text-gray-500">
            Choose the perturbation, environment source, and run size.
            {' '}<Link to="/guide" className="text-brand-600 hover:text-brand-700 hover:underline">Documentation</Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Environment" value={environmentSourceLabel} tone={environmentLocked ? 'amber' : 'green'} />
          <StatusChip label="Media protocol" value={environmentStatusText} tone={environmentLocked ? 'amber' : 'green'} />
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
      <div className="space-y-4">
        {/* --- Experiment type --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Experiment type
            <HelpTip text="Each experiment type modifies the simulation in a specific way. 'Gene knockout' sets a gene's RNA expression to zero â€” the cell must grow without the protein it encodes. Other variants alter media composition, kinetic parameters, or regulatory logic." />
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
            {visibleVariantGroups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.options.map((v) => (
                  <option key={v.name} value={v.name}>{variantLabel(v.name)}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <div className="mt-3 flex items-start justify-between gap-3">
            <div>
              {selectedVariantGroup ? (
                <>
                  <p className="text-xs font-medium text-gray-700">{selectedVariantGroup.label}</p>
                  <p className="text-xs text-gray-500 mt-1">{selectedVariantGroup.description}</p>
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  Choose a user-facing workflow. Internal helpers and empty template variants are hidden.
                </p>
              )}
            </div>
            <label className="shrink-0 inline-flex items-center gap-2 text-xs text-gray-500">
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
            <div className="mt-3 space-y-3">
              {timelineBehavior !== 'composer' && (
                <div className="flex flex-wrap gap-2">
                  <StatusChip label="Condition" value="managed" tone="amber" />
                  <StatusChip label="Timeline" value={environmentLocked ? 'locked' : 'composer'} tone={environmentLocked ? 'amber' : 'green'} />
                </div>
              )}
              <TechnicalDetails title="Model notes">
                <p className="whitespace-pre-line">
                  {variantDetail.docstring.slice(0, 500)}
                  {variantDetail.docstring.length > 500 ? '...' : ''}
                </p>
                {variantDetail.parameter_hints.index_meaning && (
                  <p className="mt-2 border-t border-slate-200 pt-2">
                    Index: {variantDetail.parameter_hints.index_meaning}
                  </p>
                )}
                {variantType && timelineBehavior !== 'composer' && (
                  <p className="mt-2 border-t border-slate-200 pt-2">
                    {OVERRIDE_EXAMPLES[variantType] || timelineNotice || 'The selected variant manages part of the model environment internally.'}
                  </p>
                )}
              </TechnicalDetails>
            </div>
          )}
        </section>

        {/* --- Gene picker (for gene_knockout) --- */}
        {variantType === 'gene_knockout' && (
          <section className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
              Target gene
              <HelpTip text="The knockout sets this gene's RNA expression to zero. The model tracks all 4,749 genes, but only ~1,500 have mechanistic downstream effects (metabolic enzymes, transcription factors, ribosomal proteins). Knocking out a 'passenger' gene will show its protein declining to zero, but may not affect growth." />
            </h2>
            <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <p className="font-medium">Modeled knockout: RNA synthesis/expression is set to zero.</p>
              <p className="mt-1 text-blue-800">
                This approximates loss of gene product during the simulation. It does not physically delete the DNA locus or remodel neighboring genes, operons, promoters, or genome architecture.
              </p>
            </div>
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
          <section className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3">{parameterSectionTitle}</h2>
            {hasSemanticParameterControls ? (
              <SemanticParameterControls
                variantType={variantType}
                variantIndex={variantIndex}
                conditions={conditions}
                variantDetail={variantDetail}
                setVariantIndex={setVariantIndex}
                setCondition={setCondition}
              />
            ) : (
              <input
                type="number"
                value={variantIndex}
                onChange={(e) => setVariantIndex(Number(e.target.value))}
                min={minVariantIndex}
                max={maxVariantIndex}
                className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            )}
            {parameterIndexGuide && (
              <TechnicalDetails title="Runtime index details">
                {parameterIndexGuide.current && (
                  <p className={`text-xs mt-1 ${parameterIndexGuide.invalid ? 'text-amber-700' : 'text-gray-600'}`}>
                    Current selection: <span className="font-mono">{parameterIndexGuide.current}</span>
                  </p>
                )}
                {hasSemanticParameterControls && (
                  <p className="mt-2 text-xs text-slate-500">
                    Encoded runtime index: <span className="font-mono">{variantIndex}</span>
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
              </TechnicalDetails>
            )}
          </section>
        )}

        {/* --- Simulation parameters --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Simulation parameters
            <HelpTip text="Seeds are independent random replicates â€” each starts from a different initial state. Generations control how many cell divisions are simulated sequentially. More seeds give statistical power; more generations reveal long-term dynamics and potential lethality." />
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
              <p className="text-xs text-gray-400 mt-1">sequential lineage cells</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Max cell time (s)</label>
              <input
                type="number"
                value={lengthSec}
                onChange={(e) => setLengthSec(Math.max(60, Number(e.target.value)))}
                min={60}
                step={60}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                {(lengthSec / 3600).toFixed(1)} hr per cell; lineage limit &lt;= {estimatedLineageLimitHr} hr
              </p>
            </div>
          </div>
        </section>

        {/* --- Growth environment / media protocol --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
              Media protocol
              <HelpTip text="Select the starting medium and optional scheduled medium changes. A one-event protocol is a static medium, not a shift. The protocol is passed to the model as ordered time/media events." />
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip label="Source" value={environmentSourceLabel} tone={environmentLocked ? 'amber' : 'green'} />
              <StatusChip label="Protocol" value={mediaProtocolSummary.label} tone={mediaProtocolSummary.eventCount > 1 ? 'blue' : 'slate'} />
            </div>
          </div>
          {!environmentLocked && (
            <div className="mb-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600 md:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <p className="font-medium text-slate-700">{mediaProtocolSummary.label}</p>
                <p className="mt-1 break-words">{mediaProtocolSummary.detail}</p>
              </div>
              <label className="block">
                <span className="mb-1 block text-slate-400">Protocol view range (s)</span>
                <input
                  type="number"
                  value={protocolHorizonSec}
                  onChange={(e) => setProtocolHorizonSec(Math.max(maxProtocolEventSec, Number(e.target.value)))}
                  min={maxProtocolEventSec}
                  step={60}
                  className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                />
                <span className="mt-1 block text-slate-400">
                  {(protocolHorizonSec / 3600).toFixed(1)} hr display window
                </span>
              </label>
            </div>
          )}
          {timelineNotice && timelineBehavior !== 'composer' && (
            <TechnicalDetails title={environmentLocked ? 'Why media is locked' : 'Composer behavior'}>
              <p>{timelineNotice}</p>
              {effectiveTimelinePreview && conditionalOverrideActive !== false && (
                <p className="mt-2 break-all font-mono">
                  Effective model timeline: {effectiveTimelinePreview}
                </p>
              )}
            </TechnicalDetails>
          )}
          {environmentLocked ? (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip label="Media protocol" value="locked" tone="amber" />
                {effectiveTimelinePreview && (
                  <StatusChip label="Timeline" value={effectiveTimelinePreview} tone="slate" />
                )}
              </div>
            </div>
          ) : (
            <TimelineComposer
              mediaRecipes={mediaRecipes}
              conditions={conditions}
              onChange={setTimeline}
              maxSec={protocolHorizonSec}
            />
          )}
        </section>

        {/* --- Name & description --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-4">
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

      </div>

      <aside className="xl:sticky xl:top-4">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Run summary</h2>
            <StatusChip label="Save" value={name.trim() && variantType ? 'ready' : 'incomplete'} tone={name.trim() && variantType ? 'green' : 'amber'} />
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Experiment</dt>
              <dd className="mt-1 font-medium text-slate-900">{variantType ? variantLabel(variantType) : 'Select a type'}</dd>
            </div>
            {geneSymbol && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Gene</dt>
                <dd className="mt-1 font-mono text-slate-900">{geneSymbol}</dd>
              </div>
            )}
            {parameterIndexGuide?.current && variantType !== 'gene_knockout' && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">{parameterSectionTitle}</dt>
                <dd className={`mt-1 text-xs ${parameterIndexGuide.invalid ? 'text-amber-700' : 'text-slate-700'}`}>
                  {parameterIndexGuide.current}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Saved condition</dt>
              <dd className="mt-1 font-mono text-slate-900">{effectiveExperimentEnvironment.condition}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Environment source</dt>
              <dd className="mt-1 flex flex-wrap gap-2">
                <StatusChip label="Environment" value={environmentSourceLabel} tone={environmentLocked ? 'amber' : 'green'} />
                <StatusChip label="Media protocol" value={environmentStatusText} tone={environmentLocked ? 'amber' : 'green'} />
                <StatusChip label="Protocol" value={mediaProtocolSummary.label} tone={mediaProtocolSummary.eventCount > 1 ? 'blue' : 'slate'} />
              </dd>
            </div>
            {(effectiveExperimentEnvironment.timeline || effectiveTimelinePreview) && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Timeline</dt>
                <dd className="mt-1 break-all font-mono text-xs text-slate-700">
                  {effectiveExperimentEnvironment.timeline || effectiveTimelinePreview}
                </dd>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Replicates</dt>
                <dd className="mt-1 text-slate-900">{seeds} x {generations} gen</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Max cell time</dt>
                <dd className="mt-1 text-slate-900">{(lengthSec / 3600).toFixed(1)} hr</dd>
                <dd className="mt-0.5 text-xs text-slate-400">lineage &lt;= {estimatedLineageLimitHr} hr</dd>
              </div>
            </div>
          </dl>

          <div className="mt-5 grid gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !variantType || !name.trim()}
              className="w-full px-5 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save experiment'}
            </button>
            <button
              onClick={() => navigate('/experiments')}
              className="w-full px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </section>
      </aside>
      </div>
    </div>
  )
}
