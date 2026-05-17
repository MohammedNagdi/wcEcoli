import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { compareExperiments, compareBatch, getExperiments, getBatches, createExperiment } from '../../api/client'
import type { ComparisonResponse, ComparisonExperiment, ComparisonDelta, Experiment, BatchSummary, WildtypeSuggestion } from '../../types'

// ── Helpers ───────────────────────────────────────────────────────────

function fmt(val: number | null | undefined, decimals = 1): string {
  if (val == null) return '—'
  return val.toFixed(decimals)
}

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-gray-300">—</span>
  const isPositive = pct > 0
  const isNeutral = Math.abs(pct) < 2
  const color = isNeutral
    ? 'text-gray-500 bg-gray-50'
    : isPositive
      ? 'text-amber-700 bg-amber-50'
      : 'text-blue-700 bg-blue-50'
  const arrow = isNeutral ? '~' : isPositive ? '↑' : '↓'
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${color}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

type SortKey = 'gene' | 'division_time' | 'final_mass' | 'growth_rate' | 'doubling_time'
type SortDir = 'asc' | 'desc'

// ── Experiment selector ──────────────────────────────────────────────

function ExperimentSelector({
  experiments,
  batches,
  selected,
  onSelect,
  onBatchSelect,
}: {
  experiments: Experiment[]
  batches: BatchSummary[]
  selected: Set<number>
  onSelect: (id: number) => void
  onBatchSelect: (batchId: string) => void
}) {
  const doneExperiments = experiments.filter((e) => e.status === 'done')

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Select experiments to compare</h3>

      {/* Batch shortcuts */}
      {batches.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-gray-400 mb-1.5">Quick select by batch</p>
          <div className="flex flex-wrap gap-2">
            {batches.filter((b) => b.done > 0).map((b) => (
              <button
                key={b.batch_id}
                onClick={() => onBatchSelect(b.batch_id)}
                className="text-xs px-3 py-1.5 rounded-lg border border-brand-200 bg-brand-50
                           text-brand-700 hover:bg-brand-100 transition-colors"
              >
                {b.name} ({b.done} done)
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Individual experiment checkboxes */}
      <div className="max-h-48 overflow-y-auto space-y-1">
        {doneExperiments.map((exp) => (
          <label
            key={exp.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm"
          >
            <input
              type="checkbox"
              checked={selected.has(exp.id)}
              onChange={() => onSelect(exp.id)}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="flex-1 truncate text-gray-700">{exp.name}</span>
            {exp.gene_symbol && (
              <span className="text-xs font-mono text-bio-gene">{exp.gene_symbol}</span>
            )}
            <span className="text-xs text-gray-400">{exp.condition}</span>
          </label>
        ))}
        {doneExperiments.length === 0 && (
          <p className="text-sm text-gray-400 py-4 text-center">No completed experiments to compare</p>
        )}
      </div>
    </div>
  )
}

// ── Comparison table ─────────────────────────────────────────────────

function ComparisonTable({
  data,
  sortKey,
  sortDir,
  onSort,
}: {
  data: ComparisonResponse
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const allRows = useMemo(() => {
    const rows = [...data.experiments]
    const comparator = (a: ComparisonExperiment, b: ComparisonExperiment) => {
      let av: number | null, bv: number | null
      switch (sortKey) {
        case 'gene': return sortDir === 'asc'
          ? a.gene_symbol.localeCompare(b.gene_symbol)
          : b.gene_symbol.localeCompare(a.gene_symbol)
        case 'division_time': av = a.division_time_min.mean; bv = b.division_time_min.mean; break
        case 'final_mass': av = a.final_mass_fg.mean; bv = b.final_mass_fg.mean; break
        case 'growth_rate': av = a.growth_rate.mean; bv = b.growth_rate.mean; break
        case 'doubling_time': av = a.doubling_time_min.mean; bv = b.doubling_time_min.mean; break
        default: return 0
      }
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'asc' ? av - bv : bv - av
    }
    rows.sort(comparator)
    return rows
  }, [data.experiments, sortKey, sortDir])

  const deltaMap = useMemo(() => {
    const m = new Map<number, ComparisonDelta>()
    data.deltas.forEach((d) => m.set(d.experiment_id, d))
    return m
  }, [data.deltas])

  const SortHeader = ({ label, col }: { label: string; col: SortKey }) => (
    <th
      className="text-right px-4 py-2.5 font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none"
      onClick={() => onSort(col)}
    >
      {label}
      {sortKey === col && (
        <span className="ml-1 text-brand-500">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </th>
  )

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th
              className="text-left px-4 py-2.5 font-medium text-gray-500 cursor-pointer hover:text-gray-700"
              onClick={() => onSort('gene')}
            >
              Gene {sortKey === 'gene' && <span className="text-brand-500">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </th>
            <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Condition</th>
            <th className="text-center px-4 py-2.5 font-medium text-gray-500 w-20">Seeds</th>
            <SortHeader label="Division time" col="division_time" />
            <SortHeader label="Final mass" col="final_mass" />
            <SortHeader label="Growth rate" col="growth_rate" />
            <SortHeader label="Doubling" col="doubling_time" />
            {data.wildtype && (
              <th className="text-center px-4 py-2.5 font-medium text-gray-500 w-24">vs WT</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {/* Wildtype baseline row */}
          {data.wildtype && (
            <tr className="bg-green-50/50">
              <td className="px-4 py-3">
                <span className="font-medium text-green-800">Wildtype (baseline)</span>
              </td>
              <td className="px-4 py-3 text-gray-600">{data.wildtype.condition}</td>
              <td className="px-4 py-3 text-center text-gray-600">
                {data.wildtype.divided_seeds}/{data.wildtype.completed_seeds}
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-600">
                {fmt(data.wildtype.division_time_min.mean)} min
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-600">
                {fmt(data.wildtype.final_mass_fg.mean)} fg
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-600">
                {data.wildtype.growth_rate.mean != null
                  ? (data.wildtype.growth_rate.mean * 1000).toFixed(2)
                  : '—'} ×10⁻³/s
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-600">
                {fmt(data.wildtype.doubling_time_min.mean)} min
              </td>
              <td className="px-4 py-3 text-center text-xs text-gray-400">ref</td>
            </tr>
          )}

          {/* Knockout rows */}
          {allRows.map((comp) => {
            const delta = deltaMap.get(comp.experiment_id)
            const didNotDivide = comp.divided_seeds === 0 && comp.completed_seeds > 0
            return (
              <tr key={comp.experiment_id} className={`hover:bg-gray-50 ${didNotDivide ? 'bg-red-50/30' : ''}`}>
                <td className="px-4 py-3">
                  <span className="font-mono text-brand-700 font-medium">{comp.gene_symbol || comp.experiment_name}</span>
                  {didNotDivide && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">
                      Essential
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{comp.condition}</td>
                <td className="px-4 py-3 text-center text-gray-600">
                  {comp.divided_seeds}/{comp.completed_seeds}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  {fmt(comp.division_time_min.mean)} {comp.division_time_min.mean != null && <span className="text-gray-400">min</span>}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  {fmt(comp.final_mass_fg.mean)} {comp.final_mass_fg.mean != null && <span className="text-gray-400">fg</span>}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  {comp.growth_rate.mean != null
                    ? (comp.growth_rate.mean * 1000).toFixed(2)
                    : '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  {fmt(comp.doubling_time_min.mean)} {comp.doubling_time_min.mean != null && <span className="text-gray-400">min</span>}
                </td>
                {data.wildtype && (
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-center gap-0.5">
                      {delta ? (
                        <DeltaBadge pct={delta.growth_rate_pct} />
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Bar chart (pure CSS) ─────────────────────────────────────────────

function MetricBarChart({
  experiments,
  wildtype,
  metricKey,
  title,
  unit,
  transform,
  decimals,
}: {
  experiments: ComparisonExperiment[]
  wildtype: ComparisonExperiment | null
  metricKey: 'division_time_min' | 'final_mass_fg' | 'growth_rate' | 'doubling_time_min'
  title: string
  unit: string
  transform?: (v: number) => number
  decimals?: number
}) {
  const t = transform ?? ((v: number) => v)
  const d = decimals ?? 1

  const allEntries = wildtype
    ? [wildtype, ...experiments]
    : experiments

  const values = allEntries.map((e) => {
    const m = e[metricKey]
    return m.mean != null ? t(m.mean) : null
  })

  const maxVal = Math.max(...values.filter((v): v is number => v != null), 1)

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">{title}</h4>
      <div className="space-y-2">
        {allEntries.map((entry, i) => {
          const val = values[i]
          const pct = val != null ? (val / maxVal) * 100 : 0
          const isWt = entry.is_wildtype
          return (
            <div key={entry.experiment_id} className="flex items-center gap-2">
              <span className={`text-xs w-20 truncate text-right ${isWt ? 'text-green-700 font-medium' : 'font-mono text-gray-600'}`}>
                {isWt ? 'WT' : entry.gene_symbol || `#${entry.experiment_id}`}
              </span>
              <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden relative">
                <div
                  className={`h-full rounded transition-all duration-500 ${
                    isWt ? 'bg-green-400' : val != null ? 'bg-brand-500' : 'bg-gray-200'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-gray-500 w-20 text-right">
                {val != null ? `${val.toFixed(d)} ${unit}` : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Delta summary cards ─────────────────────────────────────────────

function DeltaSummaryCards({ deltas }: { deltas: ComparisonDelta[] }) {
  if (deltas.length === 0) return null

  const metrics = [
    { key: 'division_time_pct' as const, label: 'Division time', desc: 'Slower division → growth defect' },
    { key: 'final_mass_pct' as const, label: 'Final mass', desc: 'Lower mass → impaired growth' },
    { key: 'growth_rate_pct' as const, label: 'Growth rate', desc: 'Lower rate → fitness cost' },
    { key: 'doubling_time_pct' as const, label: 'Doubling time', desc: 'Longer → slower proliferation' },
  ]

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
        Impact vs. wildtype
      </h4>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {metrics.map(({ key, label, desc }) => {
          const vals = deltas.map((d) => d[key]).filter((v): v is number => v != null)
          const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
          const max = vals.length > 0 ? Math.max(...vals.map(Math.abs)) : null
          return (
            <div key={key} className="text-center">
              <p className="text-xs text-gray-400 mb-1">{label}</p>
              <p className="text-lg font-semibold">
                <DeltaBadge pct={avg} />
              </p>
              <p className="text-[10px] text-gray-400 mt-1">
                Max: {max != null ? `${max.toFixed(1)}%` : '—'}
              </p>
              <p className="text-[10px] text-gray-300 mt-0.5">{desc}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ── Wildtype suggestion banner ───────────────────────────────────────

function WildtypeSuggestionBanner({
  suggestion,
  onCreateWildtype,
  creating,
}: {
  suggestion: WildtypeSuggestion
  onCreateWildtype: () => void
  creating: boolean
}) {
  const isInProgress = suggestion.message.includes('is queued') || suggestion.message.includes('is running') || suggestion.message.includes('is draft')

  return (
    <div className={`border rounded-lg px-4 py-3 flex items-start gap-3 ${
      isInProgress ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'
    }`}>
      <span className="text-lg mt-0.5">{isInProgress ? '⏳' : '💡'}</span>
      <div className="flex-1">
        <p className={`text-sm font-medium ${isInProgress ? 'text-amber-800' : 'text-blue-800'}`}>
          {suggestion.message}
        </p>
        {!isInProgress && (
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={onCreateWildtype}
              disabled={creating}
              className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {creating ? 'Creating…' : `Create wildtype (${suggestion.condition}, ${suggestion.recommended_seeds} seeds)`}
            </button>
            <span className="text-[11px] text-blue-500">
              variant: {suggestion.variant_type}, index: {suggestion.variant_index}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}


// ── Main page ────────────────────────────────────────────────────────

export function ComparisonDashboard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [data, setData] = useState<ComparisonResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('gene')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [creatingWt, setCreatingWt] = useState(false)

  // Load experiments and batches for the selector
  useEffect(() => {
    Promise.all([getExperiments(), getBatches()])
      .then(([exps, bats]) => {
        setExperiments(exps)
        setBatches(bats)
      })
      .catch(() => {})
  }, [])

  // Auto-load from URL params
  useEffect(() => {
    const idsParam = searchParams.get('ids')
    const batchParam = searchParams.get('batch')

    if (batchParam) {
      setLoading(true)
      compareBatch(batchParam)
        .then((resp) => {
          setData(resp)
          setSelected(new Set(resp.experiments.map((e) => e.experiment_id)))
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false))
    } else if (idsParam) {
      const ids = idsParam.split(',').map(Number).filter(Boolean)
      setSelected(new Set(ids))
      setLoading(true)
      compareExperiments(ids)
        .then(setData)
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false))
    }
  }, [])

  const handleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBatchSelect = (batchId: string) => {
    setLoading(true)
    setError(null)
    compareBatch(batchId)
      .then((resp) => {
        setData(resp)
        setSelected(new Set(resp.experiments.map((e) => e.experiment_id)))
        setSearchParams({ batch: batchId })
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  const handleCompare = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setLoading(true)
    setError(null)
    compareExperiments(ids)
      .then((resp) => {
        setData(resp)
        setSearchParams({ ids: ids.join(',') })
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  const handleCreateWildtype = async () => {
    if (!data?.wildtype_suggestion) return
    const s = data.wildtype_suggestion
    setCreatingWt(true)
    try {
      await createExperiment({
        name: `Wildtype (${s.condition})`,
        description: `Auto-created wildtype baseline for condition: ${s.condition}`,
        variant_type: s.variant_type,
        variant_index: s.variant_index,
        condition: s.condition,
        sim_params: JSON.stringify({ seeds: s.recommended_seeds, generations: 1 }),
      })
      // Refresh comparison to reflect the new pending wildtype
      const ids = [...selected]
      if (ids.length >= 2) {
        const resp = await compareExperiments(ids)
        setData(resp)
      }
    } catch (e: any) {
      setError(e.message || 'Failed to create wildtype experiment')
    } finally {
      setCreatingWt(false)
    }
  }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Compare experiments</h1>
          <p className="text-sm text-gray-400">
            Side-by-side phenotype comparison across knockouts
          </p>
        </div>
        <Link
          to="/results"
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          ← Back to results
        </Link>
      </div>

      {/* Selector */}
      <ExperimentSelector
        experiments={experiments}
        batches={batches}
        selected={selected}
        onSelect={handleSelect}
        onBatchSelect={handleBatchSelect}
      />

      {/* Compare button */}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handleCompare}
          disabled={selected.size < 2 || loading}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            selected.size < 2 || loading
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : 'bg-brand-600 hover:bg-brand-700 text-white'
          }`}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Comparing…
            </span>
          ) : (
            `Compare ${selected.size} experiment${selected.size !== 1 ? 's' : ''}`
          )}
        </button>
        {selected.size < 2 && selected.size > 0 && (
          <span className="text-xs text-gray-400">Select at least 2 experiments</span>
        )}
      </div>

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {data && data.experiments.length > 0 && (
        <div className="mt-6 space-y-6">
          {/* Wildtype suggestion when no baseline exists */}
          {!data.wildtype && data.wildtype_suggestion && (
            <WildtypeSuggestionBanner
              suggestion={data.wildtype_suggestion}
              onCreateWildtype={handleCreateWildtype}
              creating={creatingWt}
            />
          )}

          {/* Wildtype delta summary */}
          {data.wildtype && data.deltas.length > 0 && (
            <DeltaSummaryCards deltas={data.deltas} />
          )}

          {/* Comparison table */}
          <ComparisonTable data={data} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />

          {/* Bar charts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MetricBarChart
              experiments={data.experiments}
              wildtype={data.wildtype}
              metricKey="division_time_min"
              title="Division time"
              unit="min"
            />
            <MetricBarChart
              experiments={data.experiments}
              wildtype={data.wildtype}
              metricKey="final_mass_fg"
              title="Final mass"
              unit="fg"
            />
            <MetricBarChart
              experiments={data.experiments}
              wildtype={data.wildtype}
              metricKey="growth_rate"
              title="Growth rate"
              unit="×10⁻³/s"
              transform={(v) => v * 1000}
              decimals={2}
            />
            <MetricBarChart
              experiments={data.experiments}
              wildtype={data.wildtype}
              metricKey="doubling_time_min"
              title="Doubling time"
              unit="min"
            />
          </div>
        </div>
      )}
    </div>
  )
}
