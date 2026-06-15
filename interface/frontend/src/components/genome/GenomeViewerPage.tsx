import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { getAllGenes } from '../../api/client'
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
  const location = useLocation()
  const {
    selectedGene,
    genomeSearch,
    setGenomeSearch,
    genomeHighlight,
    setGenomeHighlight,
  } = useUrlWorkspaceState()
  const [genes, setGenes] = useState<Gene[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [darkMode, setDarkMode] = useState(true)
  const [showStats, setShowStats] = useState(true)
  const highlightedCategories = useMemo(() => new Set(genomeHighlight ?? []), [genomeHighlight])
  const mapSearchTerm = genomeSearch ?? selectedGene ?? ''
  useRegisterAssistantContext({
    context: {
      assistant_surface: 'genome',
      route: `${location.pathname}${location.search}`,
      selected_gene: selectedGene || mapSearchTerm || null,
    },
    suggestedPrompt: 'Help me interpret the genome map. Focus on the selected gene or search term, visible functional-category highlights, genomic position, and what linked Workspace or Network views would clarify next.',
  })

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setGenes([])
    getAllGenes(
      (batch) => {
        setGenes((prev) => [...prev, ...batch])
        setLoading(false)
      },
      controller.signal
    )
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

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
    const next = new Set(highlightedCategories)
    if (next.has(category)) {
      next.delete(category)
    } else {
      next.add(category)
    }
    setGenomeHighlight(Array.from(next))
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
    <div
      className={
        compact
          ? 'mx-auto flex h-full max-w-7xl min-h-0 flex-col gap-3 overflow-hidden pr-1'
          : 'mx-auto flex h-[calc(100vh-32px)] max-w-7xl min-h-0 flex-col gap-3 overflow-hidden'
      }
    >
      {!embedded && (
        <div className="flex flex-shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Genome Map</h1>
            <p className="mt-1 text-sm text-gray-500">
              Interactive E. coli K-12 chromosome - 4,727 mapped genes grouped by functional category.
            </p>
          </div>
          <div className="flex w-full items-center gap-2 lg:w-auto">
            <SearchInput
              value={genomeSearch ?? ''}
              onChange={setGenomeSearch}
              placeholder="Search genes..."
              className="flex-1 lg:w-72"
            />
            <CategoryDropdown
              categories={categorySummary}
              highlightedCategories={highlightedCategories}
              onToggle={toggleCategory}
              onShowAll={() => setGenomeHighlight([])}
            />
          </div>
        </div>
      )}

      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 text-xs">
        {!embedded && (
          <button
            onClick={() => setShowStats((value) => !value)}
            className="flex-shrink-0 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            type="button"
          >
            {showStats ? 'Hide stats' : 'Stats'}
          </button>
        )}
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
      </div>

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {showStats && !embedded && (
          <aside className="w-72 flex-shrink-0 overflow-y-auto">
            <GenomeSummaryTable
              mappedCount={mappedGenes.length}
              forwardCount={forwardCount}
              reverseCount={reverseCount}
              unmappedCount={genes.length - mappedGenes.length}
              categorySummary={categorySummary}
              onClose={() => setShowStats(false)}
            />
          </aside>
        )}

        <div className="min-h-0 flex-1">
          <CircularGenomeMap
            genes={mappedGenes}
            searchTerm={mapSearchTerm}
            highlightedCategories={highlightedCategories}
            focusGene={selectedGene}
            compact={compact}
            darkMode={darkMode}
          />
        </div>
      </div>
    </div>
  )
}

function CategoryDropdown({
  categories,
  highlightedCategories,
  onToggle,
  onShowAll,
}: {
  categories: CategorySummary[]
  highlightedCategories: Set<string>
  onToggle: (category: string) => void
  onShowAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const hasHighlightedCategories = highlightedCategories.size > 0

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 hover:border-gray-300"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
        </svg>
        Categories
        {highlightedCategories.size > 0 && (
          <span className="ml-0.5 rounded-full bg-yellow-400 px-1.5 py-0.5 text-[10px] font-medium text-gray-900">
            {highlightedCategories.size}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                {highlightedCategories.size} highlighted
              </span>
              <button
                type="button"
                onClick={onShowAll}
                className="text-[10px] text-brand-600 hover:underline"
              >
                Show all
              </button>
            </div>
            {categories.map(({ category, count }) => {
              const fill = CATEGORY_FILL[category] ?? CATEGORY_FILL.other
              const isActive = highlightedCategories.has(category)
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => onToggle(category)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-gray-50 ${
                    isActive
                      ? 'bg-yellow-50 ring-1 ring-yellow-300'
                      : hasHighlightedCategories
                        ? 'opacity-30'
                        : ''
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: fill }}
                  />
                  <span className="flex-1 truncate text-gray-700">{categoryLabel(category)}</span>
                  <span className="font-mono text-gray-400">{count}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function GenomeSummaryTable({
  mappedCount,
  forwardCount,
  reverseCount,
  unmappedCount,
  categorySummary,
  onClose,
}: {
  mappedCount: number
  forwardCount: number
  reverseCount: number
  unmappedCount: number
  categorySummary: CategorySummary[]
  onClose: () => void
}) {
  const geneDensity = (mappedCount / 4.64).toFixed(0)
  const strandTotal = forwardCount + reverseCount
  const strandBias = strandTotal > 0 ? ((forwardCount / strandTotal) * 100).toFixed(1) : '0.0'

  return (
    <div className="flex-shrink-0 rounded-lg border border-gray-200 bg-white p-3 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          Genome statistics
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          title="Hide stats"
          aria-label="Hide statistics panel"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-gray-100 pb-3">
        <Stat label="Mapped" value={mappedCount.toLocaleString()} />
        <Stat label="Forward" value={forwardCount.toLocaleString()} />
        <Stat label="Reverse" value={reverseCount.toLocaleString()} />
        <Stat label="Unmapped" value={unmappedCount.toLocaleString()} />
        <Stat label="Density" value={geneDensity + ' / Mbp'} />
        <Stat label="Fwd strand bias" value={strandBias + '%'} />
        <Stat label="Genome" value="4.64 Mbp" />
        <Stat label="GC content" value="50.8%" />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-y-1">
        {categorySummary.map(({ category, count }) => {
          const fill = CATEGORY_FILL[category] ?? CATEGORY_FILL.other
          const pct = mappedCount > 0 ? ((count / mappedCount) * 100).toFixed(1) : '0.0'
          return (
            <div key={category} className="flex items-center gap-1.5">
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: fill }} />
              <span className="flex-1 truncate text-gray-600">{categoryLabel(category)}</span>
              <span className="font-mono text-gray-400">{count}</span>
              <span className="font-mono text-gray-300">{pct}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="font-semibold text-gray-900">{value}</p>
    </div>
  )
}
