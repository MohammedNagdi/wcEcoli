import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import {
  createBuilderDraft,
  getBuilderDrafts,
  getConditionCatalog,
  previewBuilderDraft,
  publishBuilderDraft,
  updateBuilderDraft,
} from '../../api/client'
import type {
  BuilderDraft,
  BuilderDraftCollection,
  BuilderPublishPreview,
  Condition,
  ConditionCatalog,
  ConditionRecord,
  EnvironmentMolecule,
  MediaStock,
  MediaRecipe,
  MediaRecipeRecord,
  TimelineRecord,
  TfConditionRecord,
} from '../../types'
import { HelpTip } from '../common/HelpTip'
import { SearchInput } from '../common/SearchInput'
import { TimelineComposer } from './TimelineComposer'

type SaveSectionKey = 'media' | 'mediaRecipe' | 'condition' | 'tfCondition' | 'timeline'
type SectionMode = 'existing' | 'create'

type DraftMediaRow = {
  id: string
  molecule_id: string
  concentration: string
}

type DraftEnvironmentRow = {
  id: string
  molecule_id: string
  exchange_molecule_location: string
  formula_weight: string
}

type DraftTfConditionRow = {
  id: string
  tf: string
  active_tf: string
  active_nutrients: string
  active_genotype_perturbations: string
  inactive_nutrients: string
  inactive_genotype_perturbations: string
  tf_type: string
}

type DependencyStepId = 'media' | 'environment' | 'mediaRecipe' | 'condition' | 'tfCondition' | 'timeline'

type DependencyStep = {
  id: DependencyStepId
  file: string
  label: string
  question: string
  summary: string
  definition: string
  needs: string
  creates: string
  unlocks: string
  branch?: boolean
}

const DEPENDENCY_SECTION_TARGETS: Record<DependencyStepId, SaveSectionKey> = {
  media: 'media',
  environment: 'media',
  mediaRecipe: 'mediaRecipe',
  condition: 'condition',
  tfCondition: 'tfCondition',
  timeline: 'timeline',
}

const SECTION_LABELS: Record<SaveSectionKey, string> = {
  media: 'Medium Stock',
  mediaRecipe: 'Media Recipe',
  condition: 'Growth Condition',
  tfCondition: 'TF State Rules',
  timeline: 'Media Protocol',
}

const MAIN_SECTION_KEYS: SaveSectionKey[] = ['media', 'mediaRecipe', 'condition', 'tfCondition', 'timeline']

const DEFAULT_COLLAPSED_SECTIONS: Record<SaveSectionKey, boolean> = {
  media: false,
  mediaRecipe: false,
  condition: false,
  tfCondition: false,
  timeline: false,
}

const DEPENDENCY_STEPS: DependencyStep[] = [
  {
    id: 'media',
    file: 'condition/media/*.tsv',
    label: 'Medium stock',
    question: 'What raw medium stock am I starting from?',
    summary: 'Choose the extracellular molecule and concentration table.',
    definition: 'A medium stock lists extracellular molecules and concentrations. Finite values cap availability; Infinity means the molecule is treated as unconstrained for the run.',
    needs: 'Known molecule IDs.',
    creates: 'A stock name such as MIX0-57.',
    unlocks: 'Used as the base of a media recipe.',
  },
  {
    id: 'environment',
    file: 'condition/environment_molecules.tsv',
    label: 'Exchange molecule registry',
    question: 'Do I need a new exchange molecule ID?',
    summary: 'Registers new molecule IDs.',
    definition: 'Use this only when a medium needs a molecule ID that the reconstruction does not already know. Most common metabolites are already registered.',
    needs: 'Only if a new medium needs a new ID.',
    creates: 'Molecule IDs such as MY_CARBON_SRC.',
    unlocks: 'Those IDs can be used in media stocks and recipes.',
    branch: true,
  },
  {
    id: 'mediaRecipe',
    file: 'condition/media_recipes.tsv',
    label: 'Media recipe',
    question: 'How should this media recipe be assembled for experiments?',
    summary: 'Choose or define the recipe operation: base stock, optional mixed stock, and ingredient additions or removals.',
    definition: 'A recipe combines a base medium stock with supplements or ingredients and assigns one short ID, such as minimal_acetate. Downstream records use this recipe ID instead of the raw stock name.',
    needs: 'A base medium and any ingredient IDs.',
    creates: 'A recipe ID such as minimal_acetate.',
    unlocks: 'Used as nutrients in growth conditions.',
  },
  {
    id: 'condition',
    file: 'condition/condition_defs.tsv',
    label: 'Growth condition',
    question: 'What biological growth condition should this recipe represent?',
    summary: 'Attach biological context such as expected growth, TF lists, and genotype perturbations.',
    definition: 'A growth condition ties a media recipe to expected growth behavior and regulatory state. This is what later appears as a selectable condition for experiments.',
    needs: 'A recipe ID from Media Recipe.',
    creates: 'A condition name, nutrients, TF lists, and doubling time.',
    unlocks: 'Keeps TF rules aligned to the same setup.',
  },
  {
    id: 'tfCondition',
    file: 'condition/tf_condition.tsv',
    label: 'TF state rules',
    question: 'Which TF state rules belong to this recipe?',
    summary: 'Select reconstruction rules that explain active or inactive TF states.',
    definition: 'These optional rows describe when a TF complex is active or inactive under nutrient contexts. They are not a free-form TF knockout; they encode reconstruction-level regulatory states.',
    needs: 'The same recipe context used by the growth condition.',
    creates: 'Active and inactive TF rules.',
    unlocks: 'Finishes the regulatory context before building a protocol.',
  },
  {
    id: 'timeline',
    file: 'condition/timelines_def.tsv',
    label: 'Media protocol',
    question: 'Does the environment stay constant or shift over time?',
    summary: 'Choose a static medium or a time-ordered media-shift protocol.',
    definition: 'A protocol is a time-ordered list of recipe changes, for example "0 minimal, 3600 minimal_acetate". The UI shows minutes and hours; published catalog rows store event times in seconds.',
    needs: 'Recipe IDs; the first event should start from the current recipe.',
    creates: 'The final protocol string.',
    unlocks: 'A complete experiment-ready setup.',
  },
]

let idCounter = 0

function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function parseTimelineEvents(events: string) {
  return events
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [timeSec, mediaId] = part.split(/\s+/, 2)
      return { timeSec, mediaId }
    })
    .filter((entry) => entry.timeSec && entry.mediaId)
}

function firstTimelineMedia(events: string) {
  return parseTimelineEvents(events)[0]?.mediaId || ''
}

function formatSecondsHuman(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min'
  if (seconds % 3600 === 0) return `${seconds / 3600} hr`
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hr`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

function summarizeMediaProtocol(events: string) {
  const parsed = parseTimelineEvents(events)
  if (parsed.length === 0) {
    return {
      label: 'No protocol selected',
      detail: 'Choose a media recipe or add a protocol event.',
    }
  }

  if (parsed.length === 1) {
    return {
      label: 'Static medium',
      detail: `Starts and stays in ${parsed[0].mediaId}.`,
    }
  }

  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  const lastTimeSec = Number(last.timeSec)
  return {
    label: `${parsed.length - 1} scheduled shift${parsed.length === 2 ? '' : 's'}`,
    detail: `Starts in ${first.mediaId}; last event switches to ${last.mediaId} at ${formatSecondsHuman(lastTimeSec)}.`,
  }
}

function hasJsonContent(value: string | undefined | null) {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed || trimmed === '{}' || trimmed === '[]') return false
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.length > 0
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0
    return Boolean(parsed)
  } catch {
    return true
  }
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function parseStringArray(value: string | undefined | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

function stringifyStringArray(values: string[]) {
  return JSON.stringify(values)
}

function addToJsonArray(value: string, item: string) {
  if (!item) return value
  const values = parseStringArray(value)
  if (values.includes(item)) return stringifyStringArray(values)
  return stringifyStringArray([...values, item])
}

function removeJsonArrayIndex(value: string, index: number) {
  const values = parseStringArray(value)
  return stringifyStringArray(values.filter((_, itemIndex) => itemIndex !== index))
}

function parseRecipeEditArray(value: string | undefined | null) {
  const trimmed = (value || '').trim()
  if (!trimmed || trimmed === '[]') return { values: [] as string[], error: '' }
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return { values: [] as string[], error: 'Use bracketed array syntax such as [] or [Infinity].' }
  }

  const body = trimmed.slice(1, -1).trim()
  if (!body) return { values: [] as string[], error: '' }
  const values = body.split(',').map((item) => item.trim()).filter(Boolean)
  const invalid = values.find((item) => (
    item !== 'Infinity'
    && item !== '-Infinity'
    && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(item)
  ))
  if (invalid) {
    return { values, error: `Invalid edit value "${invalid}". Use numbers, Infinity, or -Infinity.` }
  }
  return { values, error: '' }
}

function stringifyRecipeEditArray(values: string[]) {
  return `[${values.join(',')}]`
}

function addToRecipeEditArray(value: string, item = 'Infinity') {
  const parsed = parseRecipeEditArray(value)
  if (parsed.error) return value
  return stringifyRecipeEditArray([...parsed.values, item])
}

function upsertJsonObjectValue(value: string, key: string, nextValue: number | string) {
  if (!key) return value
  let parsed: Record<string, unknown> = {}
  try {
    const candidate = JSON.parse(value || '{}')
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    parsed = {}
  }
  return JSON.stringify({ ...parsed, [key]: nextValue })
}

function jsonObjectKeys(value: string | undefined | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []
  } catch {
    return []
  }
}

function classifyTfRuleScope(row: Pick<TfConditionRecord, 'active_genotype_perturbations' | 'inactive_genotype_perturbations'>) {
  const hasActiveGenotype = hasJsonContent(row.active_genotype_perturbations)
  const hasInactiveGenotype = hasJsonContent(row.inactive_genotype_perturbations)
  if (hasActiveGenotype && hasInactiveGenotype) return 'nutrient + genotype state'
  if (hasActiveGenotype || hasInactiveGenotype) return 'genotype-dependent state'
  return 'nutrient state'
}

function tfRuleKey(row: Pick<TfConditionRecord, 'tf' | 'active_tf' | 'active_nutrients' | 'inactive_nutrients' | 'active_genotype_perturbations' | 'inactive_genotype_perturbations' | 'tf_type'>) {
  return [
    row.tf,
    row.active_tf,
    row.active_nutrients,
    row.inactive_nutrients,
    row.active_genotype_perturbations,
    row.inactive_genotype_perturbations,
    row.tf_type,
  ].join('|')
}

function protocolInvolvesMedia(timeline: TimelineRecord, mediaId: string) {
  return parseTimelineEvents(timeline.events).some((event) => event.mediaId === mediaId)
}

function sortProtocolsForMedia(timelines: TimelineRecord[], mediaId: string) {
  const starts: TimelineRecord[] = []
  const involves: TimelineRecord[] = []
  timelines.forEach((timeline) => {
    const firstMedia = firstTimelineMedia(timeline.events)
    if (firstMedia === mediaId) {
      starts.push(timeline)
    } else if (protocolInvolvesMedia(timeline, mediaId)) {
      involves.push(timeline)
    }
  })
  return { starts, involves, all: [...starts, ...involves] }
}

function stringifySnapshot(value: unknown) {
  return JSON.stringify(value)
}

function compactRows<T>(rows: T[], predicate: (row: T) => boolean) {
  return rows.filter(predicate)
}

function toComposerMediaRecipes(catalog: ConditionCatalog | null, draftRecipe: MediaRecipeRecord | null): MediaRecipe[] {
  const baseRecipes = (catalog?.media_recipes || []).map((recipe, index) => ({
    id: index + 1,
    media_id: recipe.media_id,
    base_media: recipe.base_media,
    added_media: recipe.added_media,
    ingredients: recipe.ingredients,
  }))

  if (!draftRecipe || !draftRecipe.media_id.trim()) {
    return baseRecipes
  }

  const nextRecipe: MediaRecipe = {
    id: -1,
    media_id: draftRecipe.media_id,
    base_media: draftRecipe.base_media,
    added_media: draftRecipe.added_media,
    ingredients: draftRecipe.ingredients,
  }

  const existingIndex = baseRecipes.findIndex((recipe) => recipe.media_id === nextRecipe.media_id)
  if (existingIndex >= 0) {
    const updated = [...baseRecipes]
    updated[existingIndex] = nextRecipe
    return updated
  }

  return [...baseRecipes, nextRecipe]
}

function toComposerConditions(catalog: ConditionCatalog | null, draftCondition: ConditionRecord | null): Condition[] {
  const baseConditions = (catalog?.conditions || []).map((condition) => ({
    name: condition.condition,
    nutrients: condition.nutrients,
    doubling_time: Number(condition.doubling_time || 0) || null,
  }))

  if (!draftCondition || !draftCondition.condition.trim()) {
    return baseConditions
  }

  const nextCondition: Condition = {
    name: draftCondition.condition,
    nutrients: draftCondition.nutrients,
    doubling_time: Number(draftCondition.doubling_time || 0) || null,
  }

  const existingIndex = baseConditions.findIndex((condition) => condition.name === nextCondition.name)
  if (existingIndex >= 0) {
    const updated = [...baseConditions]
    updated[existingIndex] = nextCondition
    return updated
  }

  return [...baseConditions, nextCondition]
}

function SectionStatus({ saved, dirty }: { saved: boolean; dirty: boolean }) {
  let classes = 'bg-slate-100 text-slate-600'
  let label = 'Not saved'

  if (saved && !dirty) {
    classes = 'bg-emerald-50 text-emerald-700'
    label = 'Saved'
  } else if (saved && dirty) {
    classes = 'bg-amber-50 text-amber-700'
    label = 'Unsaved changes'
  }

  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${classes}`}>{label}</span>
}

function publishActionClasses(action: string) {
  const normalized = action.toLowerCase()
  if (normalized.includes('reject') || normalized.includes('conflict')) return 'bg-red-50 text-red-700 border-red-100'
  if (normalized.includes('create')) return 'bg-blue-50 text-blue-700 border-blue-100'
  if (normalized.includes('append')) return 'bg-emerald-50 text-emerald-700 border-emerald-100'
  if (normalized.includes('update')) return 'bg-amber-50 text-amber-700 border-amber-100'
  return 'bg-white text-slate-500 border-slate-200'
}

function SectionSaveActions({
  saved,
  dirty,
  onSave,
  saving = false,
  onPublish,
  publishing = false,
  publishDisabled = false,
}: {
  saved: boolean
  dirty: boolean
  onSave: () => void
  saving?: boolean
  onPublish?: () => void
  publishing?: boolean
  publishDisabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <SectionStatus saved={saved} dirty={dirty} />
      {onPublish && (
        <button
          type="button"
          onClick={onPublish}
          disabled={publishDisabled || publishing || saving}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {publishing ? 'Reviewing...' : 'Publish'}
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={saving || publishing}
        className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function latestDraftsBySection(collection: BuilderDraftCollection): Partial<Record<SaveSectionKey, BuilderDraft>> {
  const lastDraft = (drafts: BuilderDraft[]) => drafts[drafts.length - 1]

  return {
    media: lastDraft(collection.media),
    mediaRecipe: lastDraft(collection.mediaRecipe),
    condition: lastDraft(collection.condition),
    tfCondition: lastDraft(collection.tfCondition),
    timeline: lastDraft(collection.timeline),
  }
}

function SectionCard({
  title,
  subtitle,
  children,
  actions,
  sectionId,
  highlighted = false,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
}: {
  title: string
  subtitle: string
  children: ReactNode
  actions?: ReactNode
  sectionId?: SaveSectionKey
  highlighted?: boolean
  collapsible?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  return (
    <section
      id={sectionId ? `builder-section-${sectionId}` : undefined}
      className={`scroll-mt-24 rounded-2xl border bg-white p-5 shadow-sm transition-all duration-300 ${
        highlighted ? 'border-cyan-300 ring-2 ring-cyan-200' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        {(actions || collapsible) && (
          <div className="flex items-center gap-2">
            {actions}
            {collapsible && onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-expanded={!collapsed}
                aria-label={collapsed ? 'Expand section' : 'Collapse section'}
                title={collapsed ? 'Expand section' : 'Collapse section'}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 transition-colors hover:bg-slate-100"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                >
                  <path
                    d="M6 3.5L10.5 8L6 12.5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
      <div className={collapsed ? 'mt-5 hidden' : 'mt-5'}>{children}</div>
    </section>
  )
}

function FieldLabel({
  label,
  tooltip,
  hint,
}: {
  label: string
  tooltip?: string
  hint?: string
}) {
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5">
        <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {tooltip && <HelpTip text={tooltip} position="top-start" />}
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

function ExistingCreateToggle({
  mode,
  onChange,
  existingLabel = 'Choose existing',
  createLabel = 'Create new',
}: {
  mode: SectionMode
  onChange: (mode: SectionMode) => void
  existingLabel?: string
  createLabel?: string
}) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
      <button
        type="button"
        onClick={() => onChange('existing')}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === 'existing' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {existingLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange('create')}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === 'create' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {createLabel}
      </button>
    </div>
  )
}

function SavedStatePanel({
  sectionSummaries,
  isSaved,
  isDirty,
}: {
  sectionSummaries: Record<SaveSectionKey, string>
  isSaved: (section: SaveSectionKey) => boolean
  isDirty: (section: SaveSectionKey) => boolean
}) {
  return (
    <SectionCard
      title="Build summary"
      subtitle="Reusable records created here become options in experiment design after publish."
    >
      <div className="space-y-3 text-sm">
        {MAIN_SECTION_KEYS.map((section) => (
          <div key={section} className="rounded-xl bg-slate-50 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-slate-700">{SECTION_LABELS[section]}</span>
              <SectionStatus saved={isSaved(section)} dirty={isDirty(section)} />
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">{sectionSummaries[section]}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

type DependencyBadge = {
  label: string
  classes: string
}

function getDependencyBadge({
  stepId,
  mediaMode,
  hasDraftEnvironmentMolecules,
  currentMediaRecipeId,
  currentConditionName,
  tfRuleCount,
}: {
  stepId: DependencyStepId
  mediaMode: SectionMode
  hasDraftEnvironmentMolecules: boolean
  currentMediaRecipeId: string
  currentConditionName: string
  tfRuleCount: number
}): DependencyBadge {
  if (stepId === 'environment') {
    if (mediaMode === 'existing') {
      return {
        label: 'Usually reused',
        classes: 'bg-slate-100 text-slate-600',
      }
    }

    return {
      label: hasDraftEnvironmentMolecules ? 'Review new IDs' : 'Only if you add new IDs',
      classes: 'bg-amber-50 text-amber-700',
    }
  }

  if (stepId === 'media') {
    if (mediaMode === 'existing') {
      return {
        label: 'Reused from catalog',
        classes: 'bg-slate-100 text-slate-600',
      }
    }

    return {
      label: 'Drafting now',
      classes: 'bg-cyan-50 text-cyan-700',
    }
  }

  if (stepId === 'timeline') {
    return {
      label: currentMediaRecipeId ? 'Final step' : 'Can draft now',
      classes: 'bg-emerald-50 text-emerald-700',
    }
  }

  if (stepId === 'mediaRecipe' && !currentMediaRecipeId) {
    return {
      label: 'Needed next',
      classes: 'bg-slate-100 text-slate-600',
    }
  }

  if (stepId === 'condition' && !currentConditionName) {
    return {
      label: 'Define after recipe',
      classes: 'bg-slate-100 text-slate-600',
    }
  }

  if (stepId === 'tfCondition' && tfRuleCount === 0) {
    return {
      label: 'Add or select rules',
      classes: 'bg-slate-100 text-slate-600',
    }
  }

  return {
    label: stepId === 'tfCondition' ? 'Aligned before scheduling' : 'Define or align now',
    classes: 'bg-cyan-50 text-cyan-700',
  }
}

function getSectionSummaries({
  mediaMode,
  currentMediaStockName,
  draftMediaStockName,
  draftMediaRows,
  effectiveMediaRecipe,
  effectiveCondition,
  effectiveTfRows,
  effectiveTimelineName,
  effectiveTimelineEvents,
  currentScheduleStartReference,
}: {
  mediaMode: SectionMode
  currentMediaStockName: string
  draftMediaStockName: string
  draftMediaRows: DraftMediaRow[]
  effectiveMediaRecipe: MediaRecipeRecord | null | undefined
  effectiveCondition: ConditionRecord | null | undefined
  effectiveTfRows: Array<TfConditionRecord | DraftTfConditionRow>
  effectiveTimelineName: string
  effectiveTimelineEvents: string
  currentScheduleStartReference: string
}): Record<SaveSectionKey, string> {
  const protocolSummary = summarizeMediaProtocol(effectiveTimelineEvents)
  return {
    media: mediaMode === 'existing'
      ? `Using stock ${currentMediaStockName || 'none selected'}`
      : `${draftMediaStockName || 'Untitled stock'} with ${compactRows(draftMediaRows, (row) => Boolean(row.molecule_id.trim())).length} molecules`,
    mediaRecipe: effectiveMediaRecipe
      ? `${effectiveMediaRecipe.media_id} from ${effectiveMediaRecipe.base_media}`
      : 'Choose or create a media recipe',
    condition: effectiveCondition
      ? `${effectiveCondition.condition} on ${effectiveCondition.nutrients}`
      : 'Choose or create a growth condition',
    tfCondition: effectiveTfRows.length > 0
      ? `${effectiveTfRows.length} TF rule${effectiveTfRows.length === 1 ? '' : 's'} ready`
      : 'No TF rules selected yet',
    timeline: `${effectiveTimelineName || 'draft protocol'}: ${protocolSummary.label}; starts at ${currentScheduleStartReference}`,
  }
}

export function EnvironmentBuilderPage() {
  const location = useLocation()
  const [catalog, setCatalog] = useState<ConditionCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const [dependencyOpen, setDependencyOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [environmentSearch, setEnvironmentSearch] = useState('')
  const [highlightedSection, setHighlightedSection] = useState<SaveSectionKey | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<SaveSectionKey, boolean>>(DEFAULT_COLLAPSED_SECTIONS)
  const [builderDrafts, setBuilderDrafts] = useState<Partial<Record<SaveSectionKey, BuilderDraft>>>({})
  const [savingSection, setSavingSection] = useState<SaveSectionKey | null>(null)
  const [publishingSection, setPublishingSection] = useState<SaveSectionKey | null>(null)

  const [mediaMode, setMediaMode] = useState<SectionMode>('existing')
  const [selectedMediaStockName, setSelectedMediaStockName] = useState('')
  const [draftMediaStockName, setDraftMediaStockName] = useState('MY_NEW_MIX')
  const [draftMediaRows, setDraftMediaRows] = useState<DraftMediaRow[]>([
    { id: nextId('media-row'), molecule_id: 'MY_CARBON_SRC', concentration: '10.0' },
    { id: nextId('media-row'), molecule_id: 'WATER', concentration: 'Infinity' },
  ])
  const [draftEnvironmentRows, setDraftEnvironmentRows] = useState<DraftEnvironmentRow[]>([
    { id: nextId('env-row'), molecule_id: 'MY_CARBON_SRC', exchange_molecule_location: '[p]', formula_weight: 'None' },
  ])

  const [mediaRecipeMode, setMediaRecipeMode] = useState<SectionMode>('existing')
  const [selectedMediaRecipeId, setSelectedMediaRecipeId] = useState('')
  const [selectedIngredientId, setSelectedIngredientId] = useState('')
  const [selectedConditionStateId, setSelectedConditionStateId] = useState('')
  const [selectedConditionActiveTfId, setSelectedConditionActiveTfId] = useState('')
  const [selectedConditionInactiveTfId, setSelectedConditionInactiveTfId] = useState('')
  const [draftMediaRecipe, setDraftMediaRecipe] = useState<MediaRecipeRecord>({
    media_id: 'my_new_media',
    base_media: 'MY_NEW_MIX',
    base_media_volume: '1.0',
    added_media: '',
    added_media_volume: '0',
    ingredients: '["MY_CARBON_SRC"]',
    ingredients_weight: '[]',
    ingredients_counts: '[Infinity]',
    ingredients_volume: '[]',
  })

  const [conditionMode, setConditionMode] = useState<SectionMode>('existing')
  const [selectedConditionName, setSelectedConditionName] = useState('')
  const [draftCondition, setDraftCondition] = useState<ConditionRecord>({
    condition: 'my_condition',
    nutrients: 'minimal',
    genotype_perturbations: '{}',
    doubling_time: '44.0',
    active_tfs: '[]',
    inactive_tfs: '[]',
  })

  const [tfConditionMode, setTfConditionMode] = useState<SectionMode>('existing')
  const [selectedExistingTfKeys, setSelectedExistingTfKeys] = useState<string[]>([])
  const [draftTfRows, setDraftTfRows] = useState<DraftTfConditionRow[]>([
    {
      id: nextId('tf-row'),
      tf: 'crp',
      active_tf: 'CPLX0-226',
      active_nutrients: 'minimal_acetate',
      active_genotype_perturbations: '{}',
      inactive_nutrients: 'minimal',
      inactive_genotype_perturbations: '{}',
      tf_type: '1CS',
    },
  ])

  const [timelineMode, setTimelineMode] = useState<SectionMode>('existing')
  const [selectedTimelineId, setSelectedTimelineId] = useState('')
  const [draftTimelineName, setDraftTimelineName] = useState('000028_my_timeline')
  const [draftTimelineEvents, setDraftTimelineEvents] = useState('')
  const [timelineDurationSec, setTimelineDurationSec] = useState(10800)
  const [timelineSeedVersion, setTimelineSeedVersion] = useState(0)

  const [savedSnapshots, setSavedSnapshots] = useState<Partial<Record<SaveSectionKey, string>>>({})
  const [previewSection, setPreviewSection] = useState<SaveSectionKey | null>(null)
  const [publishPreview, setPublishPreview] = useState<BuilderPublishPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [pendingPublishDraft, setPendingPublishDraft] = useState<BuilderDraft | null>(null)

  useEffect(() => {
    let alive = true
    getConditionCatalog()
      .then((nextCatalog) => {
        if (!alive) return
        setCatalog(nextCatalog)
      })
      .catch((error: Error) => {
        if (!alive) return
        setLoadError(error.message || 'Failed to load the reconstruction condition catalog')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    getBuilderDrafts()
      .then((collection) => {
        if (!alive) return
        const latestDrafts = latestDraftsBySection(collection)
        hydrateDraftState(latestDrafts)
        setBuilderDrafts(latestDrafts)
        setSavedSnapshots((current) => {
          const next = { ...current }
          MAIN_SECTION_KEYS.forEach((section) => {
            const draft = latestDrafts[section]
            if (draft) {
              next[section] = stringifySnapshot(draft.payload)
            }
          })
          return next
        })
      })
      .catch((error: Error) => {
        if (!alive) return
        setActionMessage({
          type: 'error',
          text: error.message || 'Failed to load saved builder drafts.',
        })
      })

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!actionMessage) return
    const timer = setTimeout(() => setActionMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [actionMessage])

  const mediaStocks = catalog?.media_stocks || []
  const environmentMolecules = catalog?.environment_molecules || []
  const allMediaRecipes = catalog?.media_recipes || []
  const allConditions = catalog?.conditions || []
  const allTfConditions = catalog?.tf_conditions || []
  const allTimelines = catalog?.timelines || []

  const recipeCountsByBaseStock = useMemo(() => {
    const counts = new Map<string, number>()
    allMediaRecipes.forEach((recipe) => {
      counts.set(recipe.base_media, (counts.get(recipe.base_media) || 0) + 1)
    })
    return counts
  }, [allMediaRecipes])

  const recipeCountsByAddedStock = useMemo(() => {
    const counts = new Map<string, number>()
    allMediaRecipes.forEach((recipe) => {
      if (!recipe.added_media) return
      counts.set(recipe.added_media, (counts.get(recipe.added_media) || 0) + 1)
    })
    return counts
  }, [allMediaRecipes])

  const conditionCountsByRecipe = useMemo(() => {
    const counts = new Map<string, number>()
    allConditions.forEach((condition) => {
      counts.set(condition.nutrients, (counts.get(condition.nutrients) || 0) + 1)
    })
    return counts
  }, [allConditions])

  const tfCountsByRecipe = useMemo(() => {
    const counts = new Map<string, number>()
    allTfConditions.forEach((row) => {
      if (row.active_nutrients) {
        counts.set(row.active_nutrients, (counts.get(row.active_nutrients) || 0) + 1)
      }
      if (row.inactive_nutrients && row.inactive_nutrients !== row.active_nutrients) {
        counts.set(row.inactive_nutrients, (counts.get(row.inactive_nutrients) || 0) + 1)
      }
    })
    return counts
  }, [allTfConditions])

  const protocolCountsByRecipe = useMemo(() => {
    const starts = new Map<string, number>()
    const involves = new Map<string, number>()
    allTimelines.forEach((timeline) => {
      const events = parseTimelineEvents(timeline.events)
      const firstMedia = events[0]?.mediaId
      const seen = new Set(events.map((event) => event.mediaId))
      if (firstMedia) {
        starts.set(firstMedia, (starts.get(firstMedia) || 0) + 1)
      }
      seen.forEach((mediaId) => {
        involves.set(mediaId, (involves.get(mediaId) || 0) + 1)
      })
    })
    return { starts, involves }
  }, [allTimelines])

  function mediaStockStatus(stock: MediaStock) {
    const baseCount = recipeCountsByBaseStock.get(stock.name) || 0
    const addedCount = recipeCountsByAddedStock.get(stock.name) || 0
    if (baseCount > 0) {
      return {
        role: 'base stock',
        detail: formatCountLabel(baseCount, 'recipe'),
        className: 'bg-emerald-50 text-emerald-700',
      }
    }
    if (addedCount > 0) {
      return {
        role: 'supplement stock',
        detail: `used by ${formatCountLabel(addedCount, 'recipe')}`,
        className: 'bg-amber-50 text-amber-700',
      }
    }
    return {
      role: 'no recipe',
      detail: 'not selectable by experiments until a recipe uses it',
      className: 'bg-slate-100 text-slate-600',
    }
  }

  function mediaRecipeStatus(recipe: MediaRecipeRecord) {
    const conditionCount = conditionCountsByRecipe.get(recipe.media_id) || 0
    const tfCount = tfCountsByRecipe.get(recipe.media_id) || 0
    const startsCount = protocolCountsByRecipe.starts.get(recipe.media_id) || 0
    const involvesCount = protocolCountsByRecipe.involves.get(recipe.media_id) || 0
    const protocolLabel = startsCount > 0
      ? `starts ${formatCountLabel(startsCount, 'protocol')}`
      : involvesCount > 0
        ? `appears in ${formatCountLabel(involvesCount, 'protocol')}`
        : 'no protocol'
    return [
      conditionCount > 0 ? formatCountLabel(conditionCount, 'condition') : 'recipe only',
      protocolLabel,
      tfCount > 0 ? formatCountLabel(tfCount, 'TF rule') : 'no TF rule',
    ]
  }

  const currentMediaStockName = mediaMode === 'existing'
    ? selectedMediaStockName
    : draftMediaStockName.trim() || 'MY_NEW_MIX'

  const defaultExistingMediaStockName = useMemo(() => {
    if (!mediaStocks.length) return ''
    const recipeBackedStocks = new Set(allMediaRecipes.map((recipe) => recipe.base_media))
    return mediaStocks.find((stock) => stock.name === 'MIX0-57')?.name
      || mediaStocks.find((stock) => recipeBackedStocks.has(stock.name))?.name
      || mediaStocks[0].name
  }, [allMediaRecipes, mediaStocks])

  const stockMediaOptions = useMemo(
    () => Array.from(new Set([...mediaStocks.map((stock) => stock.name), currentMediaStockName])).filter(Boolean),
    [currentMediaStockName, mediaStocks],
  )

  const compatibleMediaRecipes = useMemo(() => {
    if (!currentMediaStockName) return allMediaRecipes
    return allMediaRecipes.filter((recipe) => recipe.base_media === currentMediaStockName)
  }, [allMediaRecipes, currentMediaStockName])

  const selectedExistingMediaRecipe = compatibleMediaRecipes.find((recipe) => recipe.media_id === selectedMediaRecipeId) || null
  const effectiveMediaRecipe = mediaRecipeMode === 'existing'
    ? selectedExistingMediaRecipe
    : {
      ...draftMediaRecipe,
      base_media: draftMediaRecipe.base_media || currentMediaStockName,
    }

  const builderMediaRecipes = useMemo(
    () => toComposerMediaRecipes(catalog, mediaRecipeMode === 'create' ? effectiveMediaRecipe : null),
    [catalog, effectiveMediaRecipe, mediaRecipeMode],
  )

  const currentMediaRecipeId = effectiveMediaRecipe?.media_id || ''
  const selectedStock = mediaStocks.find((stock) => stock.name === selectedMediaStockName) || null
  const selectedStockStatus = selectedStock ? mediaStockStatus(selectedStock) : null
  const compatibleConditions = useMemo(() => {
    if (!currentMediaRecipeId) return allConditions
    return allConditions.filter((condition) => condition.nutrients === currentMediaRecipeId)
  }, [allConditions, currentMediaRecipeId])

  const selectedExistingCondition = compatibleConditions.find((condition) => condition.condition === selectedConditionName) || null
  const effectiveCondition = conditionMode === 'existing'
    ? selectedExistingCondition
    : {
      ...draftCondition,
      nutrients: draftCondition.nutrients || currentMediaRecipeId,
    }

  const builderConditions = useMemo(
    () => toComposerConditions(catalog, conditionMode === 'create' ? effectiveCondition : null),
    [catalog, conditionMode, effectiveCondition],
  )

  const compatibleTfConditions = useMemo(() => {
    if (!currentMediaRecipeId) return allTfConditions
    return allTfConditions.filter((row) => (
      row.active_nutrients === currentMediaRecipeId || row.inactive_nutrients === currentMediaRecipeId
    ))
  }, [allTfConditions, currentMediaRecipeId])

  const selectedTfRows = compatibleTfConditions.filter((row) => selectedExistingTfKeys.includes(tfRuleKey(row)))
  const effectiveTfRows: Array<TfConditionRecord | DraftTfConditionRow> = tfConditionMode === 'existing'
    ? selectedTfRows
    : compactRows(draftTfRows, (row) => (
      Boolean(row.tf.trim() || row.active_tf.trim() || row.active_nutrients.trim() || row.inactive_nutrients.trim())
    ))

  const compatibleTimelines = useMemo(() => {
    if (!currentMediaRecipeId) return allTimelines
    return sortProtocolsForMedia(allTimelines, currentMediaRecipeId).all
  }, [allTimelines, currentMediaRecipeId])
  const compatibleTimelineGroups = useMemo(() => {
    if (!currentMediaRecipeId) return { starts: allTimelines, involves: [] as TimelineRecord[] }
    return sortProtocolsForMedia(allTimelines, currentMediaRecipeId)
  }, [allTimelines, currentMediaRecipeId])

  const selectedExistingTimeline = compatibleTimelines.find((timeline) => timeline.timeline === selectedTimelineId) || null
  const recommendedTimelineStart = `0 ${currentMediaRecipeId || 'minimal'}`
  const effectiveTimelineEvents = timelineMode === 'existing'
    ? selectedExistingTimeline?.events || ''
    : draftTimelineEvents || recommendedTimelineStart
  const effectiveTimelineName = timelineMode === 'existing'
    ? selectedExistingTimeline?.timeline || ''
    : draftTimelineName

  useEffect(() => {
    if (!defaultExistingMediaStockName) return
    setSelectedMediaStockName((current) => current || defaultExistingMediaStockName)
  }, [defaultExistingMediaStockName])

  useEffect(() => {
    if (mediaRecipeMode === 'create') return
    if (!compatibleMediaRecipes.length) {
      setSelectedMediaRecipeId('')
      return
    }
    if (!compatibleMediaRecipes.some((recipe) => recipe.media_id === selectedMediaRecipeId)) {
      setSelectedMediaRecipeId(compatibleMediaRecipes[0].media_id)
    }
  }, [compatibleMediaRecipes, mediaRecipeMode, selectedMediaRecipeId])

  useEffect(() => {
    if (conditionMode === 'create') {
      setDraftCondition((current) => {
        const nutrients = currentMediaRecipeId || current.nutrients
        if (current.nutrients === nutrients) return current
        return {
          ...current,
          nutrients,
        }
      })
      return
    }
    if (!compatibleConditions.length) {
      setSelectedConditionName('')
      return
    }
    if (!compatibleConditions.some((condition) => condition.condition === selectedConditionName)) {
      setSelectedConditionName(compatibleConditions[0].condition)
    }
  }, [compatibleConditions, conditionMode, currentMediaRecipeId, selectedConditionName])

  useEffect(() => {
    if (timelineMode === 'create') return
    if (!compatibleTimelines.length) {
      setSelectedTimelineId('')
      return
    }
    if (!compatibleTimelines.some((timeline) => timeline.timeline === selectedTimelineId)) {
      setSelectedTimelineId(compatibleTimelines[0].timeline)
    }
  }, [compatibleTimelines, selectedTimelineId, timelineMode])

  useEffect(() => {
    if (tfConditionMode === 'create') return
    const compatibleKeys = new Set(compatibleTfConditions.map((row) => tfRuleKey(row)))
    setSelectedExistingTfKeys((current) => {
      const next = current.filter((key) => compatibleKeys.has(key))
      return next.length === current.length ? current : next
    })
  }, [compatibleTfConditions, tfConditionMode])

  const filteredEnvironmentMolecules = useMemo(() => {
    const query = environmentSearch.trim().toLowerCase()
    if (!query) return environmentMolecules.slice(0, 30)
    return environmentMolecules
      .filter((row) => `${row.molecule_id} ${row.exchange_molecule_location} ${row.formula_weight}`.toLowerCase().includes(query))
      .slice(0, 30)
  }, [environmentMolecules, environmentSearch])

  const conditionActiveTfSet = useMemo(() => {
    try {
      const list = JSON.parse(effectiveCondition?.active_tfs || '[]')
      return new Set<string>(Array.isArray(list) ? list : [])
    } catch { return new Set<string>() }
  }, [effectiveCondition?.active_tfs])

  const conditionInactiveTfSet = useMemo(() => {
    try {
      const list = JSON.parse(effectiveCondition?.inactive_tfs || '[]')
      return new Set<string>(Array.isArray(list) ? list : [])
    } catch { return new Set<string>() }
  }, [effectiveCondition?.inactive_tfs])

  const availableMediaIds = useMemo(() => {
    const ids = builderMediaRecipes.map((recipe) => recipe.media_id)
    return Array.from(new Set(ids)).sort()
  }, [builderMediaRecipes])

  const moleculeIdOptions = useMemo(() => (
    Array.from(new Set(environmentMolecules.map((row) => row.molecule_id).filter(Boolean))).sort()
  ), [environmentMolecules])

  const ingredientIds = useMemo(() => parseStringArray(draftMediaRecipe.ingredients), [draftMediaRecipe.ingredients])

  const ingredientEditState = useMemo(() => {
    const weight = parseRecipeEditArray(draftMediaRecipe.ingredients_weight)
    const counts = parseRecipeEditArray(draftMediaRecipe.ingredients_counts)
    const volume = parseRecipeEditArray(draftMediaRecipe.ingredients_volume)
    const formulaWeights = new Map(environmentMolecules.map((row) => [row.molecule_id, row.formula_weight]))
    const issues: string[] = []

    if (weight.error) issues.push(`Weight edits: ${weight.error}`)
    if (counts.error) issues.push(`Count edits: ${counts.error}`)
    if (volume.error) issues.push(`Volume edits: ${volume.error}`)

    if (ingredientIds.length === 0) {
      if (weight.values.length || counts.values.length || volume.values.length) {
        issues.push('Ingredient edit arrays should be [] when no ingredients are listed.')
      }
    } else {
      if (weight.values.length === 0 && counts.values.length === 0) {
        issues.push('Each listed ingredient needs either a weight edit or a count edit. Otherwise recipe generation cannot determine how much to add or remove.')
      }
      if (weight.values.length > 0 && weight.values.length !== ingredientIds.length) {
        issues.push(`Weight edits has ${weight.values.length} value(s), but Ingredients has ${ingredientIds.length}. These arrays must align by position.`)
      }
      if (counts.values.length > 0 && counts.values.length !== ingredientIds.length) {
        issues.push(`Count edits has ${counts.values.length} value(s), but Ingredients has ${ingredientIds.length}. These arrays must align by position.`)
      }
      if (volume.values.length > 0 && volume.values.length !== ingredientIds.length) {
        issues.push(`Volume edits has ${volume.values.length} value(s), but Ingredients has ${ingredientIds.length}. Use [] or one volume per ingredient.`)
      }
      if (weight.values.length > 0 && counts.values.length > 0) {
        issues.push('Both weight and count edits are present. Runtime recipe generation uses weight first for each ingredient and ignores the corresponding count value.')
      }

      const finiteWeightWithoutFormula = ingredientIds.filter((ingredientId, index) => {
        const value = weight.values[index]
        if (!value || value === 'Infinity' || value === '-Infinity') return false
        const formulaWeight = formulaWeights.get(ingredientId)
        return !formulaWeight || formulaWeight === 'None'
      })
      if (finiteWeightWithoutFormula.length > 0) {
        issues.push(`Finite gram additions require formula-weight metadata. Missing or unknown for: ${finiteWeightWithoutFormula.join(', ')}.`)
      }
    }

    return { weight, counts, volume, issues }
  }, [draftMediaRecipe.ingredients_counts, draftMediaRecipe.ingredients_volume, draftMediaRecipe.ingredients_weight, environmentMolecules, ingredientIds])

  const stockOptionsByRole = useMemo(() => {
    const seen = new Set<string>()
    const all = stockMediaOptions.map((name) => {
      const stock = mediaStocks.find((item) => item.name === name)
      const status = stock ? mediaStockStatus(stock) : { role: 'draft stock', detail: 'current draft', className: 'bg-slate-100 text-slate-600' }
      seen.add(name)
      return { name, status }
    })
    if (currentMediaStockName && !seen.has(currentMediaStockName)) {
      all.push({
        name: currentMediaStockName,
        status: { role: 'draft stock', detail: 'current draft', className: 'bg-slate-100 text-slate-600' },
      })
    }
    return {
      supplement: all.filter((item) => item.status.role === 'supplement stock'),
      base: all.filter((item) => item.status.role === 'base stock'),
      other: all.filter((item) => item.status.role !== 'supplement stock' && item.status.role !== 'base stock'),
    }
  }, [currentMediaStockName, mediaStocks, recipeCountsByAddedStock, recipeCountsByBaseStock, stockMediaOptions])

  const tfGeneSuggestions = useMemo(() => (
    Array.from(new Set(allTfConditions.map((row) => row.tf).filter(Boolean))).sort()
  ), [allTfConditions])

  const tfComplexSuggestions = useMemo(() => {
    const ids = new Set<string>()
    allTfConditions.forEach((row) => {
      if (row.active_tf) ids.add(row.active_tf)
    })
    return Array.from(ids).sort()
  }, [allTfConditions])

  const stateIdSuggestions = useMemo(() => {
    const ids = new Set<string>()
    allConditions.forEach((condition) => {
      jsonObjectKeys(condition.genotype_perturbations).forEach((key) => ids.add(key))
    })
    allTfConditions.forEach((row) => {
      jsonObjectKeys(row.active_genotype_perturbations).forEach((key) => ids.add(key))
      jsonObjectKeys(row.inactive_genotype_perturbations).forEach((key) => ids.add(key))
    })
    return Array.from(ids).sort()
  }, [allConditions, allTfConditions])

  function tfConditionStatus(row: TfConditionRecord) {
    const isActiveInCurrentRecipe = row.active_nutrients === currentMediaRecipeId
    const isInactiveInCurrentRecipe = row.inactive_nutrients === currentMediaRecipeId
    const conditionListsActive = conditionActiveTfSet.has(row.active_tf)
    const conditionListsInactive = conditionInactiveTfSet.has(row.active_tf)

    if (isActiveInCurrentRecipe && conditionListsActive) {
      return { label: 'condition-listed active', className: 'bg-emerald-50 text-emerald-700' }
    }
    if (isInactiveInCurrentRecipe && conditionListsInactive) {
      return { label: 'condition-listed inactive', className: 'bg-rose-50 text-rose-700' }
    }
    if (conditionListsActive || conditionListsInactive) {
      return { label: 'condition lists different state', className: 'bg-amber-50 text-amber-700' }
    }
    return { label: 'rule available; condition list silent', className: 'bg-slate-100 text-slate-600' }
  }

  const catalogStats = [
    { label: 'Medium stocks', value: mediaStocks.length, description: 'Files under condition/media/*.tsv' },
    { label: 'Environment molecules', value: environmentMolecules.length, description: 'Rows in environment_molecules.tsv' },
    { label: 'Media recipes', value: allMediaRecipes.length, description: 'Rows in media_recipes.tsv' },
    { label: 'Growth conditions', value: allConditions.length, description: 'Rows in condition_defs.tsv' },
    { label: 'TF state rules', value: allTfConditions.length, description: 'Rows in tf_condition.tsv' },
    { label: 'Media protocols', value: allTimelines.length, description: 'Rows in timelines_def.tsv' },
  ]

  const compatibilityWarnings = useMemo(() => {
    const warnings: string[] = []
    if (!currentMediaRecipeId) {
      const stock = mediaStocks.find((row) => row.name === currentMediaStockName)
      const addedCount = stock ? recipeCountsByAddedStock.get(stock.name) || 0 : 0
      if (stock && addedCount > 0) {
        warnings.push('The selected medium stock is used as a supplement. Choose a base stock such as MIX0-57, or create a media recipe that uses this stock.')
      } else if (stock) {
        warnings.push('The selected medium stock has no media recipe yet. Create a recipe before adding growth conditions, TF state rules, or media protocols.')
      } else {
        warnings.push('Choose or create a compatible media recipe before growth conditions, TF state rules, or media protocols.')
      }
    }
    if (currentMediaRecipeId && compatibleConditions.length === 0) {
      warnings.push('This media recipe exists, but no growth condition currently names it. It can still be used as a recipe or protocol target.')
    }
    if (conditionMode === 'create' && currentMediaRecipeId && effectiveCondition?.nutrients !== currentMediaRecipeId) {
      warnings.push('The draft growth condition nutrients should match the current media recipe to stay compatible.')
    }
    if (tfConditionMode === 'create' && currentMediaRecipeId) {
      const invalidTfDraft = effectiveTfRows.some((row) => (
        row.active_nutrients !== currentMediaRecipeId && row.inactive_nutrients !== currentMediaRecipeId
      ))
      if (invalidTfDraft) {
        warnings.push('Each draft TF state rule should reference the current media recipe in either active or inactive nutrients.')
      }
    }
    if (timelineMode === 'create' && currentMediaRecipeId && firstTimelineMedia(effectiveTimelineEvents) !== currentMediaRecipeId) {
      warnings.push('The media protocol should start from the current media recipe.')
    }
    return warnings
  }, [
    compatibleConditions.length,
    conditionMode,
    currentMediaStockName,
    currentMediaRecipeId,
    effectiveCondition,
    effectiveTfRows,
    effectiveTimelineEvents,
    mediaStocks,
    recipeCountsByAddedStock,
    tfConditionMode,
    timelineMode,
  ])

  const sectionSnapshots = useMemo<Record<SaveSectionKey, string>>(() => ({
    media: stringifySnapshot({
      mode: mediaMode,
      selected: selectedMediaStockName,
      draft_name: draftMediaStockName,
      rows: draftMediaRows,
      environment_rows: draftEnvironmentRows,
    }),
    mediaRecipe: stringifySnapshot({
      mode: mediaRecipeMode,
      selected: selectedMediaRecipeId,
      draft: effectiveMediaRecipe,
    }),
    condition: stringifySnapshot({
      mode: conditionMode,
      selected: selectedConditionName,
      draft: effectiveCondition,
    }),
    tfCondition: stringifySnapshot({
      mode: tfConditionMode,
      selected: selectedExistingTfKeys,
      draft: effectiveTfRows,
    }),
    timeline: stringifySnapshot({
      mode: timelineMode,
      selected: selectedTimelineId,
      name: effectiveTimelineName,
      events: effectiveTimelineEvents,
      duration: timelineDurationSec,
    }),
  }), [
    conditionMode,
    draftEnvironmentRows,
    draftMediaRows,
    draftMediaStockName,
    effectiveCondition,
    effectiveMediaRecipe,
    effectiveTfRows,
    effectiveTimelineEvents,
    effectiveTimelineName,
    mediaMode,
    mediaRecipeMode,
    selectedConditionName,
    selectedExistingTfKeys,
    selectedMediaRecipeId,
    selectedMediaStockName,
    selectedTimelineId,
    tfConditionMode,
    timelineDurationSec,
    timelineMode,
  ])

  function hydrateDraftState(drafts: Partial<Record<SaveSectionKey, BuilderDraft>>) {
    const mediaDraft = drafts.media?.payload
    if (mediaDraft) {
      const mode = mediaDraft.mode === 'existing' ? 'existing' : 'create'
      setMediaMode(mode)
      setSelectedMediaStockName(String(mediaDraft.selected || ''))
      setDraftMediaStockName(String(mediaDraft.draft_name || draftMediaStockName))
      if (Array.isArray(mediaDraft.rows)) {
        setDraftMediaRows(mediaDraft.rows.map((row) => {
          const nextRow = row as Partial<DraftMediaRow>
          return {
            id: String(nextRow.id || nextId('media-row')),
            molecule_id: String(nextRow.molecule_id || ''),
            concentration: String(nextRow.concentration || ''),
          }
        }))
      }
      if (Array.isArray(mediaDraft.environment_rows)) {
        setDraftEnvironmentRows(mediaDraft.environment_rows.map((row) => {
          const nextRow = row as Partial<DraftEnvironmentRow>
          return {
            id: String(nextRow.id || nextId('env-row')),
            molecule_id: String(nextRow.molecule_id || ''),
            exchange_molecule_location: String(nextRow.exchange_molecule_location || '[p]'),
            formula_weight: String(nextRow.formula_weight || 'None'),
          }
        }))
      }
    }

    const mediaRecipeDraft = drafts.mediaRecipe?.payload
    if (mediaRecipeDraft) {
      const mode = mediaRecipeDraft.mode === 'existing' ? 'existing' : 'create'
      setMediaRecipeMode(mode)
      setSelectedMediaRecipeId(String(mediaRecipeDraft.selected || ''))
      if (mediaRecipeDraft.draft && typeof mediaRecipeDraft.draft === 'object') {
        const nextDraft = mediaRecipeDraft.draft as Partial<MediaRecipeRecord>
        setDraftMediaRecipe((current) => ({
          ...current,
          media_id: String(nextDraft.media_id || current.media_id),
          base_media: String(nextDraft.base_media || current.base_media),
          base_media_volume: String(nextDraft.base_media_volume || current.base_media_volume),
          added_media: String(nextDraft.added_media || ''),
          added_media_volume: String(nextDraft.added_media_volume || current.added_media_volume),
          ingredients: String(nextDraft.ingredients || current.ingredients),
          ingredients_weight: String(nextDraft.ingredients_weight || current.ingredients_weight),
          ingredients_counts: String(nextDraft.ingredients_counts || current.ingredients_counts),
          ingredients_volume: String(nextDraft.ingredients_volume || current.ingredients_volume),
        }))
      }
    }

    const conditionDraft = drafts.condition?.payload
    if (conditionDraft) {
      const mode = conditionDraft.mode === 'existing' ? 'existing' : 'create'
      if (mode === 'existing') setConditionMode('existing')
      setSelectedConditionName(String(conditionDraft.selected || ''))
      if (conditionDraft.draft && typeof conditionDraft.draft === 'object') {
        const nextDraft = conditionDraft.draft as Partial<ConditionRecord>
        setDraftCondition((current) => ({
          ...current,
          condition: String(nextDraft.condition || current.condition),
          nutrients: String(nextDraft.nutrients || current.nutrients),
          genotype_perturbations: String(nextDraft.genotype_perturbations || current.genotype_perturbations),
          doubling_time: String(nextDraft.doubling_time || current.doubling_time),
          active_tfs: String(nextDraft.active_tfs || current.active_tfs),
          inactive_tfs: String(nextDraft.inactive_tfs || current.inactive_tfs),
        }))
      }
    }

    const tfDraft = drafts.tfCondition?.payload
    if (tfDraft) {
      const mode = tfDraft.mode === 'existing' ? 'existing' : 'create'
      setTfConditionMode(mode)
      if (Array.isArray(tfDraft.selected)) {
        setSelectedExistingTfKeys(tfDraft.selected.map((item) => String(item)))
      }
      if (Array.isArray(tfDraft.draft)) {
        setDraftTfRows(tfDraft.draft.map((row) => {
          const nextRow = row as Partial<DraftTfConditionRow>
          return {
            id: String(nextRow.id || nextId('tf-row')),
            tf: String(nextRow.tf || ''),
            active_tf: String(nextRow.active_tf || ''),
            active_nutrients: String(nextRow.active_nutrients || 'minimal'),
            active_genotype_perturbations: String(nextRow.active_genotype_perturbations || '{}'),
            inactive_nutrients: String(nextRow.inactive_nutrients || 'minimal'),
            inactive_genotype_perturbations: String(nextRow.inactive_genotype_perturbations || '{}'),
            tf_type: String(nextRow.tf_type || '1CS'),
          }
        }))
      }
    }

    const timelineDraft = drafts.timeline?.payload
    if (timelineDraft) {
      const mode = timelineDraft.mode === 'existing' ? 'existing' : 'create'
      if (mode === 'existing') setTimelineMode('existing')
      setSelectedTimelineId(String(timelineDraft.selected || ''))
      setDraftTimelineName(String(timelineDraft.name || draftTimelineName))
      setDraftTimelineEvents(String(timelineDraft.events || ''))
      if (timelineDraft.duration != null) {
        setTimelineDurationSec(Number(timelineDraft.duration) || 10800)
      }
    }
  }

  function getSectionDraftName(section: SaveSectionKey, existingDraft?: BuilderDraft | null) {
    const baseName = {
      media: draftMediaStockName.trim() || selectedMediaStockName || 'growth-media-draft',
      mediaRecipe: draftMediaRecipe.media_id.trim() || selectedMediaRecipeId || 'media-recipe-draft',
      condition: draftCondition.condition.trim() || selectedConditionName || 'condition-draft',
      tfCondition: `${currentMediaRecipeId || 'current'}-tf-rules`,
      timeline: draftTimelineName.trim() || selectedTimelineId || 'timeline-draft',
    }[section]

    if (existingDraft?.status === 'published') {
      return `${baseName}-draft`
    }
    return baseName
  }

  function canPublishSection(section: SaveSectionKey) {
    return {
      media: mediaMode === 'create',
      mediaRecipe: mediaRecipeMode === 'create',
      condition: conditionMode === 'create',
      tfCondition: tfConditionMode === 'create',
      timeline: timelineMode === 'create',
    }[section]
  }

  async function persistSectionDraft(section: SaveSectionKey, options?: { quiet?: boolean }) {
    const existingDraft = builderDrafts[section] || null
    const payload = JSON.parse(sectionSnapshots[section]) as Record<string, unknown>
    const name = getSectionDraftName(section, existingDraft)
    const nextDraft = existingDraft && existingDraft.status !== 'published'
      ? await updateBuilderDraft(section, existingDraft.id, name, payload)
      : await createBuilderDraft(section, name, payload)

    setBuilderDrafts((current) => ({
      ...current,
      [section]: nextDraft,
    }))
    setSavedSnapshots((current) => ({
      ...current,
      [section]: sectionSnapshots[section],
    }))
    if (!options?.quiet) {
      setActionMessage({ type: 'success', text: `Saved ${SECTION_LABELS[section]} draft to backend storage.` })
    }
    return nextDraft
  }

  async function saveSection(section: SaveSectionKey) {
    setSavingSection(section)
    setActionMessage(null)
    try {
      await persistSectionDraft(section)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to save ${SECTION_LABELS[section]} draft.`
      setActionMessage({ type: 'error', text: message })
    } finally {
      setSavingSection(null)
    }
  }

  async function requestPublishSection(section: SaveSectionKey) {
    setPublishingSection(section)
    setPreviewLoading(true)
    setPreviewError('')
    setPublishPreview(null)
    setPendingPublishDraft(null)
    setActionMessage(null)
    try {
      if (section === 'mediaRecipe' && ingredientEditState.issues.length > 0) {
        throw new Error('Fix the ingredient edit warnings before publishing this media recipe.')
      }
      const draft = !builderDrafts[section] || isDirty(section)
        ? await persistSectionDraft(section, { quiet: true })
        : builderDrafts[section]
      if (!draft) {
        throw new Error(`No ${SECTION_LABELS[section]} draft is available to publish.`)
      }
      const preview = await previewBuilderDraft(section, draft.id)
      setPendingPublishDraft(draft)
      setPublishPreview(preview)
      setPreviewSection(section)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to preview ${SECTION_LABELS[section]} publish.`
      setPreviewSection(section)
      setPreviewError(message)
      setActionMessage({ type: 'error', text: message })
    } finally {
      setPublishingSection(null)
      setPreviewLoading(false)
    }
  }

  async function confirmPublishSection() {
    if (!previewSection || !pendingPublishDraft) return
    const section = previewSection
    setPublishingSection(section)
    setPreviewError('')
    setActionMessage(null)
    try {
      const publishedDraft = await publishBuilderDraft(section, pendingPublishDraft.id)
      const nextCatalog = await getConditionCatalog()
      setCatalog(nextCatalog)
      setBuilderDrafts((current) => ({
        ...current,
        [section]: publishedDraft,
      }))
      setActionMessage({
        type: 'success',
        text: `Published ${SECTION_LABELS[section]} as ${publishedDraft.published_name || publishedDraft.name}.`,
      })
      setPreviewSection(null)
      setPublishPreview(null)
      setPendingPublishDraft(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to publish ${SECTION_LABELS[section]}.`
      setPreviewError(message)
      setActionMessage({ type: 'error', text: message })
    } finally {
      setPublishingSection(null)
    }
  }

  function closePublishPreview() {
    if (publishingSection) return
    setPreviewSection(null)
    setPublishPreview(null)
    setPreviewError('')
    setPendingPublishDraft(null)
  }

  function isSaved(section: SaveSectionKey) {
    return savedSnapshots[section] === sectionSnapshots[section]
  }

  function isDirty(section: SaveSectionKey) {
    return Boolean(savedSnapshots[section]) && savedSnapshots[section] !== sectionSnapshots[section]
  }

  function toggleSection(section: SaveSectionKey) {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }))
  }

  function addMediaRow() {
    setDraftMediaRows((current) => [...current, { id: nextId('media-row'), molecule_id: '', concentration: '' }])
  }

  function updateMediaRow(id: string, field: keyof DraftMediaRow, value: string) {
    setDraftMediaRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  function removeMediaRow(id: string) {
    setDraftMediaRows((current) => current.filter((row) => row.id !== id))
  }

  function addIngredientToRecipe(ingredientId = selectedIngredientId) {
    if (!ingredientId) return
    setDraftMediaRecipe((current) => {
      const nextIngredients = addToJsonArray(current.ingredients, ingredientId)
      if (nextIngredients === current.ingredients) return current
      const weight = parseRecipeEditArray(current.ingredients_weight)
      const counts = parseRecipeEditArray(current.ingredients_counts)
      const shouldExtendWeight = !weight.error && weight.values.length > 0 && counts.values.length === 0
      return {
        ...current,
        ingredients: nextIngredients,
        ingredients_weight: shouldExtendWeight ? addToRecipeEditArray(current.ingredients_weight, 'Infinity') : current.ingredients_weight,
        ingredients_counts: shouldExtendWeight ? current.ingredients_counts : addToRecipeEditArray(current.ingredients_counts, 'Infinity'),
      }
    })
    setSelectedIngredientId('')
  }

  function removeIngredientFromRecipe(index: number) {
    setDraftMediaRecipe((current) => ({
      ...current,
      ingredients: removeJsonArrayIndex(current.ingredients, index),
      ingredients_weight: removeJsonArrayIndex(current.ingredients_weight, index),
      ingredients_counts: removeJsonArrayIndex(current.ingredients_counts, index),
      ingredients_volume: removeJsonArrayIndex(current.ingredients_volume, index),
    }))
  }

  function addConditionTf(field: 'active_tfs' | 'inactive_tfs', complexId: string) {
    if (!complexId) return
    setDraftCondition((current) => ({
      ...current,
      [field]: addToJsonArray(current[field], complexId),
    }))
    if (field === 'active_tfs') {
      setSelectedConditionActiveTfId('')
    } else {
      setSelectedConditionInactiveTfId('')
    }
  }

  function removeConditionTf(field: 'active_tfs' | 'inactive_tfs', index: number) {
    setDraftCondition((current) => ({
      ...current,
      [field]: removeJsonArrayIndex(current[field], index),
    }))
  }

  function addConditionStatePerturbation(stateId = selectedConditionStateId) {
    if (!stateId) return
    setDraftCondition((current) => ({
      ...current,
      genotype_perturbations: upsertJsonObjectValue(current.genotype_perturbations, stateId, 0),
    }))
    setSelectedConditionStateId('')
  }

  function addEnvironmentRowFromExisting(row: EnvironmentMolecule) {
    setDraftEnvironmentRows((current) => {
      if (current.some((item) => item.molecule_id === row.molecule_id)) return current
      return [
        ...current,
        {
          id: nextId('env-row'),
          molecule_id: row.molecule_id,
          exchange_molecule_location: row.exchange_molecule_location,
          formula_weight: row.formula_weight,
        },
      ]
    })
  }

  function addEnvironmentRow() {
    setDraftEnvironmentRows((current) => [
      ...current,
      { id: nextId('env-row'), molecule_id: '', exchange_molecule_location: '[p]', formula_weight: 'None' },
    ])
  }

  function updateEnvironmentRow(id: string, field: keyof DraftEnvironmentRow, value: string) {
    setDraftEnvironmentRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  function removeEnvironmentRow(id: string) {
    setDraftEnvironmentRows((current) => current.filter((row) => row.id !== id))
  }

  function addTfDraftRow() {
    setDraftTfRows((current) => [
      ...current,
      {
        id: nextId('tf-row'),
        tf: '',
        active_tf: '',
        active_nutrients: currentMediaRecipeId || 'minimal',
        active_genotype_perturbations: '{}',
        inactive_nutrients: 'minimal',
        inactive_genotype_perturbations: '{}',
        tf_type: '1CS',
      },
    ])
  }

  function updateTfDraftRow(id: string, field: keyof DraftTfConditionRow, value: string) {
    setDraftTfRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  function removeTfDraftRow(id: string) {
    setDraftTfRows((current) => current.filter((row) => row.id !== id))
  }

  function forkMediaStock() {
    const stock = mediaStocks.find((s) => s.name === selectedMediaStockName)
    if (!stock) return
    setDraftMediaRows(stock.rows.map((row) => ({ id: nextId('media-row'), molecule_id: row.molecule_id, concentration: row.concentration })))
    setDraftMediaStockName(selectedMediaStockName + '_copy')
    setDraftMediaRecipe((current) => ({ ...current, base_media: selectedMediaStockName + '_copy' }))
    setMediaMode('create')
  }

  function forkMediaRecipe() {
    if (!selectedExistingMediaRecipe) return
    setDraftMediaRecipe({
      media_id: selectedExistingMediaRecipe.media_id + '_copy',
      base_media: selectedExistingMediaRecipe.base_media,
      base_media_volume: selectedExistingMediaRecipe.base_media_volume || '1.0',
      added_media: selectedExistingMediaRecipe.added_media || '',
      added_media_volume: selectedExistingMediaRecipe.added_media_volume || '0',
      ingredients: selectedExistingMediaRecipe.ingredients || '[]',
      ingredients_weight: selectedExistingMediaRecipe.ingredients_weight || '[]',
      ingredients_counts: selectedExistingMediaRecipe.ingredients_counts || '[]',
      ingredients_volume: selectedExistingMediaRecipe.ingredients_volume || '[]',
    })
    setMediaRecipeMode('create')
  }

  function forkCondition() {
    if (!selectedExistingCondition) return
    setDraftCondition({
      condition: selectedExistingCondition.condition + '_copy',
      nutrients: selectedExistingCondition.nutrients,
      genotype_perturbations: selectedExistingCondition.genotype_perturbations,
      doubling_time: selectedExistingCondition.doubling_time,
      active_tfs: selectedExistingCondition.active_tfs,
      inactive_tfs: selectedExistingCondition.inactive_tfs,
    })
    setConditionMode('create')
  }

  const dependencyLevelGuide = 'Answer five questions in order. Each answer becomes the input for the next step: stock, recipe, condition, TF state rules, then protocol.'

  const currentMediumReference = currentMediaStockName || draftMediaStockName || effectiveMediaRecipe?.base_media || 'MIX0-57'
  const currentFormulationReference = effectiveMediaRecipe?.media_id || currentMediaRecipeId || 'minimal'
  const currentConditionReference = effectiveCondition?.condition || 'my_condition'
  const currentScheduleStartReference = firstTimelineMedia(effectiveTimelineEvents) || currentFormulationReference || 'minimal'
  const currentEnvironmentReference = draftEnvironmentRows.find((row) => row.molecule_id.trim())?.molecule_id || 'MY_CARBON_SRC'
  const currentTfReference = effectiveTfRows[0]?.active_nutrients || effectiveTfRows[0]?.inactive_nutrients || currentFormulationReference
  const hasDraftEnvironmentMolecules = draftEnvironmentRows.some((row) => row.molecule_id.trim())
  const dependencyMainSteps = DEPENDENCY_STEPS.filter((step) => !step.branch)
  const dependencyBranchStep = DEPENDENCY_STEPS.find((step) => step.branch) || null
  const dependencyMappings: Record<DependencyStepId, string[]> = {
    media: [`base medium = ${currentMediumReference}`],
    environment: [`new ID = ${currentEnvironmentReference}`],
    mediaRecipe: [`recipe = ${currentFormulationReference}`, `protocol start = ${currentFormulationReference}`],
    condition: [`condition = ${currentConditionReference}`, `nutrients = ${effectiveCondition?.nutrients || currentFormulationReference}`],
    tfCondition: [`TF nutrients = ${currentTfReference}`],
    timeline: [`start = 0 ${currentScheduleStartReference}`],
  }
  const dependencyAnswers: Record<DependencyStepId, string> = {
    media: currentMediumReference,
    environment: currentEnvironmentReference,
    mediaRecipe: currentFormulationReference,
    condition: currentConditionReference,
    tfCondition: effectiveTfRows.length > 0 ? `${effectiveTfRows.length} rule${effectiveTfRows.length === 1 ? '' : 's'}` : 'no rule selected',
    timeline: currentScheduleStartReference,
  }
  const sectionSummaries = getSectionSummaries({
    mediaMode,
    currentMediaStockName,
    draftMediaStockName,
    draftMediaRows,
    effectiveMediaRecipe,
    effectiveCondition,
    effectiveTfRows,
    effectiveTimelineName,
    effectiveTimelineEvents,
    currentScheduleStartReference,
  })
  useRegisterAssistantContext({
    context: {
      assistant_surface: 'conditions_builder',
      route: `${location.pathname}${location.search}`,
      selected_builder_section: highlightedSection,
    },
    suggestedPrompt: 'Help me review this Conditions Builder draft. Check the five-step dependency chain, saved versus dirty sections, valid publish order, and whether the media recipe, growth condition, TF rules, and media protocol are internally consistent.',
  })

  useEffect(() => {
    if (!highlightedSection) return

    const timeout = window.setTimeout(() => setHighlightedSection(null), 1800)
    return () => window.clearTimeout(timeout)
  }, [highlightedSection])

  function dependencyBadge(stepId: DependencyStepId) {
    return getDependencyBadge({
      stepId,
      mediaMode,
      hasDraftEnvironmentMolecules,
      currentMediaRecipeId,
      currentConditionName: effectiveCondition?.condition || '',
      tfRuleCount: effectiveTfRows.length,
    })
  }

  function jumpToDependencyStep(stepId: DependencyStepId) {
    const target = DEPENDENCY_SECTION_TARGETS[stepId]
    if (!target) return

    setCollapsedSections((current) => ({
      ...current,
      [target]: false,
    }))
    setHighlightedSection(target)
    window.requestAnimationFrame(() => {
      document.getElementById(`builder-section-${target}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }

  function renderSectionActions(section: SaveSectionKey) {
    const draft = builderDrafts[section]
    return (
      <SectionSaveActions
        saved={isSaved(section)}
        dirty={isDirty(section)}
        saving={savingSection === section}
        onSave={() => { void saveSection(section) }}
        onPublish={canPublishSection(section) ? () => { void requestPublishSection(section) } : undefined}
        publishing={publishingSection === section}
        publishDisabled={!canPublishSection(section) || (draft?.status === 'published' && !isDirty(section))}
      />
    )
  }

  function renderMediaSection() {
    return (
      <SectionCard
        sectionId="media"
        highlighted={highlightedSection === 'media'}
        title="1. What raw medium stock am I starting from?"
        subtitle="Choose the molecule and concentration table that a recipe will point to."
        collapsible
        collapsed={collapsedSections.media}
        onToggleCollapse={() => toggleSection('media')}
        actions={renderSectionActions('media')}
      >
        <ExistingCreateToggle mode={mediaMode} onChange={setMediaMode} />

        {mediaMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.75fr,1.25fr]">
            <label className="block">
              <FieldLabel
                label="Stock medium"
                tooltip="Medium stock names come from files under condition/media. They are usually uppercase names such as MIX0-57 or MIX0-844."
              />
              <select
                value={selectedMediaStockName}
                onChange={(event) => setSelectedMediaStockName(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {mediaStocks.map((stock) => {
                  const status = mediaStockStatus(stock)
                  return (
                    <option key={stock.name} value={stock.name}>
                      {stock.name} - {status.role} · {status.detail}
                    </option>
                  )
                })}
              </select>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">Selected stock summary</p>
                  {selectedStockStatus && (
                    <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${selectedStockStatus.className}`}>
                      {selectedStockStatus.role}: {selectedStockStatus.detail}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={forkMediaStock}
                  disabled={!selectedMediaStockName}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Fork &amp; edit
                </button>
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                {(mediaStocks.find((stock) => stock.name === selectedMediaStockName)?.rows || []).slice(0, 8).map((row) => (
                  <div key={`${row.molecule_id}-${row.concentration}`} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-slate-900">{row.molecule_id}</span>
                    <span className="font-mono text-slate-500">{row.concentration}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
              <p className="font-medium text-cyan-950">Create a raw stock only when the reconstruction does not already contain the extracellular mixture you need.</p>
              <p className="mt-1 leading-6">Each row is one molecule available outside the cell. Use exact molecule IDs from the registry below; finite concentrations constrain availability, while <span className="font-mono">Infinity</span> means unconstrained supply.</p>
            </div>
            <label className="block">
              <FieldLabel
                label="New medium stock name"
                tooltip="Use the file stem only, without .tsv. Repo convention here is usually uppercase names such as MY_NEW_MIX."
              />
              <input
                type="text"
                value={draftMediaStockName}
                onChange={(event) => {
                  const value = event.target.value
                  setDraftMediaStockName(value)
                  setDraftMediaRecipe((current) => ({ ...current, base_media: value }))
                }}
                placeholder="MY_NEW_MIX"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">This creates a raw stock file under <span className="font-mono">condition/media</span>. It is not experiment-selectable until a media recipe uses it.</p>
            </label>

            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">Stock composition</p>
                <button
                  type="button"
                  onClick={addMediaRow}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
                >
                  Add row
                </button>
              </div>
              <div className="mt-3 hidden gap-3 md:grid" style={{ gridTemplateColumns: '1fr 180px auto' }}>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Molecule ID</p>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Concentration (mmol/L)</p>
                <span />
              </div>
              <datalist id="environment-molecule-options">
                {moleculeIdOptions.map((moleculeId) => (
                  <option key={moleculeId} value={moleculeId} />
                ))}
              </datalist>
              <div className="mt-1 space-y-3">
                {draftMediaRows.map((row) => (
                  <div key={row.id} className="grid gap-3 md:grid-cols-[minmax(0,1fr),180px,auto]">
                    <input
                      type="text"
                      list="environment-molecule-options"
                      value={row.molecule_id}
                      onChange={(event) => updateMediaRow(row.id, 'molecule_id', event.target.value)}
                      placeholder="MY_CARBON_SRC"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                    <div>
                      <input
                        type="text"
                        value={row.concentration}
                        onChange={(event) => updateMediaRow(row.id, 'concentration', event.target.value)}
                        placeholder="e.g. 10.0 or Infinity"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      />
                      <p className="mt-1 text-[11px] text-slate-400">Infinity = unconstrained supply</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMediaRow(row.id)}
                      className="self-start rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-900">Exchange molecule registry</summary>
              <p className="mt-2 text-sm text-slate-500">
                Use this only for molecule IDs missing from the reconstruction registry. Existing catalog molecules can be added directly to the stock.
              </p>
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(210px,0.75fr),minmax(0,1.25fr)]">
                <div className="min-w-0">
                  <SearchInput
                    value={environmentSearch}
                    onChange={setEnvironmentSearch}
                    placeholder="Search existing environment molecules..."
                  />
                  <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {filteredEnvironmentMolecules.map((row) => (
                      <button
                        key={row.molecule_id}
                        type="button"
                        onClick={() => addEnvironmentRowFromExisting(row)}
                        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-cyan-300 hover:bg-cyan-50"
                      >
                        <span className="font-mono text-slate-900">{row.molecule_id}</span>
                        <span className="text-slate-500">{row.exchange_molecule_location}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-slate-900">Draft registry rows</p>
                    <button
                      type="button"
                      onClick={addEnvironmentRow}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
                    >
                      Add row
                    </button>
                  </div>
                  <div className="mt-3 space-y-3">
                    <div className="hidden gap-3 xl:grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 96px 120px auto' }}>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Molecule ID</p>
                      <div className="flex items-center gap-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Location</p>
                        <HelpTip text="[p] = periplasm (outer membrane), [c] = cytoplasm. Most exchange metabolites use [p]." position="top-start" />
                      </div>
                      <div className="flex items-center gap-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Formula weight</p>
                        <HelpTip text="Molecular weight in g/mol. Use 'None' to let the simulator infer it from the molecule ID. Enter a numeric value only for novel IDs where inference would fail." position="top-start" />
                      </div>
                      <span />
                    </div>
                    {draftEnvironmentRows.map((row) => (
                      <div key={row.id} className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr),96px,120px,auto]">
                        <input
                          type="text"
                          list="environment-molecule-options"
                          value={row.molecule_id}
                          onChange={(event) => updateEnvironmentRow(row.id, 'molecule_id', event.target.value)}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                        />
                        <select
                          value={row.exchange_molecule_location}
                          onChange={(event) => updateEnvironmentRow(row.id, 'exchange_molecule_location', event.target.value)}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                        >
                          <option value="[p]">[p]</option>
                          <option value="[c]">[c]</option>
                        </select>
                        <input
                          type="text"
                          value={row.formula_weight}
                          onChange={(event) => updateEnvironmentRow(row.id, 'formula_weight', event.target.value)}
                          placeholder="None"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                        />
                        <button
                          type="button"
                          onClick={() => removeEnvironmentRow(row.id)}
                          className="self-start rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          </div>
        )}
      </SectionCard>
    )
  }

  function renderMediaRecipeSection() {
    return (
      <SectionCard
        sectionId="mediaRecipe"
        highlighted={highlightedSection === 'mediaRecipe'}
        title="2. How should this media recipe be assembled for experiments?"
        subtitle="Choose or create the operation that turns raw stocks and ingredient edits into a recipe ID."
        collapsible
        collapsed={collapsedSections.mediaRecipe}
        onToggleCollapse={() => toggleSection('mediaRecipe')}
        actions={renderSectionActions('mediaRecipe')}
      >
        <ExistingCreateToggle mode={mediaRecipeMode} onChange={setMediaRecipeMode} />

        {mediaRecipeMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Compatible recipes</span>
              <select
                value={selectedMediaRecipeId}
                onChange={(event) => setSelectedMediaRecipeId(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {compatibleMediaRecipes.map((recipe) => (
                  <option key={recipe.media_id} value={recipe.media_id}>
                    {recipe.media_id} - {mediaRecipeStatus(recipe).join(' · ')}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Existing recipes are filtered so their base medium matches the selected medium stock. Supplement-only stocks will not show recipes until they are used through a base recipe.
              </p>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium text-slate-900">Recipe summary</p>
                <button
                  type="button"
                  onClick={forkMediaRecipe}
                  disabled={!selectedExistingMediaRecipe}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Fork &amp; edit
                </button>
              </div>
              {selectedExistingMediaRecipe ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mediaRecipeStatus(selectedExistingMediaRecipe).map((status) => (
                      <span key={status} className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {status}
                      </span>
                    ))}
                  </div>
                  <dl className="mt-3 grid gap-2">
                    <div><dt className="text-xs uppercase tracking-wide text-slate-500">Base stock</dt><dd className="font-mono text-slate-900">{selectedExistingMediaRecipe.base_media}</dd></div>
                    <div><dt className="text-xs uppercase tracking-wide text-slate-500">Added stock</dt><dd className="font-mono text-slate-900">{selectedExistingMediaRecipe.added_media || 'None'}</dd></div>
                    <div><dt className="text-xs uppercase tracking-wide text-slate-500">Ingredients</dt><dd className="break-words font-mono text-slate-900">{selectedExistingMediaRecipe.ingredients}</dd></div>
                  </dl>
                </>
              ) : (
                <p className="mt-3">No compatible media recipe is currently available for the selected medium stock.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
              <p className="font-medium text-cyan-950">A media recipe is an assembly operation, not just a name.</p>
              <p className="mt-1 leading-6">Start from one base stock, optionally mix in a supplement stock, then add or remove specific ingredients. The recipe ID is what growth conditions, media protocols, and experiments reference.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <FieldLabel
                label="Recipe ID"
                tooltip="Use lowercase snake_case for named recipe IDs, for example minimal_acetate or my_new_media."
              />
              <input
                type="text"
                value={draftMediaRecipe.media_id}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, media_id: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">This is the stable ID users will later select in condition and protocol fields.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Base medium"
                tooltip="This should match a medium stock file name such as MIX0-57 or MY_NEW_MIX."
              />
              <select
                value={draftMediaRecipe.base_media}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, base_media: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {!!stockOptionsByRole.base.length && (
                  <optgroup label="Base stocks">
                    {stockOptionsByRole.base.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.detail}</option>
                    ))}
                  </optgroup>
                )}
                {!!stockOptionsByRole.supplement.length && (
                  <optgroup label="Supplement stocks">
                    {stockOptionsByRole.supplement.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.detail}</option>
                    ))}
                  </optgroup>
                )}
                {!!stockOptionsByRole.other.length && (
                  <optgroup label="Other or draft stocks">
                    {stockOptionsByRole.other.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.role}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <p className="mt-1 text-xs leading-5 text-slate-500">Use the stock that supplies the main extracellular composition.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Base medium volume (L)"
                tooltip="Relative mixing volume for the base stock. Use 1.0 when this recipe uses only the base stock."
              />
              <input
                type="text"
                value={draftMediaRecipe.base_media_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, base_media_volume: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">For a mixed recipe, this is the base stock fraction or volume used in the recipe.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Added medium"
                tooltip="Select an existing stock medium to mix with the base medium at the specified volume ratio, or choose None."
              />
              <select
                value={draftMediaRecipe.added_media}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, added_media: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                <option value="">None</option>
                {!!stockOptionsByRole.supplement.length && (
                  <optgroup label="Supplement stocks">
                    {stockOptionsByRole.supplement.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.detail}</option>
                    ))}
                  </optgroup>
                )}
                {!!stockOptionsByRole.base.length && (
                  <optgroup label="Base stocks, valid but uncommon as mix-ins">
                    {stockOptionsByRole.base.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.detail}</option>
                    ))}
                  </optgroup>
                )}
                {!!stockOptionsByRole.other.length && (
                  <optgroup label="Other or draft stocks">
                    {stockOptionsByRole.other.map(({ name, status }) => (
                      <option key={name} value={name}>{name} - {status.role}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <p className="mt-1 text-xs leading-5 text-slate-500">Use this for supplement stocks such as amino-acid mixes. Base stocks are model-valid mix-ins, but uncommon and should be used deliberately.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Added medium volume (L)"
                tooltip="Relative mixing volume for the added stock. Use 0 when no added stock is selected."
              />
              <input
                type="text"
                value={draftMediaRecipe.added_media_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, added_media_volume: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">For example, amino-acid medium uses base volume <span className="font-mono">0.8</span> and supplement volume <span className="font-mono">0.2</span>.</p>
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Ingredients"
                tooltip={'Write ingredients as a JSON-style list of molecule IDs, for example ["GLC"] or ["OXYGEN-MOLECULE"].'}
              />
              <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                <select
                  value={selectedIngredientId}
                  onChange={(event) => setSelectedIngredientId(event.target.value)}
                  className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                >
                  <option value="">Choose a catalog molecule...</option>
                  {moleculeIdOptions.map((moleculeId) => (
                    <option key={moleculeId} value={moleculeId}>{moleculeId}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => addIngredientToRecipe()}
                  disabled={!selectedIngredientId}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Add ingredient
                </button>
              </div>
              {ingredientIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {ingredientIds.map((ingredientId, index) => (
                    <button
                      key={`${ingredientId}-${index}`}
                      type="button"
                      onClick={() => removeIngredientFromRecipe(index)}
                      className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-xs font-medium text-cyan-800 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                      title="Remove ingredient from the encoded ingredient arrays"
                    >
                      {ingredientId} x
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={draftMediaRecipe.ingredients}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">Use exact molecule IDs. Leave <span className="font-mono">[]</span> when the base/added stocks already define the recipe.</p>
            </label>
            <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <p className="font-medium text-slate-900">Ingredient edits are position-matched arrays.</p>
              <p className="mt-1 leading-6">
                The first value in each edit array applies to the first ingredient, the second value to the second ingredient, and so on.
                Use either weight edits or count edits to define the amount. Runtime recipe generation uses weight first if both are present.
              </p>
              <div className="mt-2 grid gap-2 text-xs leading-5 md:grid-cols-3">
                <p><span className="font-mono">Infinity</span> means unconstrained availability.</p>
                <p><span className="font-mono">-Infinity</span> forces the ingredient concentration to zero.</p>
                <p>Volume edits change the final mixed volume and dilute the resulting medium.</p>
              </div>
              {ingredientEditState.issues.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                  <p className="font-medium">Check ingredient edits before publishing</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {ingredientEditState.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <label className="block">
              <FieldLabel
                label="Ingredient weight edits (g)"
                tooltip="Model-style bracketed list aligned with Ingredients. Use numbers, Infinity, or -Infinity."
              />
              <textarea
                value={draftMediaRecipe.ingredients_weight}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_weight: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Valid examples: <span className="font-mono">[]</span>, <span className="font-mono">[Infinity]</span>, <span className="font-mono">[-Infinity]</span>, or <span className="font-mono">[0.01]</span>.
                Finite gram values require formula-weight metadata.
              </p>
            </label>
            <label className="block">
              <FieldLabel
                label="Ingredient count edits (mmol)"
                tooltip="Model-style bracketed list aligned with Ingredients. Use this for mmol additions/removals when weight is not appropriate."
              />
              <textarea
                value={draftMediaRecipe.ingredients_counts}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_counts: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Valid examples: <span className="font-mono">[]</span>, <span className="font-mono">[Infinity]</span>, <span className="font-mono">[-Infinity]</span>, or <span className="font-mono">[0.2]</span>.
                Use this when adding a finite amount in mmol or when formula weight is unknown.
              </p>
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Ingredient volume edits (L)"
                tooltip="Model-style bracketed list aligned with Ingredients. Use [] for zero added volume, or one volume value per ingredient."
              />
              <textarea
                value={draftMediaRecipe.ingredients_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_volume: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Usually <span className="font-mono">[]</span>, which the model treats as zero added volume for each ingredient.
                Use values such as <span className="font-mono">[0.025]</span> only when the ingredient addition has a real liquid volume.
              </p>
            </label>
            </div>
          </div>
        )}
      </SectionCard>
    )
  }

  function renderConditionSection() {
    return (
      <SectionCard
        sectionId="condition"
        highlighted={highlightedSection === 'condition'}
        title="3. What biological growth condition should this recipe represent?"
        subtitle="Choose or create the condition name that appears in experiment condition dropdowns."
        collapsible
        collapsed={collapsedSections.condition}
        onToggleCollapse={() => toggleSection('condition')}
        actions={renderSectionActions('condition')}
      >
        <ExistingCreateToggle mode={conditionMode} onChange={setConditionMode} />

        {conditionMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Compatible growth conditions</span>
              <select
                value={selectedConditionName}
                onChange={(event) => setSelectedConditionName(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {compatibleConditions.map((condition) => (
                  <option key={condition.condition} value={condition.condition}>{condition.condition}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Existing growth conditions are filtered so their nutrients field matches the current media recipe.
              </p>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium text-slate-900">Growth condition summary</p>
                <button
                  type="button"
                  onClick={forkCondition}
                  disabled={!selectedExistingCondition}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Fork &amp; edit
                </button>
              </div>
              {selectedExistingCondition ? (
                <dl className="mt-3 grid gap-2">
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Nutrients</dt><dd className="font-mono text-slate-900">{selectedExistingCondition.nutrients}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Genotype perturbations</dt><dd className="break-words font-mono text-slate-900">{selectedExistingCondition.genotype_perturbations}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Active TFs</dt><dd className="break-words font-mono text-slate-900">{selectedExistingCondition.active_tfs}</dd></div>
                </dl>
              ) : (
                <p className="mt-3">No compatible growth condition is available for the current media recipe.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium text-amber-950">Create a growth condition only when you can justify the biological metadata.</p>
              <p className="mt-1 leading-6">The doubling time and TF lists are prior reconstruction metadata, not outputs calculated by this form. If they are unknown, reuse or fork the closest existing condition and edit only what is defensible.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <FieldLabel
                label="Growth condition name"
                tooltip="Use lowercase snake_case, for example acetate, with_aa, or my_condition."
              />
              <input
                type="text"
                value={draftCondition.condition}
                onChange={(event) => setDraftCondition((current) => ({ ...current, condition: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">This name appears in experiment condition dropdowns after publish.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Nutrients / recipe ID"
                tooltip="This should match the media recipe ID used by the growth condition, usually the recipe selected above."
              />
              <select
                value={draftCondition.nutrients}
                onChange={(event) => setDraftCondition((current) => ({ ...current, nutrients: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {availableMediaIds.map((mediaId) => (
                  <option key={mediaId} value={mediaId}>{mediaId}</option>
                ))}
              </select>
              <p className="mt-1 text-xs leading-5 text-slate-500">This should be the media recipe whose biological context you are defining.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Doubling time (min)"
                tooltip="Measured or literature-supported expected doubling time in minutes. This is catalog metadata, not inferred by the builder."
              />
              <input
                type="text"
                value={draftCondition.doubling_time}
                onChange={(event) => setDraftCondition((current) => ({ ...current, doubling_time: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">Use a measured or literature-supported value. For basal minimal glucose, the catalog uses <span className="font-mono">44.0</span> min.</p>
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Genotype perturbations"
                tooltip={'JSON-style object mapping model state IDs to forced values. Use {} for no genotype perturbation.'}
              />
              {stateIdSuggestions.length > 0 && (
                <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                  <select
                    value={selectedConditionStateId}
                    onChange={(event) => setSelectedConditionStateId(event.target.value)}
                    className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  >
                    <option value="">Choose a known state ID...</option>
                    {stateIdSuggestions.map((stateId) => (
                      <option key={stateId} value={stateId}>{stateId}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => addConditionStatePerturbation()}
                    disabled={!selectedConditionStateId}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                  >
                    Force to 0
                  </button>
                </div>
              )}
              <textarea
                value={draftCondition.genotype_perturbations}
                onChange={(event) => setDraftCondition((current) => ({ ...current, genotype_perturbations: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500"><span className="font-mono">{'{}'}</span> means no genotype perturbation. Example: <span className="font-mono">{'{"EG10325_RNA": 0}'}</span> forces that RNA state to zero.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Active TF complexes"
                tooltip={'JSON-style list of TF complex IDs that are active relative to basal, for example ["CPLX0-226"]. Use [] when none are specified.'}
              />
              <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                <select
                  value={selectedConditionActiveTfId}
                  onChange={(event) => setSelectedConditionActiveTfId(event.target.value)}
                  className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                >
                  <option value="">Choose TF complex...</option>
                  {tfComplexSuggestions.map((complexId) => (
                    <option key={complexId} value={complexId}>{complexId}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => addConditionTf('active_tfs', selectedConditionActiveTfId)}
                  disabled={!selectedConditionActiveTfId}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              {parseStringArray(draftCondition.active_tfs).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {parseStringArray(draftCondition.active_tfs).map((complexId, index) => (
                    <button
                      key={`${complexId}-${index}`}
                      type="button"
                      onClick={() => removeConditionTf('active_tfs', index)}
                      className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    >
                      {complexId} x
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={draftCondition.active_tfs}
                onChange={(event) => setDraftCondition((current) => ({ ...current, active_tfs: event.target.value }))}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">List only TF complexes that this condition turns on relative to basal. Use <span className="font-mono">[]</span> for none.</p>
            </label>
            <label className="block">
              <FieldLabel
                label="Inactive TF complexes"
                tooltip={'JSON-style list of TF complex IDs that are inactive relative to basal, for example ["CPLX0-7669"]. Use [] when none are specified.'}
              />
              <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                <select
                  value={selectedConditionInactiveTfId}
                  onChange={(event) => setSelectedConditionInactiveTfId(event.target.value)}
                  className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                >
                  <option value="">Choose TF complex...</option>
                  {tfComplexSuggestions.map((complexId) => (
                    <option key={complexId} value={complexId}>{complexId}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => addConditionTf('inactive_tfs', selectedConditionInactiveTfId)}
                  disabled={!selectedConditionInactiveTfId}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              {parseStringArray(draftCondition.inactive_tfs).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {parseStringArray(draftCondition.inactive_tfs).map((complexId, index) => (
                    <button
                      key={`${complexId}-${index}`}
                      type="button"
                      onClick={() => removeConditionTf('inactive_tfs', index)}
                      className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    >
                      {complexId} x
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={draftCondition.inactive_tfs}
                onChange={(event) => setDraftCondition((current) => ({ ...current, inactive_tfs: event.target.value }))}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
              <p className="mt-1 text-xs leading-5 text-slate-500">List only TF complexes that this condition turns off relative to basal. Use <span className="font-mono">[]</span> for none.</p>
            </label>
            </div>
          </div>
        )}
      </SectionCard>
    )
  }

  function renderTfConditionSection() {
    return (
      <SectionCard
        sectionId="tfCondition"
        highlighted={highlightedSection === 'tfCondition'}
        title="4. Which TF state rules belong to this recipe?"
        subtitle="Choose compatible reconstruction rules that declare when TF complexes are active or inactive."
        collapsible
        collapsed={collapsedSections.tfCondition}
        onToggleCollapse={() => toggleSection('tfCondition')}
        actions={renderSectionActions('tfCondition')}
      >
        <ExistingCreateToggle mode={tfConditionMode} onChange={setTfConditionMode} />

        {tfConditionMode === 'existing' ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-slate-500">
              Existing TF rules are filtered so either active nutrients or inactive nutrients matches the current media recipe.
            </p>
            <div className="space-y-2">
              {compatibleTfConditions.map((row) => {
                const key = tfRuleKey(row)
                const checked = selectedExistingTfKeys.includes(key)
                const status = tfConditionStatus(row)
                const scope = classifyTfRuleScope(row)

                return (
                  <label key={key} className="flex items-start gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm transition-colors hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        setSelectedExistingTfKeys((current) => (
                          event.target.checked ? [...current, key] : current.filter((item) => item !== key)
                        ))
                      }}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-900">{row.tf} <span className="font-mono text-slate-500">{row.active_tf}</span></p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.className}`}>{status.label}</span>
                        <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-700">{scope}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">{row.tf_type}</span>
                      </div>
                      <p className="mt-1 break-words font-mono text-xs text-slate-500">
                        active nutrients={row.active_nutrients} · inactive nutrients={row.inactive_nutrients}
                      </p>
                      {(hasJsonContent(row.active_genotype_perturbations) || hasJsonContent(row.inactive_genotype_perturbations)) && (
                        <p className="mt-1 break-words font-mono text-xs text-slate-500">
                          active genotype={row.active_genotype_perturbations} · inactive genotype={row.inactive_genotype_perturbations}
                        </p>
                      )}
                    </div>
                  </label>
                )
              })}
              {compatibleTfConditions.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  No existing TF state rules match the current media recipe yet.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium text-amber-950">Create TF state rules only for reconstruction-level regulatory states you can justify.</p>
              <p className="mt-1 leading-6">These rows do not simulate a free-form TF knockout. They define when a TF complex is considered active or inactive under nutrient and optional genotype contexts.</p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-900">Draft TF state rules</p>
                <p className="text-sm text-slate-500">These rows encode nutrient-dependent active and inactive TF states used by the reconstruction.</p>
              </div>
              <button
                type="button"
                onClick={addTfDraftRow}
                className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                Add row
              </button>
            </div>

            {draftTfRows.map((row) => (
              <div key={row.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <FieldLabel
                      label="TF gene symbol"
                      tooltip="Short transcription-factor gene symbol, for example crp, fnr, or arcA."
                    />
                    <select
                      value={row.tf}
                      onChange={(event) => updateTfDraftRow(row.id, 'tf', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      <option value="">Choose TF gene...</option>
                      {row.tf && !tfGeneSuggestions.includes(row.tf) && (
                        <option value={row.tf}>{row.tf} - current draft value</option>
                      )}
                      {tfGeneSuggestions.map((tfGene) => (
                        <option key={tfGene} value={tfGene}>{tfGene}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Use a TF gene already present in the reconstruction rules.</p>
                  </label>
                  <label className="block">
                    <FieldLabel
                      label="Active TF complex"
                      tooltip="Model complex or monomer ID for the active regulatory form."
                    />
                    <select
                      value={row.active_tf}
                      onChange={(event) => updateTfDraftRow(row.id, 'active_tf', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      <option value="">Choose active TF complex...</option>
                      {row.active_tf && !tfComplexSuggestions.includes(row.active_tf) && (
                        <option value={row.active_tf}>{row.active_tf} - current draft value</option>
                      )}
                      {tfComplexSuggestions.map((complexId) => (
                        <option key={complexId} value={complexId}>{complexId}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Use a model complex or monomer ID already present in TF state rules.</p>
                  </label>
                  <label className="block">
                    <FieldLabel
                      label="Active nutrient recipe"
                      tooltip="Recipe context where this TF complex is considered active."
                    />
                    <select
                      value={row.active_nutrients}
                      onChange={(event) => updateTfDraftRow(row.id, 'active_nutrients', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      {availableMediaIds.map((mediaId) => (
                        <option key={mediaId} value={mediaId}>{mediaId}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs leading-5 text-slate-500">The media recipe under which the active state applies.</p>
                  </label>
                  <label className="block">
                    <FieldLabel
                      label="Inactive nutrient recipe"
                      tooltip="Contrasting recipe context where this TF complex is considered inactive."
                    />
                    <select
                      value={row.inactive_nutrients}
                      onChange={(event) => updateTfDraftRow(row.id, 'inactive_nutrients', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      {availableMediaIds.map((mediaId) => (
                        <option key={mediaId} value={mediaId}>{mediaId}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs leading-5 text-slate-500">The comparison recipe where the same TF rule is inactive.</p>
                  </label>
                  <label className="block">
                    <FieldLabel
                      label="Active genotype context"
                      tooltip={'JSON-style object for genotype constraints required by the active state. Use {} when none apply.'}
                    />
                    {stateIdSuggestions.length > 0 && (
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          const stateId = event.target.value
                          if (!stateId) return
                          updateTfDraftRow(row.id, 'active_genotype_perturbations', upsertJsonObjectValue(row.active_genotype_perturbations, stateId, 0))
                          event.target.value = ''
                        }}
                        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      >
                        <option value="">Add known state ID forced to 0...</option>
                        {stateIdSuggestions.map((stateId) => (
                          <option key={stateId} value={stateId}>{stateId}</option>
                        ))}
                      </select>
                    )}
                    <textarea
                      value={row.active_genotype_perturbations}
                      onChange={(event) => updateTfDraftRow(row.id, 'active_genotype_perturbations', event.target.value)}
                      rows={2}
                      placeholder="{}"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                    <p className="mt-1 text-xs leading-5 text-slate-500"><span className="font-mono">{'{}'}</span> means no genotype constraint for the active state.</p>
                  </label>
                  <label className="block">
                    <FieldLabel
                      label="Inactive genotype context"
                      tooltip={'JSON-style object for genotype constraints required by the inactive state. Use {} when none apply.'}
                    />
                    {stateIdSuggestions.length > 0 && (
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          const stateId = event.target.value
                          if (!stateId) return
                          updateTfDraftRow(row.id, 'inactive_genotype_perturbations', upsertJsonObjectValue(row.inactive_genotype_perturbations, stateId, 0))
                          event.target.value = ''
                        }}
                        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      >
                        <option value="">Add known state ID forced to 0...</option>
                        {stateIdSuggestions.map((stateId) => (
                          <option key={stateId} value={stateId}>{stateId}</option>
                        ))}
                      </select>
                    )}
                    <textarea
                      value={row.inactive_genotype_perturbations}
                      onChange={(event) => updateTfDraftRow(row.id, 'inactive_genotype_perturbations', event.target.value)}
                      rows={2}
                      placeholder="{}"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                    <p className="mt-1 text-xs leading-5 text-slate-500">Example: <span className="font-mono">{'{"EG10325_RNA": 0}'}</span> means the inactive state depends on that RNA being forced to zero.</p>
                  </label>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <label className="block w-full">
                    <FieldLabel
                      label="TF rule class"
                      tooltip="0CS = no sensor chemistry; 1CS = one-component sensor; 2CS = two-component phosphorelay."
                    />
                    <select
                      value={row.tf_type}
                      onChange={(event) => updateTfDraftRow(row.id, 'tf_type', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      {row.tf_type && !['0CS', '1CS', '2CS'].includes(row.tf_type) && (
                        <option value={row.tf_type}>{row.tf_type} - current draft value</option>
                      )}
                      <option value="0CS">0CS - no sensor chemistry</option>
                      <option value="1CS">1CS - one-component sensor</option>
                      <option value="2CS">2CS - two-component phosphorelay</option>
                    </select>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Use the class that matches the TF mechanism encoded by the reconstruction.</p>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeTfDraftRow(row.id)}
                    className="self-start rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    )
  }

  function renderTimelineSection() {
    const protocolSummary = summarizeMediaProtocol(effectiveTimelineEvents || recommendedTimelineStart)
    const selectedProtocolStartsCurrent = Boolean(currentMediaRecipeId && selectedExistingTimeline && firstTimelineMedia(selectedExistingTimeline.events) === currentMediaRecipeId)
    const selectedProtocolInvolvesCurrent = Boolean(currentMediaRecipeId && selectedExistingTimeline && protocolInvolvesMedia(selectedExistingTimeline, currentMediaRecipeId))

    return (
      <SectionCard
        sectionId="timeline"
        highlighted={highlightedSection === 'timeline'}
        title="5. Does the environment stay constant or shift over time?"
        subtitle="Choose or draft the media protocol. One event is static; later events are scheduled shifts."
        collapsible
        collapsed={collapsedSections.timeline}
        onToggleCollapse={() => toggleSection('timeline')}
        actions={renderSectionActions('timeline')}
      >
        <ExistingCreateToggle mode={timelineMode} onChange={setTimelineMode} />

        {timelineMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Compatible protocols</span>
              <select
                value={selectedTimelineId}
                onChange={(event) => setSelectedTimelineId(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {currentMediaRecipeId ? (
                  <>
                    {compatibleTimelineGroups.starts.length > 0 && (
                      <optgroup label="Starts with selected recipe">
                        {compatibleTimelineGroups.starts.map((timeline) => (
                          <option key={timeline.timeline} value={timeline.timeline}>{timeline.timeline}</option>
                        ))}
                      </optgroup>
                    )}
                    {compatibleTimelineGroups.involves.length > 0 && (
                      <optgroup label="Shifts into or otherwise involves selected recipe">
                        {compatibleTimelineGroups.involves.map((timeline) => (
                          <option key={timeline.timeline} value={timeline.timeline}>{timeline.timeline}</option>
                        ))}
                      </optgroup>
                    )}
                  </>
                ) : (
                  compatibleTimelines.map((timeline) => (
                    <option key={timeline.timeline} value={timeline.timeline}>{timeline.timeline}</option>
                  ))
                )}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Protocols are grouped by whether they start with the current recipe or shift into it later.
              </p>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Protocol summary</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">{protocolSummary.label}</span>
                {timelineMode === 'existing' && selectedExistingTimeline && currentMediaRecipeId && (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${selectedProtocolStartsCurrent ? 'bg-cyan-50 text-cyan-700' : 'bg-amber-50 text-amber-700'}`}>
                    {selectedProtocolStartsCurrent ? 'starts here' : selectedProtocolInvolvesCurrent ? 'reaches selected recipe later' : 'different recipe'}
                  </span>
                )}
                <span className="text-xs text-slate-500">{protocolSummary.detail}</span>
              </div>
              <p className="mt-3 break-words font-mono text-sm text-slate-700">
                {selectedExistingTimeline?.events || 'No compatible protocol selected.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <FieldLabel
                  label="Protocol ID"
                  tooltip="Protocol IDs usually start with a numeric prefix and then a short snake_case name, for example 000028_add_aa_long."
                />
                <input
                  type="text"
                  value={draftTimelineName}
                  onChange={(event) => setDraftTimelineName(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
              </label>
              <label className="block">
                <FieldLabel
                  label="Protocol view range (hr)"
                  tooltip="Controls the editable timeline horizon shown in this composer. The published catalog row stores event times in seconds, but users should set the range in hours."
                />
                <input
                  type="number"
                  min={0.25}
                  step={0.25}
                  value={timelineDurationSec / 3600}
                  onChange={(event) => setTimelineDurationSec(Math.max(900, Math.round((Number(event.target.value) || 0.25) * 3600)))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
                <p className="mt-1 text-xs leading-5 text-slate-500">This is only the composer horizon. It is not the simulation division timeout from Design Experiment.</p>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
              <span className="font-medium">Recommended first event</span>
              <span className="font-mono">0 min: {currentMediaRecipeId || 'minimal'}</span>
              <span className="text-xs text-cyan-700">encoded as <span className="font-mono">{recommendedTimelineStart}</span></span>
              <button
                type="button"
                onClick={() => setTimelineSeedVersion((current) => current + 1)}
                className="rounded-xl border border-cyan-200 bg-white px-3 py-1.5 text-xs font-medium text-cyan-700 transition-colors hover:bg-cyan-100"
              >
                Reset composer
              </button>
            </div>

            <TimelineComposer
              key={`${timelineSeedVersion}-${currentMediaRecipeId || 'minimal'}`}
              mediaRecipes={builderMediaRecipes}
              conditions={builderConditions}
              onChange={setDraftTimelineEvents}
              maxSec={timelineDurationSec}
              initialDefinition={recommendedTimelineStart}
              showLibrarySave={false}
              entryNounSingular="media protocol"
              entryNounPlural="media protocols"
            />

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">Current protocol</p>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">{protocolSummary.label}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{protocolSummary.detail}</p>
              <p className="mt-2 break-words font-mono text-xs leading-6 text-slate-700">
                {effectiveTimelineEvents || recommendedTimelineStart}
              </p>
            </div>
          </div>
        )}
      </SectionCard>
    )
  }

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-6">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(22,163,74,0.15),_transparent_35%),radial-gradient(circle_at_right,_rgba(14,165,233,0.18),_transparent_30%),linear-gradient(135deg,_#0f172a,_#123b56_55%,_#0f766e)] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-8 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">Simulate</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Conditions Builder</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200">
              Build reusable experiment environments by answering five connected questions: starting stock, named media recipe, growth condition, TF state rules, and media protocol. Published records appear as selectable options when designing simulations.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/experiments"
              className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
            >
              Open experiments
            </Link>
            <span className="inline-flex items-center rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-medium text-amber-100">
              drafts saved in backend
            </span>
          </div>
        </div>
      </section>

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {actionMessage && (
        <div className={`rounded-2xl px-4 py-3 text-sm ${actionMessage.type === 'error'
          ? 'border border-red-200 bg-red-50 text-red-700'
          : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          {actionMessage.text}
        </div>
      )}

      {previewSection && (publishPreview || previewError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-8">
          <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Publish review</p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-950">{SECTION_LABELS[previewSection]}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {publishPreview
                      ? <>Review the reconstruction rows that will be written for draft <span className="font-mono text-slate-700">{publishPreview.draft_name}</span>.</>
                      : 'Review failed before any reconstruction write was attempted.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closePublishPreview}
                  disabled={Boolean(publishingSection)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {previewError && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {previewError}
                </div>
              )}

              {publishPreview?.warnings.length ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-sm font-semibold text-amber-950">Warnings</p>
                  <ul className="mt-2 space-y-1 text-sm text-amber-900">
                    {publishPreview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="space-y-4">
                {(publishPreview?.changes || []).map((change) => (
                  <div key={`${change.file}-${change.action}`} className="rounded-xl border border-slate-200 bg-slate-50">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                      <div>
                        <p className="font-mono text-sm font-semibold text-slate-900">{change.file}</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {change.rows.length} row{change.rows.length === 1 ? '' : 's'} staged for publish
                        </p>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${publishActionClasses(change.action)}`}>
                        {change.action}
                      </span>
                    </div>
                    <div className="max-h-56 overflow-auto p-4">
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-700">
                        {change.rows.join('\n')}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
              <p className="text-sm text-slate-500">
                {publishPreview
                  ? 'Confirming publishes these rows into the local reconstruction catalog and refreshes dropdown options.'
                  : 'Fix the draft inputs or dependency chain, then review publish again.'}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closePublishPreview}
                  disabled={Boolean(publishingSection)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { void confirmPublishSection() }}
                  disabled={Boolean(publishingSection) || previewLoading || !publishPreview}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {publishingSection ? 'Publishing...' : 'Confirm publish'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <details
        open={dependencyOpen}
        onToggle={(event) => setDependencyOpen((event.target as HTMLDetailsElement).open)}
        className="rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <summary className="cursor-pointer list-none px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Five-question dependency map</p>
              <p className="mt-1 text-sm text-slate-500">Move from raw medium to experiment-ready environment. Use the exchange registry only when you need a new molecule ID.</p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {dependencyOpen ? 'Hide' : 'Show'}
            </span>
          </div>
        </summary>
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="grid gap-3 lg:grid-cols-5">
            {dependencyMainSteps.map((step, index) => {
              const badge = dependencyBadge(step.id)
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => jumpToDependencyStep(step.id)}
                  className="group relative rounded-2xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-cyan-300 hover:bg-cyan-50/40"
                >
                  {index < dependencyMainSteps.length - 1 && (
                    <span className="pointer-events-none absolute -right-3 top-1/2 hidden h-px w-3 bg-slate-300 lg:block" />
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-600 text-xs font-semibold text-white">{index + 1}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.classes}`}>{badge.label}</span>
                  </div>
                  <p className="mt-3 text-sm font-semibold leading-5 text-slate-950">{step.question}</p>
                  <p className="mt-2 break-words font-mono text-xs text-cyan-800">{dependencyAnswers[step.id]}</p>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{step.label}</p>
                </button>
              )
            })}
          </div>

          <div className="mt-4 rounded-2xl border border-cyan-100 bg-cyan-50 px-4 py-3">
            <p className="text-sm font-semibold text-cyan-950">How to read this flow</p>
            <p className="mt-1 text-sm leading-6 text-cyan-900">{dependencyLevelGuide}</p>
            <p className="mt-2 text-sm leading-6 text-cyan-800">Key handoff: recipe ID to growth-condition nutrients to TF nutrient fields to protocol start.</p>
          </div>

          <div className="mt-4 space-y-4">
            {dependencyMainSteps.map((step, index) => {
              const badge = dependencyBadge(step.id)

              return (
                <div key={step.id} className="relative pl-12">
                  {index < dependencyMainSteps.length - 1 && (
                    <div className="absolute bottom-[-18px] left-4 top-10 w-px bg-slate-200" />
                  )}

                  <div className="absolute left-0 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-cyan-200 bg-cyan-50 text-xs font-semibold text-cyan-700">
                    {index + 1}
                  </div>

                  <button
                    type="button"
                    onClick={() => jumpToDependencyStep(step.id)}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition-colors hover:border-cyan-200 hover:bg-cyan-50/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900">{step.question}</p>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.classes}`}>{badge.label}</span>
                      </div>
                      <span className="text-xs font-medium text-cyan-700">Open section</span>
                    </div>

                    <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">{step.label}</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{step.summary}</p>

                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Needs: {step.needs}</span>
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Creates: {step.creates}</span>
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1">Next: {step.unlocks}</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {dependencyMappings[step.id].map((item) => (
                        <span key={item} className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-medium text-cyan-800">
                          {item}
                        </span>
                      ))}
                    </div>

                    <p className="mt-3 text-xs text-slate-400">{step.file}</p>
                  </button>

                  {step.id === 'media' && dependencyBranchStep && (
                    <div className="ml-6 mt-3 border-l-2 border-dashed border-amber-200 pl-4">
                      <button
                        type="button"
                        onClick={() => jumpToDependencyStep(dependencyBranchStep.id)}
                        className="w-full rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left hover:bg-amber-100/70"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-amber-950">{dependencyBranchStep.question}</p>
                            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${dependencyBadge(dependencyBranchStep.id).classes}`}>
                              {dependencyBadge(dependencyBranchStep.id).label}
                            </span>
                          </div>
                          <span className="text-xs font-medium text-amber-800">Open section</span>
                        </div>

                        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-amber-700/80">{dependencyBranchStep.label}</p>
                        <p className="mt-2 text-sm leading-6 text-amber-900">{dependencyBranchStep.summary}</p>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-amber-900">
                          <span className="rounded-full border border-amber-200 bg-white/70 px-2.5 py-1">Use: {dependencyBranchStep.needs}</span>
                          <span className="rounded-full border border-amber-200 bg-white/70 px-2.5 py-1">Creates: {dependencyBranchStep.creates}</span>
                          <span className="rounded-full border border-amber-200 bg-white/70 px-2.5 py-1">Next: {dependencyBranchStep.unlocks}</span>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          {dependencyMappings.environment.map((item) => (
                            <span key={item} className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-medium text-amber-900">
                              {item}
                            </span>
                          ))}
                        </div>

                        <p className="mt-3 text-xs text-amber-700/80">{dependencyBranchStep.file}</p>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </details>

      <details
        open={catalogOpen}
        onToggle={(event) => setCatalogOpen((event.target as HTMLDetailsElement).open)}
        className="rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <summary className="cursor-pointer list-none px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Catalog status</p>
              <p className="mt-1 text-sm text-slate-500">Collapsed by default, with current data availability across the condition catalog.</p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {catalogOpen ? 'Hide' : 'Show'}
            </span>
          </div>
        </summary>
        <div className="grid gap-3 border-t border-slate-100 px-5 py-4 md:grid-cols-2 xl:grid-cols-3">
          {catalogStats.map((item) => (
            <div key={item.label} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{loading ? '...' : item.value}</p>
              <p className="mt-1 text-sm text-slate-500">{item.description}</p>
            </div>
          ))}
        </div>
      </details>

      {compatibilityWarnings.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {compatibilityWarnings.map((warning) => (
            <p key={warning} className="leading-6">{warning}</p>
          ))}
        </div>
      )}

      <section className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr),410px]">
        <div className="min-w-0 space-y-4">
          {renderMediaSection()}
          {renderMediaRecipeSection()}
          {renderConditionSection()}
          {renderTfConditionSection()}
          {renderTimelineSection()}
        </div>

        <aside className="min-w-0 space-y-4">
          <SavedStatePanel sectionSummaries={sectionSummaries} isSaved={isSaved} isDirty={isDirty} />
        </aside>
      </section>
    </div>
  )
}
