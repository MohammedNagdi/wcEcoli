import { useEffect, useMemo, useState } from 'react'
import { getGenes } from '../../api/client'
import type { Gene } from '../../types'
import { CATEGORY_FILL, hasGenomePosition } from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'
import { SearchInput } from '../common/SearchInput'
import { SkeletonLine } from '../common/Skeleton'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { CircularGenomeMap } from './CircularGenomeMap'

interface CategorySummary {
  category: string
  count: number
}

interface GenomeViewerPageProps {
  embedded?: boolean
  compact?: boolean
}

export function GenomeViewerPage({ embedded = false, compact = false }: GenomeViewerPageProps) {
  const { selectedGene, selectedCategory, setSelectedCategory } = useUrlWorkspaceState()
  const [genes, setGenes] = useState<Gene[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [dimmedCategories, setDimmedCategories] = useState<Set<string>>(new Set())
  const [darkMode, setDarkMode] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getGenes({ page_size: 5000 })
      .then((data) => setGenes(data.genes))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [fullscreen])

  const mappedGenes = useMemo(() => genes.filter(hasGenomePosition), [genes])

  const forwardCount = useMemo(
    () => mappedGenes.filter((gene) => gene.direction === '+').length,
    [mappedGenes]
  )
  const reverseCount = useMemo(
    () => mappedGenes.filter((gene) => gene.direction === '-').length,
    [mappedGenes]
  )

  const categorySummary = useMemo<CategorySummary[]>(() => {
    const counts = new Map<string, number>()
    for (const gene of mappedGenes) {
      counts.set(gene.category, (counts.get(gene.category) ?? 0) + 1)
    }
    return Array.from(counts, ([category, count]) => ({ category, count })).sort((a, b) => {
      const knownA = CATEGORY_FILL[a.category] ? 0 : 1
      const knownB = CATEGORY_FILL[b.category] ? 0 : 1
      if (knownA !== knownB) return knownA - knownB
      return b.count - a.count
    })
  }, [mappedGenes])

  function toggleCategory(category: string) {
    setDimmedCategories((current) => {
      const next = new Set(current)
      if (next.has(category)) {
        next.delete(category)
      } else {
        next.add(category)
      }
      return next
    })
    setSelectedCategory(selectedCategory === category ? null : category)
  }

  if (loading) {
    return (
      <div className={compact ? 'space-y-3' : 'space-y-5'}>
        <div>
          <SkeletonLine className="h-8 w-64" />
          <SkeletonLine className="mt-2 h-4 w-96" />
        </div>
        <SkeletonLine className="h-[680px] rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load genome data: {error}
      </div>
    )
  }

  return (
    <>
      <div className={`mx-auto max-w-7xl ${compact ? 'h-full min-h-0 space-y-3 overflow-y-auto pr-1' : 'space-y-5'}`}>
        {!embedded && (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Circular Genome</h1>
              <p className="mt-1 text-sm text-gray-500">
                Interactive E. coli K-12 chromosome map with genes grouped by functional category.
              </p>
            </div>
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Search mapped genes..."
              className="w-full lg:w-80"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatBadge label="Mapped" value={mappedGenes.length.toLocaleString()} />
          <StatBadge label="Forward" value={forwardCount.toLocaleString()} />
          <StatBadge label="Reverse" value={reverseCount.toLocaleString()} />
          <StatBadge label="Unmapped" value={(genes.length - mappedGenes.length).toLocaleString()} />
          <button
            onClick={() => setDarkMode((current) => !current)}
            className="ml-auto flex-shrink-0 rounded-md border border-gray-200 bg-white p-1.5 text-gray-500 hover:bg-gray-50"
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            type="button"
          >
            {darkMode ? (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m8.66-9h-1M4.34 12h-1m15.07-6.36-.71.71M6.34 17.66l-.71.71m12.02 0-.71-.71M6.34 6.34l-.71-.71M12 7a5 5 0 100 10A5 5 0 0012 7z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setFullscreen(true)}
            className="flex-shrink-0 rounded-md border border-gray-200 bg-white p-1.5 text-gray-500 hover:bg-gray-50"
            title="Expand genome map"
            type="button"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>

        <CircularGenomeMap
          genes={mappedGenes}
          searchTerm={searchTerm || selectedGene || ''}
          dimmedCategories={dimmedCategories}
          compact={compact}
          darkMode={darkMode}
        />

        <div className={`flex flex-wrap gap-2 ${compact ? 'max-h-24 overflow-y-auto pr-1' : ''}`}>
          {categorySummary.map((item) => {
            const fill = CATEGORY_FILL[item.category] ?? CATEGORY_FILL.other
            const isDimmed = dimmedCategories.has(item.category)
            return (
              <button
                key={item.category}
                onClick={() => toggleCategory(item.category)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  isDimmed
                    ? 'border-gray-200 bg-gray-50 text-gray-400 opacity-60'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                }`}
                title={isDimmed ? 'Click to restore category opacity' : 'Click to dim category'}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: fill }} />
                {categoryLabel(item.category)}
                <span className="font-mono text-gray-400">{item.count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {fullscreen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/60"
            onClick={() => setFullscreen(false)}
          />
          <div className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h2 className="font-semibold text-gray-900">Circular Genome Map</h2>
              <button
                onClick={() => setFullscreen(false)}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                type="button"
                aria-label="Close fullscreen genome map"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <CircularGenomeMap
                genes={mappedGenes}
                searchTerm={searchTerm || selectedGene || ''}
                dimmedCategories={dimmedCategories}
                compact={false}
                darkMode={darkMode}
              />
            </div>
          </div>
        </>
      )}
    </>
  )
}

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600">
      <span className="font-medium text-gray-900">{value}</span>
      {label}
    </span>
  )
}
