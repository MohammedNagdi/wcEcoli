import { useEffect, useState } from 'react'
import { getAAPathways, getDesignOverview, getEssentiality } from '../../api/client'
import type { AAPathway, DesignOverview, EssentialityStats } from '../../types'
import { AAPathwayDiagram } from './AAPathwayDiagram'
import { EssentialityHeatmap } from './EssentialityHeatmap'

type ViewMode = 'heatmap' | 'pathway'

export function PathwaysPage() {
  const [view, setView] = useState<ViewMode>('heatmap')
  const [overview, setOverview] = useState<DesignOverview | null>(null)
  const [essentiality, setEssentiality] = useState<EssentialityStats[]>([])
  const [pathways, setPathways] = useState<AAPathway[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pathways</h1>
          <p className="mt-1 text-sm text-gray-500">
            Explore knockout essentiality across gene categories and amino acid pathway dependencies.
          </p>
        </div>

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
          <EssentialityHeatmap essentiality={essentiality} genes={overview.genes} />
        ) : (
          <AAPathwayDiagram pathways={pathways} genes={overview.genes} />
        )}
      </div>
    </div>
  )
}
