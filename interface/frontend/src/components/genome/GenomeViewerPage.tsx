import { useEffect, useMemo, useState } from 'react'
import { getGenes } from '../../api/client'
import type { Gene } from '../../types'
import { CATEGORY_FILL, hasGenomePosition } from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'
import { SearchInput } from '../common/SearchInput'
import { SkeletonLine } from '../common/Skeleton'
import { CircularGenomeMap } from './CircularGenomeMap'

interface CategorySummary {
  category: string
  count: number
}

export function GenomeViewerPage() {
  const [genes, setGenes] = useState<Gene[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [dimmedCategories, setDimmedCategories] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    setError(null)
    getGenes({ page_size: 5000 })
      .then((data) => setGenes(data.genes))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
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
    setDimmedCategories((current) => {
      const next = new Set(current)
      if (next.has(category)) {
        next.delete(category)
      } else {
        next.add(category)
      }
      return next
    })
  }

  if (loading) {
    return (
      <div className="space-y-5">
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
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
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

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatBadge label="Mapped" value={mappedGenes.length.toLocaleString()} />
        <StatBadge label="Forward" value={forwardCount.toLocaleString()} />
        <StatBadge label="Reverse" value={reverseCount.toLocaleString()} />
        <StatBadge label="Unmapped" value={(genes.length - mappedGenes.length).toLocaleString()} />
      </div>

      <CircularGenomeMap
        genes={mappedGenes}
        searchTerm={searchTerm}
        dimmedCategories={dimmedCategories}
      />

      <div className="flex flex-wrap gap-2">
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
