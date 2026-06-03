import { useEffect, useState, useMemo } from 'react'
import { getDesignOverview, getEssentiality } from '../../api/client'
import type { DesignOverview, GeneKOSummary, EssentialityStats } from '../../types'

const PHENOTYPE_COLORS: Record<string, string> = {
  essential: 'bg-red-100 text-red-800',
  growth_defect: 'bg-amber-100 text-amber-800',
  neutral: 'bg-green-100 text-green-800',
  unknown: 'bg-gray-100 text-gray-600',
}

const PHENOTYPE_DOT: Record<string, string> = {
  essential: 'bg-red-500',
  growth_defect: 'bg-amber-500',
  neutral: 'bg-green-500',
  unknown: 'bg-gray-400',
}

type SortKey = 'gene_symbol' | 'category' | 'phenotype' | 'mean_growth_rate' | 'mean_doubling_time_min' | 'n_completed'
type SortDir = 'asc' | 'desc'

export function DesignPage() {
  const [overview, setOverview] = useState<DesignOverview | null>(null)
  const [essentiality, setEssentiality] = useState<EssentialityStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [categoryFilter, setCategoryFilter] = useState('')
  const [phenotypeFilter, setPhenotypeFilter] = useState('')
  const [searchTerm, setSearchTerm] = useState('')

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>('gene_symbol')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // View toggle
  const [view, setView] = useState<'table' | 'essentiality'>('table')

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      getDesignOverview({
        category: categoryFilter || undefined,
        phenotype: phenotypeFilter || undefined,
      }),
      getEssentiality(),
    ])
      .then(([ov, ess]) => {
        setOverview(ov)
        setEssentiality(ess)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [categoryFilter, phenotypeFilter])

  // Unique categories for filter
  const categories = useMemo(() => {
    if (!overview) return []
    const cats = new Set(overview.genes.map((g) => g.category))
    return Array.from(cats).sort()
  }, [overview])

  // Filtered + sorted genes
  const sortedGenes = useMemo(() => {
    if (!overview) return []
    let genes = overview.genes
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      genes = genes.filter((g) => g.gene_symbol.toLowerCase().includes(term))
    }
    return [...genes].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string') return av.localeCompare(bv as string) * dir
      return ((av as number) - (bv as number)) * dir
    })
  }, [overview, searchTerm, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return '↕'
    return sortDir === 'asc' ? '↑' : '↓'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
        Failed to load design data: {error}
      </div>
    )
  }

  if (!overview) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Genome Design</h1>
        <p className="text-gray-500 mt-1">
          In-silico gene knockout phenotype map — explore essentiality predictions
          from whole-cell simulation results.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Application scope</p>
        <p className="mt-1">
          This page is useful when a sufficiently broad knockout result library exists. Treat current calls as exploratory summaries until condition-rich simulation batches support a dedicated minimal-genome design workflow.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <SummaryCard label="Total genes" value={overview.total_genes} />
        <SummaryCard label="Simulated" value={overview.simulated_genes} accent="blue" />
        <SummaryCard label="Essential" value={overview.essential_genes} accent="red" />
        <SummaryCard
          label="Growth defect"
          value={overview.growth_defect_genes}
          accent="amber"
        />
        <SummaryCard label="Neutral" value={overview.neutral_genes} accent="green" />
        <SummaryCard label="Unknown" value={overview.unknown_genes} accent="gray" />
        <SummaryCard
          label="Simulated %"
          value={
            overview.total_genes > 0
              ? `${Math.round((overview.simulated_genes / overview.total_genes) * 100)}%`
              : '—'
          }
        />
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setView('table')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            view === 'table'
              ? 'bg-brand-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Gene table
        </button>
        <button
          onClick={() => setView('essentiality')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            view === 'essentiality'
              ? 'bg-brand-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Essentiality by category
        </button>
      </div>

      {view === 'table' && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search gene…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={phenotypeFilter}
              onChange={(e) => setPhenotypeFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All phenotypes</option>
              <option value="essential">Essential</option>
              <option value="growth_defect">Growth defect</option>
              <option value="neutral">Neutral</option>
              <option value="unknown">Unknown</option>
            </select>
            <span className="text-xs text-gray-500 ml-2">
              {sortedGenes.length} gene{sortedGenes.length !== 1 ? 's' : ''} shown
            </span>
          </div>

          {/* Gene table */}
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <Th onClick={() => handleSort('gene_symbol')}>
                    Gene {sortIcon('gene_symbol')}
                  </Th>
                  <Th onClick={() => handleSort('category')}>
                    Category {sortIcon('category')}
                  </Th>
                  <Th onClick={() => handleSort('phenotype')}>
                    Phenotype {sortIcon('phenotype')}
                  </Th>
                  <Th onClick={() => handleSort('n_completed')}>
                    Seeds {sortIcon('n_completed')}
                  </Th>
                  <Th onClick={() => handleSort('mean_growth_rate')}>
                    Growth rate {sortIcon('mean_growth_rate')}
                  </Th>
                  <Th onClick={() => handleSort('mean_doubling_time_min')}>
                    Doubling (min) {sortIcon('mean_doubling_time_min')}
                  </Th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">
                    Division
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedGenes.map((g) => (
                  <GeneRow key={g.gene_symbol} gene={g} />
                ))}
                {sortedGenes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-400">
                      No genes match filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'essentiality' && (
        <EssentialityView data={essentiality} />
      )}
    </div>
  )
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string
  value: number | string
  accent?: string
}) {
  const ring = accent ? `ring-1 ring-${accent}-200` : 'ring-1 ring-gray-200'
  return (
    <div className={`rounded-lg p-3 bg-white ${ring}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
    </div>
  )
}

function Th({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick?: () => void
}) {
  return (
    <th
      onClick={onClick}
      className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100 whitespace-nowrap"
    >
      {children}
    </th>
  )
}

function GeneRow({ gene: g }: { gene: GeneKOSummary }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-2 font-mono font-medium text-brand-700">
        {g.gene_symbol}
      </td>
      <td className="px-3 py-2 text-gray-600 max-w-[180px] truncate" title={g.category}>
        {g.category}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${PHENOTYPE_COLORS[g.phenotype]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${PHENOTYPE_DOT[g.phenotype]}`} />
          {g.phenotype === 'growth_defect' ? 'growth defect' : g.phenotype}
        </span>
      </td>
      <td className="px-3 py-2 text-gray-600 tabular-nums">
        {g.n_completed > 0 ? g.division_rate : '—'}
      </td>
      <td className="px-3 py-2 text-gray-600 tabular-nums">
        {g.mean_growth_rate != null ? g.mean_growth_rate.toFixed(6) : '—'}
      </td>
      <td className="px-3 py-2 text-gray-600 tabular-nums">
        {g.mean_doubling_time_min != null ? g.mean_doubling_time_min.toFixed(1) : '—'}
      </td>
      <td className="px-3 py-2 text-gray-600">
        {g.divided === true && '✓'}
        {g.divided === false && '✗'}
        {g.divided == null && '—'}
      </td>
    </tr>
  )
}

function EssentialityView({ data }: { data: EssentialityStats[] }) {
  if (data.length === 0) {
    return (
      <div className="text-gray-400 text-center py-8">
        No essentiality data available.
      </div>
    )
  }

  const maxTotal = Math.max(...data.map((d) => d.total))

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Gene essentiality breakdown by functional category. Bar width = proportion of
        category total.
      </p>
      <div className="space-y-2">
        {data.map((cat) => (
          <div key={cat.category} className="flex items-center gap-3">
            <div className="w-48 text-sm text-gray-700 truncate text-right" title={cat.category}>
              {cat.category}
            </div>
            <div className="flex-1 flex items-center gap-0.5 h-6">
              <Bar
                width={(cat.essential / maxTotal) * 100}
                color="bg-red-400"
                label={`${cat.essential} essential`}
              />
              <Bar
                width={(cat.growth_defect / maxTotal) * 100}
                color="bg-amber-400"
                label={`${cat.growth_defect} growth defect`}
              />
              <Bar
                width={(cat.neutral / maxTotal) * 100}
                color="bg-green-400"
                label={`${cat.neutral} neutral`}
              />
              <Bar
                width={(cat.unknown / maxTotal) * 100}
                color="bg-gray-300"
                label={`${cat.unknown} unknown`}
              />
            </div>
            <div className="w-20 text-xs text-gray-500 tabular-nums">
              {cat.essential_pct}% essential
            </div>
            <div className="w-10 text-xs text-gray-400 tabular-nums text-right">
              n={cat.total}
            </div>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 mt-4">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-red-400" /> Essential
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-400" /> Growth defect
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-green-400" /> Neutral
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-gray-300" /> Unknown
        </span>
      </div>
    </div>
  )
}

function Bar({
  width,
  color,
  label,
}: {
  width: number
  color: string
  label: string
}) {
  if (width === 0) return null
  return (
    <div
      className={`${color} h-full rounded-sm`}
      style={{ width: `${Math.max(width, 0.5)}%` }}
      title={label}
    />
  )
}
