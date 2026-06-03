import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
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
  MediaRecipe,
  MediaRecipeRecord,
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
  media: 'Growth Media',
  mediaRecipe: 'Media Formulations',
  condition: 'Growth Conditions',
  tfCondition: 'TF Activation Rules',
  timeline: 'Media Shift Schedules',
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
    label: 'Growth media stocks',
    summary: 'Defines the stock medium.',
    definition: 'A growth medium specifies which chemical species the cell\'s environment contains and at what concentrations (mmol/L). The concentrations set boundary flux constraints in the metabolic model — finite values cap uptake or secretion, while Infinity means unconstrained availability (used for gases, water, and trace metals).',
    needs: 'Known molecule IDs.',
    creates: 'A medium name such as MIX0-57.',
    unlocks: 'Used as the base medium in a formulation.',
  },
  {
    id: 'environment',
    file: 'condition/environment_molecules.tsv',
    label: 'Exchange molecule registry',
    summary: 'Registers new molecule IDs.',
    definition: 'Every molecule that can cross the cell boundary must be registered with a unique ID, a compartment location ([p] for periplasm, [c] for cytoplasm), and a molecular weight. Add entries here only when introducing a molecule ID that the reconstruction does not already know — most common metabolites are pre-registered.',
    needs: 'Only if a new medium needs a new ID.',
    creates: 'Molecule IDs such as MY_CARBON_SRC.',
    unlocks: 'Those IDs can be used in media and formulations.',
    branch: true,
  },
  {
    id: 'mediaRecipe',
    file: 'condition/media_recipes.tsv',
    label: 'Media formulations',
    summary: 'Builds the formulation ID used by experiments.',
    definition: 'A formulation bundles a base medium stock with any supplementary stocks or discrete ingredients and assigns a single short ID (e.g. minimal_acetate). All downstream records — growth conditions, TF activation rules, and schedules — reference this ID instead of the raw stock name.',
    needs: 'A base medium and any ingredient IDs.',
    creates: 'A formulation ID such as minimal_acetate.',
    unlocks: 'Used as nutrients in Growth Conditions.',
  },
  {
    id: 'condition',
    file: 'condition/condition_defs.tsv',
    label: 'Growth condition definitions',
    summary: 'Defines the biological state for a formulation.',
    definition: 'A growth condition maps a formulation to the full biological context: which transcription factor complexes are active or inactive, which genes are perturbed, and what the expected doubling time is. It is the central record that ties the chemical environment to the regulatory state of the cell.',
    needs: 'A formulation ID from Media Formulations.',
    creates: 'A condition name, nutrients, TF lists, and doubling time.',
    unlocks: 'Keeps TF rules aligned to the same setup.',
  },
  {
    id: 'tfCondition',
    file: 'condition/tf_condition.tsv',
    label: 'TF activation rules',
    summary: 'Adds nutrient-specific TF logic.',
    definition: 'Transcription factors (TFs) switch gene expression in response to environmental signals. Each row declares: under the active nutrient context this TF complex is active, under the contrasting inactive context it is off. The simulator reads these rules to set regulatory state before each run.',
    needs: 'The same formulation context used by the Growth Condition.',
    creates: 'Active and inactive TF rules.',
    unlocks: 'Finishes the regulatory context before scheduling.',
  },
  {
    id: 'timeline',
    file: 'condition/timelines_def.tsv',
    label: 'Media shift schedules',
    summary: 'Orders formulation changes over time.',
    definition: 'A schedule is a comma-separated list of time–formulation pairs, e.g. "0 minimal, 3600 minimal_acetate". The cell starts in the first medium and shifts at each specified time (in seconds). For Levels 2 and 3 the first event should match the current formulation.',
    needs: 'Formulation IDs; the first event should start from the current formulation.',
    creates: 'The final schedule string.',
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
      title="Saved state"
      subtitle="Each section saves locally so you can see what is settled and what still has unsaved changes."
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
      label: 'Define after formulation',
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
  currentScheduleStartReference: string
}): Record<SaveSectionKey, string> {
  return {
    media: mediaMode === 'existing'
      ? `Using ${currentMediaStockName || 'no medium selected'}`
      : `${draftMediaStockName || 'Untitled medium'} with ${compactRows(draftMediaRows, (row) => Boolean(row.molecule_id.trim())).length} rows`,
    mediaRecipe: effectiveMediaRecipe
      ? `${effectiveMediaRecipe.media_id} from ${effectiveMediaRecipe.base_media}`
      : 'Choose or create a formulation',
    condition: effectiveCondition
      ? `${effectiveCondition.condition} on ${effectiveCondition.nutrients}`
      : 'Choose or create a growth condition',
    tfCondition: effectiveTfRows.length > 0
      ? `${effectiveTfRows.length} TF rule${effectiveTfRows.length === 1 ? '' : 's'} ready`
      : 'No TF rules selected yet',
    timeline: `${effectiveTimelineName || 'draft schedule'} starts at ${currentScheduleStartReference}`,
  }
}

export function EnvironmentBuilderPage() {
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

  const [conditionMode, setConditionMode] = useState<SectionMode>('create')
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

  const [timelineMode, setTimelineMode] = useState<SectionMode>('create')
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

  const currentMediaStockName = mediaMode === 'existing'
    ? selectedMediaStockName
    : draftMediaStockName.trim() || 'MY_NEW_MIX'

  const defaultExistingMediaStockName = useMemo(() => {
    if (!mediaStocks.length) return ''
    const recipeBackedStocks = new Set(allMediaRecipes.map((recipe) => recipe.base_media))
    return mediaStocks.find((stock) => recipeBackedStocks.has(stock.name))?.name || mediaStocks[0].name
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

  const selectedTfRows = compatibleTfConditions.filter((row) => selectedExistingTfKeys.includes(`${row.tf}|${row.active_tf}|${row.active_nutrients}|${row.inactive_nutrients}`))
  const effectiveTfRows: Array<TfConditionRecord | DraftTfConditionRow> = tfConditionMode === 'existing'
    ? selectedTfRows
    : compactRows(draftTfRows, (row) => (
      Boolean(row.tf.trim() || row.active_tf.trim() || row.active_nutrients.trim() || row.inactive_nutrients.trim())
    ))

  const compatibleTimelines = useMemo(() => {
    if (!currentMediaRecipeId) return allTimelines
    return allTimelines.filter((timeline) => firstTimelineMedia(timeline.events) === currentMediaRecipeId)
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
    const compatibleKeys = new Set(compatibleTfConditions.map((row) => `${row.tf}|${row.active_tf}|${row.active_nutrients}|${row.inactive_nutrients}`))
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

  const tfComplexSuggestions = useMemo(() => {
    const ids = new Set<string>()
    allTfConditions.forEach((row) => {
      if (row.active_tf) ids.add(row.active_tf)
    })
    return Array.from(ids).sort()
  }, [allTfConditions])

  const catalogStats = [
    { label: 'Growth media', value: mediaStocks.length, description: 'Files under condition/media/*.tsv' },
    { label: 'Environment molecules', value: environmentMolecules.length, description: 'Rows in environment_molecules.tsv' },
    { label: 'Media formulations', value: allMediaRecipes.length, description: 'Rows in media_recipes.tsv' },
    { label: 'Growth conditions', value: allConditions.length, description: 'Rows in condition_defs.tsv' },
    { label: 'TF activation rules', value: allTfConditions.length, description: 'Rows in tf_condition.tsv' },
    { label: 'Media shift schedules', value: allTimelines.length, description: 'Rows in timelines_def.tsv' },
  ]

  const compatibilityWarnings = useMemo(() => {
    const warnings: string[] = []
    if (!currentMediaRecipeId) {
      warnings.push('Choose or create a compatible media formulation before growth conditions, TF activation rules, or media shift schedules.')
    }
    if (conditionMode === 'create' && currentMediaRecipeId && effectiveCondition?.nutrients !== currentMediaRecipeId) {
      warnings.push('The draft growth condition nutrients should match the current media formulation to stay compatible.')
    }
    if (tfConditionMode === 'create' && currentMediaRecipeId) {
      const invalidTfDraft = effectiveTfRows.some((row) => (
        row.active_nutrients !== currentMediaRecipeId && row.inactive_nutrients !== currentMediaRecipeId
      ))
      if (invalidTfDraft) {
        warnings.push('Each draft TF activation rule should reference the current media formulation in either active or inactive nutrients.')
      }
    }
    if (currentMediaRecipeId && firstTimelineMedia(effectiveTimelineEvents) !== currentMediaRecipeId) {
      warnings.push('The media shift schedule should start from the current media formulation.')
    }
    return warnings
  }, [
    conditionMode,
    currentMediaRecipeId,
    effectiveCondition,
    effectiveTfRows,
    effectiveTimelineEvents,
    tfConditionMode,
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
      setConditionMode(mode)
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
      setTimelineMode(mode)
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

  const dependencyLevelGuide = 'Work from upstream chemistry to downstream experiment setup. Reuse catalog entries when they already match your experiment, and only use the exchange molecule registry when you introduce a brand-new molecule ID.'

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
    mediaRecipe: [`${currentFormulationReference} -> nutrients`, `${currentFormulationReference} -> first event`],
    condition: [`condition = ${currentConditionReference}`, `nutrients = ${effectiveCondition?.nutrients || currentFormulationReference}`],
    tfCondition: [`TF nutrients = ${currentTfReference}`],
    timeline: [`start = 0 ${currentScheduleStartReference}`],
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
    currentScheduleStartReference,
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
        title="1. Growth Media"
        subtitle="Choose an existing growth medium file or draft a new one, then list any exchange molecules it needs."
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
                tooltip="Growth medium names come from files under condition/media. They are usually uppercase names such as MIX0-57 or MIX0-844."
              />
              <select
                value={selectedMediaStockName}
                onChange={(event) => setSelectedMediaStockName(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {mediaStocks.map((stock) => (
                  <option key={stock.name} value={stock.name}>{stock.name}</option>
                ))}
              </select>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">Selected medium summary</p>
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
            <label className="block">
              <FieldLabel
                label="New growth medium name"
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
            </label>

            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">Growth medium composition</p>
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
              <div className="mt-1 space-y-3">
                {draftMediaRows.map((row) => (
                  <div key={row.id} className="grid gap-3 md:grid-cols-[1fr,180px,auto]">
                    <input
                      type="text"
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
                Available as in reconstruction `condition/environment_molecules.tsv`. Add existing molecules to the draft or define new ones.
              </p>
              <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
                <div>
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

                <div>
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
                    <div className="hidden gap-3 md:grid" style={{ gridTemplateColumns: '1fr 110px 130px auto' }}>
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
                      <div key={row.id} className="grid gap-3 md:grid-cols-[1fr,110px,130px,auto]">
                        <input
                          type="text"
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
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
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
        title="2. Media Formulations"
        subtitle="Define or choose a named media formulation. Existing options are filtered so they stay compatible with the growth media step above."
        collapsible
        collapsed={collapsedSections.mediaRecipe}
        onToggleCollapse={() => toggleSection('mediaRecipe')}
        actions={renderSectionActions('mediaRecipe')}
      >
        <ExistingCreateToggle mode={mediaRecipeMode} onChange={setMediaRecipeMode} />

        {mediaRecipeMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Compatible formulations</span>
              <select
                value={selectedMediaRecipeId}
                onChange={(event) => setSelectedMediaRecipeId(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {compatibleMediaRecipes.map((recipe) => (
                  <option key={recipe.media_id} value={recipe.media_id}>{recipe.media_id}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Existing formulations are filtered so `base media` matches the current growth media selection.
              </p>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium text-slate-900">Formulation summary</p>
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
                <dl className="mt-3 grid gap-2">
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Base media</dt><dd className="font-mono text-slate-900">{selectedExistingMediaRecipe.base_media}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Added media</dt><dd className="font-mono text-slate-900">{selectedExistingMediaRecipe.added_media || 'None'}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Ingredients</dt><dd className="break-words font-mono text-slate-900">{selectedExistingMediaRecipe.ingredients}</dd></div>
                </dl>
              ) : (
                <p className="mt-3">No compatible media formulation is currently available for the selected growth medium.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <FieldLabel
                label="Formulation ID"
                tooltip="Use lowercase snake_case for named formulation IDs, for example minimal_acetate or my_new_media. This is the name used later in growth conditions and media shift schedules."
              />
              <input
                type="text"
                value={draftMediaRecipe.media_id}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, media_id: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block">
              <FieldLabel
                label="Base medium"
                tooltip="This should match a stock growth medium file name such as MIX0-57 or MY_NEW_MIX."
              />
              <select
                value={draftMediaRecipe.base_media}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, base_media: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {stockMediaOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Base medium volume (units.L)</span>
              <input
                type="text"
                value={draftMediaRecipe.base_media_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, base_media_volume: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
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
                {stockMediaOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Added medium volume (units.L)</span>
              <input
                type="text"
                value={draftMediaRecipe.added_media_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, added_media_volume: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Ingredients"
                tooltip={'Write ingredients as a JSON-style list of molecule IDs, for example ["MY_CARBON_SRC", "FDFD"]. Use the exact molecule IDs that appear in environment_molecules.tsv.'}
              />
              <textarea
                value={draftMediaRecipe.ingredients}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block">
              <FieldLabel
                label="Ingredients weight (units.g)"
                tooltip="Write this as a JSON-style list aligned with Ingredients, for example [Infinity] or [-Infinity, Infinity]."
              />
              <textarea
                value={draftMediaRecipe.ingredients_weight}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_weight: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block">
              <FieldLabel
                label="Ingredients counts (units.mmol)"
                tooltip="Write this as a JSON-style list aligned with Ingredients, for example [Infinity]."
              />
              <textarea
                value={draftMediaRecipe.ingredients_counts}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_counts: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Ingredients volume (units.L)"
                tooltip="Write this as a JSON-style list aligned with Ingredients, for example [] or [0.2]."
              />
              <textarea
                value={draftMediaRecipe.ingredients_volume}
                onChange={(event) => setDraftMediaRecipe((current) => ({ ...current, ingredients_volume: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
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
        title="3. Growth Conditions"
        subtitle="Choose an existing growth condition that fits the selected media formulation, or draft a full condition_defs row."
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
                Existing growth conditions are filtered so `nutrients` matches the current media formulation.
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
                <p className="mt-3">No compatible growth condition is available for the current media formulation.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
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
            </label>
            <label className="block">
              <FieldLabel
                label="Nutrients / formulation ID"
                tooltip="This should match the formulation ID used by the growth condition, usually the media formulation selected above."
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
            </label>
            <label className="block">
              <FieldLabel
                label="Doubling time (min)"
                tooltip="Measured or expected doubling time in minutes under this condition. 44 min is a typical value for minimal glucose medium."
              />
              <input
                type="text"
                value={draftCondition.doubling_time}
                onChange={(event) => setDraftCondition((current) => ({ ...current, doubling_time: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block md:col-span-2">
              <FieldLabel
                label="Genotype perturbations"
                tooltip={'Write this as a JSON-style object, for example {} or {"EG10325_RNA": 0}.'}
              />
              <textarea
                value={draftCondition.genotype_perturbations}
                onChange={(event) => setDraftCondition((current) => ({ ...current, genotype_perturbations: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block">
              <FieldLabel
                label="Active TF complexes"
                tooltip={'Write this as a JSON-style list of TF complex IDs, for example ["CPLX0-226"].'}
              />
              <textarea
                value={draftCondition.active_tfs}
                onChange={(event) => setDraftCondition((current) => ({ ...current, active_tfs: event.target.value }))}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
            <label className="block">
              <FieldLabel
                label="Inactive TF complexes"
                tooltip={'Write this as a JSON-style list of TF complex IDs, for example ["CPLX0-7669"].'}
              />
              <textarea
                value={draftCondition.inactive_tfs}
                onChange={(event) => setDraftCondition((current) => ({ ...current, inactive_tfs: event.target.value }))}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              />
            </label>
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
        title="4. TF Activation Rules"
        subtitle="Choose compatible TF activation rows or draft new ones using the same columns as tf_condition.tsv."
        collapsible
        collapsed={collapsedSections.tfCondition}
        onToggleCollapse={() => toggleSection('tfCondition')}
        actions={renderSectionActions('tfCondition')}
      >
        <ExistingCreateToggle mode={tfConditionMode} onChange={setTfConditionMode} />

        {tfConditionMode === 'existing' ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-slate-500">
              Existing TF activation rules are filtered so either `active nutrients` or `inactive nutrients` matches the current media formulation.
            </p>
            <div className="space-y-2">
              {compatibleTfConditions.map((row) => {
                const key = `${row.tf}|${row.active_tf}|${row.active_nutrients}|${row.inactive_nutrients}`
                const checked = selectedExistingTfKeys.includes(key)

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
                        {(conditionActiveTfSet.has(row.active_tf) || conditionInactiveTfSet.has(row.active_tf))
                          ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">Consistent with condition</span>
                          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">Not in current condition</span>
                        }
                      </div>
                      <p className="mt-1 break-words font-mono text-xs text-slate-500">
                        active={row.active_nutrients} inactive={row.inactive_nutrients} type={row.tf_type}
                      </p>
                    </div>
                  </label>
                )
              })}
              {compatibleTfConditions.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  No existing TF activation rules match the current media formulation yet.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-900">Draft TF activation rules</p>
                <p className="text-sm text-slate-500">All fields from `tf_condition.tsv` are editable here.</p>
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
                  <input
                    type="text"
                    value={row.tf}
                    onChange={(event) => updateTfDraftRow(row.id, 'tf', event.target.value)}
                    placeholder="tf"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  />
                  <input
                    type="text"
                    list="tf-complex-options"
                    value={row.active_tf}
                    onChange={(event) => updateTfDraftRow(row.id, 'active_tf', event.target.value)}
                    placeholder="active TF complex"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  />
                  <select
                    value={row.active_nutrients}
                    onChange={(event) => updateTfDraftRow(row.id, 'active_nutrients', event.target.value)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  >
                    {availableMediaIds.map((mediaId) => (
                      <option key={mediaId} value={mediaId}>{mediaId}</option>
                    ))}
                  </select>
                  <select
                    value={row.inactive_nutrients}
                    onChange={(event) => updateTfDraftRow(row.id, 'inactive_nutrients', event.target.value)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  >
                    {availableMediaIds.map((mediaId) => (
                      <option key={mediaId} value={mediaId}>{mediaId}</option>
                    ))}
                  </select>
                  <textarea
                    value={row.active_genotype_perturbations}
                    onChange={(event) => updateTfDraftRow(row.id, 'active_genotype_perturbations', event.target.value)}
                    rows={2}
                    placeholder="active genotype perturbations"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  />
                  <textarea
                    value={row.inactive_genotype_perturbations}
                    onChange={(event) => updateTfDraftRow(row.id, 'inactive_genotype_perturbations', event.target.value)}
                    rows={2}
                    placeholder="inactive genotype perturbations"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <input
                    type="text"
                    value={row.tf_type}
                    onChange={(event) => updateTfDraftRow(row.id, 'tf_type', event.target.value)}
                    placeholder="1CS or 2CS"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                  />
                  <button
                    type="button"
                    onClick={() => removeTfDraftRow(row.id)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            <datalist id="tf-complex-options">
              {tfComplexSuggestions.map((complexId) => (
                <option key={complexId} value={complexId} />
              ))}
            </datalist>
          </div>
        )}
      </SectionCard>
    )
  }

  function renderTimelineSection() {
    return (
      <SectionCard
        sectionId="timeline"
        highlighted={highlightedSection === 'timeline'}
        title="5. Media Shift Schedules"
        subtitle="Choose an existing compatible media shift schedule or draft a new one with the composer below."
        collapsible
        collapsed={collapsedSections.timeline}
        onToggleCollapse={() => toggleSection('timeline')}
        actions={renderSectionActions('timeline')}
      >
        <ExistingCreateToggle mode={timelineMode} onChange={setTimelineMode} />

        {timelineMode === 'existing' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Compatible schedules</span>
              <select
                value={selectedTimelineId}
                onChange={(event) => setSelectedTimelineId(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
              >
                {compatibleTimelines.map((timeline) => (
                  <option key={timeline.timeline} value={timeline.timeline}>{timeline.timeline}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Existing schedules are filtered so the first media event matches the current media formulation when one is selected.
              </p>
            </label>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Schedule summary</p>
              <p className="mt-3 break-words font-mono text-sm text-slate-700">
                {selectedExistingTimeline?.events || 'No compatible schedule selected.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <FieldLabel
                  label="Schedule ID"
                  tooltip="Schedule IDs usually start with a numeric prefix and then a short snake_case name, for example 000028_add_aa_long."
                />
                <input
                  type="text"
                  value={draftTimelineName}
                  onChange={(event) => setDraftTimelineName(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Max duration (s)</span>
                <input
                  type="number"
                  min={60}
                  step={60}
                  value={timelineDurationSec}
                  onChange={(event) => setTimelineDurationSec(Math.max(60, Number(event.target.value) || 60))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
              <span className="font-medium">Recommended start</span>
              <span className="font-mono">{recommendedTimelineStart}</span>
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
              entryNounSingular="schedule"
              entryNounPlural="schedules"
            />

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">Current schedule event string</p>
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
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Experimental Conditions Builder</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200">
              Build one experimental-condition flow from upstream chemistry to downstream schedules: growth media, media formulations, growth conditions, TF activation rules, and media shift schedules. Each section can reuse existing catalog entries or draft new ones without switching workflows.
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
              <p className="text-sm font-semibold text-slate-900">Dependency chain</p>
              <p className="mt-1 text-sm text-slate-500">Follow the main path from medium to schedule. Use the exchange registry only when you need a new molecule ID.</p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {dependencyOpen ? 'Hide' : 'Show'}
            </span>
          </div>
        </summary>
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="rounded-2xl border border-cyan-100 bg-cyan-50 px-4 py-3">
            <p className="text-sm font-semibold text-cyan-950">How to read this flow</p>
            <p className="mt-1 text-sm leading-6 text-cyan-900">{dependencyLevelGuide}</p>
            <p className="mt-2 text-sm leading-6 text-cyan-800">Key handoff: formulation ID to growth-condition nutrients to TF nutrient fields to schedule start.</p>
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
                        <p className="text-sm font-semibold text-slate-900">{step.label}</p>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.classes}`}>{badge.label}</span>
                      </div>
                      <span className="text-xs font-medium text-cyan-700">Open section</span>
                    </div>

                    <p className="mt-2 text-sm leading-6 text-slate-600">{step.summary}</p>
                    <p className="mt-1 text-sm leading-6 text-slate-500">{step.definition}</p>

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
                            <p className="text-sm font-semibold text-amber-950">{dependencyBranchStep.label}</p>
                            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${dependencyBadge(dependencyBranchStep.id).classes}`}>
                              {dependencyBadge(dependencyBranchStep.id).label}
                            </span>
                          </div>
                          <span className="text-xs font-medium text-amber-800">Open section</span>
                        </div>

                        <p className="mt-2 text-sm leading-6 text-amber-900">{dependencyBranchStep.summary}</p>
                        <p className="mt-1 text-sm leading-6 text-amber-800">{dependencyBranchStep.definition}</p>

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

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr),410px]">
        <div className="space-y-4">
          {renderMediaSection()}
          {renderMediaRecipeSection()}
          {renderConditionSection()}
          {renderTfConditionSection()}
          {renderTimelineSection()}
        </div>

        <aside className="space-y-4">
          <SavedStatePanel sectionSummaries={sectionSummaries} isSaved={isSaved} isDirty={isDirty} />
        </aside>
      </section>
    </div>
  )
}
