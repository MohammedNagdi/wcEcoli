import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { getAAPathways, getDesignOverview, getEssentiality } from '../../api/client'
import type { AAPathway, DesignOverview, EssentialityStats } from '../../types'
import { AAPathwayDiagram } from './AAPathwayDiagram'
import { EssentialityHeatmap } from './EssentialityHeatmap'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { ASSISTANT_PATHWAY_SAMPLE_LIMIT, makeAssistantContextKey, summarizeAAPathway, truncateText } from '../../utils/assistantContext'

type ViewMode = 'heatmap' | 'pathway'

interface PathwaysPageProps {
  embedded?: boolean
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}

export function PathwaysPage({ embedded = false, onAssistantSnapshot }: PathwaysPageProps) {
  const location = useLocation()
  const [view, setView] = useState<ViewMode>('heatmap')
  const [overview, setOverview] = useState<DesignOverview | null>(null)
  const [essentiality, setEssentiality] = useState<EssentialityStats[]>([])
  const [pathways, setPathways] = useState<AAPathway[]>([])
  const [heatmapSnapshot, setHeatmapSnapshot] = useState<Record<string, unknown> | null>(null)
  const [pathwaySnapshot, setPathwaySnapshot] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const assistantCapturedAt = useRef(new Date().toISOString()).current

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([getEssentiality(), getDesignOverview(), getAAPathways()])
      .then(([essentialityData, overviewData, pathwayData]) => {
        setEssentiality(essentialityData)
        setOverview(overviewData)
        setPathways(pathwayData)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const assistantPageState = useMemo(() => ({
    kind: 'pathways_explorer',
    surface: 'pathways',
    summary: `Pathways ${view} view with ${essentiality.length} essentiality category row${essentiality.length === 1 ? '' : 's'} and ${pathways.length} amino-acid pathway row${pathways.length === 1 ? '' : 's'}.`,
    dirty: false,
    captured_at: assistantCapturedAt,
    route: `${location.pathname}${location.search}`,
    embedded,
    view,
    loading,
    error: truncateText(error),
    overview: overview
      ? {
        total_genes: overview.total_genes,
        mechanistic_genes: overview.mechanistic_genes,
        simulated_genes: overview.simulated_genes,
        essential_genes: overview.essential_genes,
        growth_defect_genes: overview.growth_defect_genes,
        neutral_genes: overview.neutral_genes,
        unknown_genes: overview.unknown_genes,
      }
      : null,
    essentiality_totals: essentiality.reduce(
      (acc, row) => {
        acc.total += row.total
        acc.essential += row.essential
        acc.growth_defect += row.growth_defect
        acc.neutral += row.neutral
        acc.unknown += row.unknown
        return acc
      },
      { total: 0, essential: 0, growth_defect: 0, neutral: 0, unknown: 0 }
    ),
    pathway_sample: pathways.slice(0, ASSISTANT_PATHWAY_SAMPLE_LIMIT).map(summarizeAAPathway),
    pathway_sample_truncated: pathways.length > ASSISTANT_PATHWAY_SAMPLE_LIMIT,
    heatmap: view === 'heatmap' ? heatmapSnapshot : null,
    pathway_diagram: view === 'pathway' ? pathwaySnapshot : null,
  }), [
    assistantCapturedAt,
    embedded,
    error,
    essentiality,
    heatmapSnapshot,
    loading,
    location.pathname,
    location.search,
    overview,
    pathwaySnapshot,
    pathways,
    view,
  ])

  useEffect(() => {
    onAssistantSnapshot?.(assistantPageState)
  }, [assistantPageState, onAssistantSnapshot])

  useRegisterAssistantContext({
    enabled: !embedded,
    contextKey: makeAssistantContextKey([
      'pathways_explorer',
      location.pathname,
      location.search,
      view,
      loading,
      error,
      essentiality.length,
      pathways.length,
      Boolean(heatmapSnapshot),
      Boolean(pathwaySnapshot),
    ]),
    context: {
      assistant_surface: 'pathways',
      route: `${location.pathname}${location.search}`,
      page_state: assistantPageState,
    },
    suggestedPrompt: 'Help me interpret this pathways view. Summarize essentiality patterns, amino-acid pathway dependencies, selected nodes, and useful gene follow-up views.',
  })

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-brand-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load pathway data: {error}
      </div>
    )
  }

  if (!overview) return null

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        {!embedded && (
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Pathways</h1>
            <p className="mt-1 text-sm text-gray-500">
              Explore knockout essentiality across gene categories and amino acid pathway dependencies.
            </p>
          </div>
        )}

        <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
          <button
            onClick={() => setView('heatmap')}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'heatmap'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Heatmap
          </button>
          <button
            onClick={() => setView('pathway')}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'pathway'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Pathway diagram
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        {view === 'heatmap' ? (
          <EssentialityHeatmap
            essentiality={essentiality}
            genes={overview.genes}
            onAssistantSnapshot={setHeatmapSnapshot}
          />
        ) : (
          <AAPathwayDiagram
            pathways={pathways}
            genes={overview.genes}
            onAssistantSnapshot={setPathwaySnapshot}
          />
        )}
      </div>
    </div>
  )
}
